import { isAddressEqual } from "viem";
import { createRobinhoodClient } from "./client.js";
import {
  loadGuardedCanaryConfig,
  parseGuardedCanaryCli,
} from "./canary-plan/config.js";
import {
  buildGuardedCanaryDraft,
  finalizeGuardedCanaryPlan,
} from "./canary-plan/evaluate.js";
import { ViemGuardedCanaryReader } from "./canary-plan/reader.js";
import { PostgresGuardedCanaryPlanStore } from "./canary-plan/store.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { loadPoolManifest } from "./indexer/manifest.js";
import { log } from "./logger.js";
import { sanitizeRiskError } from "./risk/evaluate.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import {
  PostgresRpcHealthGate,
  RpcHealthCircuitOpenError,
} from "./rpc-health/store.js";

function printHelp(): void {
  console.log(`Usage: npm run canary:plan -- [required options]

Builds and stores a signer-free, non-broadcasting preflight for the one
canonical NVDA/USDG 0.05% Uniswap V3 pool. Every policy choice is explicit;
there are no live sizing, width, slippage, or risk defaults.

Required:
  --operator ADDRESS                  Token owner and NFT recipient
  --budget-usdg AMOUNT                Desired quote-value budget (6 decimals)
  --budget-cap-usdg AMOUNT            Independent hard cap; budget must not exceed it
  --half-width-spacings COUNT         Centered range half-width in 10-tick spacings
  --slippage-bps BPS                  Token minimum haircut, 1..500
  --max-oracle-deviation-ppm PPM      Maximum absolute pool/oracle deviation, 0..100000
  --max-liquidity-share-ppm PPM       Maximum candidate/pool liquidity, 1..1000000
  --ttl-seconds SECONDS               Deadline offset from pinned block, 60..1800

Environment:
  DATABASE_URL                        Required PostgreSQL database
  RH_INDEXER_RPC_URL                  Private Robinhood RPC
  RPC_HEALTH_GATE_ENABLED             Must remain true
  CANARY_MAX_CHECKPOINT_AGE_SECONDS   Freshness ceiling (default 180)

Safety boundary:
  This command has no private-key input, never signs, never sends a transaction,
  and always persists execution_eligible=false and broadcast_authorized=false.
`);
}

async function main(): Promise<void> {
  const options = parseGuardedCanaryCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (
    options.operator === undefined || options.budgetQuote === undefined ||
    options.budgetCapQuote === undefined || options.halfWidthSpacings === undefined ||
    options.slippageBps === undefined || options.maxOracleDeviationPpm === undefined ||
    options.maxLiquiditySharePpm === undefined || options.ttlSeconds === undefined
  ) {
    throw new Error("All guarded canary policy options are required; use --help");
  }
  const config = loadGuardedCanaryConfig();
  const indexer = loadIndexerConfig();
  const rpcGateConfig = loadRpcHealthGateConfig();
  if (!rpcGateConfig.enabled) {
    throw new Error("Guarded canary preflight requires RPC_HEALTH_GATE_ENABLED=true");
  }
  const store = new PostgresGuardedCanaryPlanStore(config.databaseUrl);
  const rpcGate = new PostgresRpcHealthGate({
    cacheMs: rpcGateConfig.cacheMs,
    connectionString: config.databaseUrl,
    enabled: true,
    maxSampleAgeSeconds: rpcGateConfig.maxSampleAgeSeconds,
  });
  try {
    await store.migrate();
    const [source, manifest, riskGate, rpcHealth] = await Promise.all([
      store.loadLatestSource({ fee: 500, rwaSymbol: "NVDA", streamKey: config.streamKey }),
      loadPoolManifest(indexer.poolsPath),
      store.readRiskGate({
        maxCanonicalityAgeSeconds: config.maxRiskCanonicalityAgeSeconds,
        maxSnapshotAgeSeconds: config.maxRiskSnapshotAgeSeconds,
        streamKey: config.streamKey,
      }),
      rpcGate.assertBulkAllowed(),
    ]);
    if (rpcHealth === null) throw new Error("RPC health evidence is required");
    const targets = manifest.pools.filter((pool) =>
      pool.rwaSymbol === "NVDA" && pool.fee === 500
    );
    if (targets.length !== 1) {
      throw new Error(`Expected one manifest NVDA/500 pool, found ${targets.length}`);
    }
    const target = targets[0]!;
    if (
      !isAddressEqual(target.address, source.poolAddress) ||
      !isAddressEqual(target.rwaAddress, source.rwaAddress) ||
      source.targetSetHash.toLowerCase() !== manifest.targetSetHash.toLowerCase()
    ) {
      throw new Error("Latest canary checkpoint disagrees with the canonical pool manifest");
    }
    const client = createRobinhoodClient(indexer.rpcUrl, indexer.rpcTimeoutMs, {
      beforeRequest: async () => { await rpcGate.assertBulkAllowed(); },
      retryCount: 0,
    });
    const reader = new ViemGuardedCanaryReader(client);
    const chain = await reader.readState({ operator: options.operator, source });
    const draft = buildGuardedCanaryDraft({
      chain,
      createdAt: new Date().toISOString(),
      maxCheckpointAgeSeconds: config.maxCheckpointAgeSeconds,
      operator: options.operator,
      policy: {
        budgetCapQuote: options.budgetCapQuote,
        budgetQuote: options.budgetQuote,
        halfWidthSpacings: options.halfWidthSpacings,
        maxLiquiditySharePpm: options.maxLiquiditySharePpm,
        maxOracleDeviationPpm: options.maxOracleDeviationPpm,
        slippageBps: options.slippageBps,
        ttlSeconds: options.ttlSeconds,
      },
      riskGate,
      rpcHealth,
      source,
    });
    const [simulation, gasEstimate] = await Promise.all([
      reader.simulate({
        blockNumber: source.blockNumber,
        calldata: draft.transaction.calldata,
        operator: options.operator,
      }),
      reader.estimateGas({
        blockNumber: source.blockNumber,
        calldata: draft.transaction.calldata,
        operator: options.operator,
      }),
    ]);
    const plan = finalizeGuardedCanaryPlan({ draft, gasEstimate, simulation });
    const planRunId = await store.save(plan);
    log(plan.manualApprovalCandidate ? "info" : "warn", "guarded_canary_plan_saved", {
      approvalHash: plan.approvalHash,
      broadcastAuthorized: false,
      planRunId,
      reasons: plan.preflightReasons,
      status: plan.status,
    });
    console.log(JSON.stringify({ planRunId, ...plan }, null, 2));
  } catch (error) {
    if (error instanceof RpcHealthCircuitOpenError) {
      log("warn", "guarded_canary_rpc_circuit_open", {
        error: error.message,
        status: error.status,
      });
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await Promise.all([store.close(), rpcGate.close()]);
  }
}

main().catch((error: unknown) => {
  log("error", "guarded_canary_plan_failed", { error: sanitizeRiskError(error) });
  process.exitCode = 1;
});
