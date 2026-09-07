import { createRobinhoodClient } from "./client.js";
import { createHistoricalClient, loadHistoryConfig } from "./history/client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { loadPoolManifest } from "./indexer/manifest.js";
import { validatePoolManifest } from "./indexer/validate.js";
import { log } from "./logger.js";
import { loadReplayConfig } from "./replay/config.js";
import { loadRiskConfig } from "./risk/config.js";
import { ViemRiskChainReader } from "./risk/reader.js";
import { collectRiskSnapshot } from "./risk/runner.js";
import { collectAndSaveRiskSnapshot, PostgresRiskStore } from "./risk/store.js";
import { collectStrategyCheckpoint } from "./strategy-checkpoint/collector.js";
import { loadStrategyCheckpointConfig } from "./strategy-checkpoint/config.js";
import { ViemStrategyCheckpointReader } from "./strategy-checkpoint/reader.js";
import { PostgresStrategyCheckpointStore } from "./strategy-checkpoint/store.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import {
  PostgresRpcHealthGate,
  RpcHealthCircuitOpenError,
} from "./rpc-health/store.js";
import { loadTailConfig } from "./tail/config.js";
import { PostgresTailLock } from "./tail/lock.js";
import { calculateSafeHead, runTail, waitForDelay } from "./tail/runner.js";

interface CliOptions {
  readonly help: boolean;
  readonly maxCycles?: number;
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let help = false;
  let maxCycles: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--max-cycles": {
        const value = Number(requireValue(arguments_, index, argument));
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--max-cycles must be a positive integer");
        }
        maxCycles = value;
        index += 1;
        break;
      }
      case "--once":
        maxCycles = 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help, maxCycles };
}

function printHelp(): void {
  console.log(`Usage: npm run tail -- [options]

Options:
  --once                Run one confirmation-safe index/replay cycle
  --max-cycles NUMBER   Stop after this many successful cycles
  -h, --help            Show this help

Environment:
  DATABASE_URL                    Required PostgreSQL database
  RH_INDEXER_RPC_URL              Live node; HISTORY_SOURCE=hypersync isolates history
  INDEXER_CONFIRMATION_DEPTH      Blocks withheld from the index tip
  TAIL_POLL_INTERVAL_MS           Successful-cycle cadence (default 10000)
  TAIL_ERROR_DELAY_MS             Initial retry delay (default 5000)
  TAIL_MAX_CONSECUTIVE_FAILURES   Exit after this many failures (default 5)
  RISK_SNAPSHOT_INTERVAL_MS       Risk-source cadence (default 60000)
  STRATEGY_CHECKPOINT_ENABLED     Attach lightweight pool marks (default false)
  STRATEGY_CHECKPOINT_CONCURRENCY Concurrent pool readers (default 4)
  RISK_MAX_PRICE_AGE_SECONDS      Strict price age ceiling (default 300)
  ROBINHOOD_MARKET_POLICY_URL     Official Stock Tokens market policy
  RISK_GATE_MAX_CANONICALITY_AGE_SECONDS  Gate-only validation age (default 30)
  RPC_HEALTH_GATE_ENABLED              Require healthy quorum state (default true)
  RPC_HEALTH_MAX_SAMPLE_AGE_SECONDS    Fail-closed sample age (default 30)
`);
}

async function waitForHealthyRpc(input: {
  readonly gate: PostgresRpcHealthGate;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  while (!input.signal.aborted) {
    try {
      const status = await input.gate.assertBulkAllowed();
      log("info", "tail_rpc_health_ready", {
        lagBlocks: status?.lagBlocks ?? null,
        sampleId: status?.sampleId ?? null,
      });
      return true;
    } catch (error) {
      if (!(error instanceof RpcHealthCircuitOpenError)) throw error;
      log("warn", "tail_rpc_health_waiting", {
        lagBlocks: error.status?.lagBlocks ?? null,
        lagSeconds: error.status?.lagSeconds ?? null,
        reasons: error.status?.reasons ?? [error.message],
        state: error.status?.state ?? "unavailable",
      });
      await waitForDelay(input.pollIntervalMs, input.signal);
    }
  }
  return false;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  const indexerConfig = loadIndexerConfig();
  const replayConfig = loadReplayConfig();
  const riskConfig = loadRiskConfig();
  const strategyConfig = loadStrategyCheckpointConfig();
  const tailConfig = loadTailConfig();
  const rpcHealthConfig = loadRpcHealthGateConfig();
  const manifest = await loadPoolManifest(indexerConfig.poolsPath);
  const rpcHealthGate = new PostgresRpcHealthGate({
    cacheMs: rpcHealthConfig.cacheMs,
    connectionString: databaseUrl,
    enabled: rpcHealthConfig.enabled,
    maxSampleAgeSeconds: rpcHealthConfig.maxSampleAgeSeconds,
  });
  const client = createRobinhoodClient(
    indexerConfig.rpcUrl,
    indexerConfig.rpcTimeoutMs,
    {
      beforeRequest: () => rpcHealthGate.assertBulkAllowed().then(() => {}),
      retryCount: 0,
    },
  );
  const riskReader = new ViemRiskChainReader(client);
  const historyConfig = loadHistoryConfig(indexerConfig.rpcUrl);
  const historyClient = historyConfig.source !== "legacy"
    ? createHistoricalClient(indexerConfig.rpcUrl, indexerConfig.rpcTimeoutMs)
    : undefined;
  log("info", "tail_historical_source", {
    source: historyConfig.source, archiveStateAvailable: Boolean(historyConfig.archiveUrl),
  });
  const strategyReader = new ViemStrategyCheckpointReader(client);

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    log("info", "tail_stop_requested", { signal });
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const lock = new PostgresTailLock(databaseUrl);
  const riskStore = new PostgresRiskStore(databaseUrl);
  const strategyStore = strategyConfig.enabled
    ? new PostgresStrategyCheckpointStore(databaseUrl)
    : null;
  try {
    await rpcHealthGate.assertReady();
    await riskStore.assertReady();
    await strategyStore?.assertReady();
    const ready = await waitForHealthyRpc({
      gate: rpcHealthGate,
      pollIntervalMs: tailConfig.pollIntervalMs,
      signal: controller.signal,
    });
    if (!ready) return;
    await rpcHealthGate.assertBulkAllowed();
    const head = await client.getBlockNumber();
    const safeHead = calculateSafeHead(head, indexerConfig.confirmationDepth);
    await validatePoolManifest(
      client,
      manifest,
      safeHead,
      () => rpcHealthGate.assertBulkAllowed().then(() => {}),
      historyClient,
    );
    log("info", "tail_manifest_verified", {
      poolCount: manifest.pools.length,
      safeHead,
      targetSetHash: manifest.targetSetHash,
    });
    await lock.acquire(indexerConfig.streamKey);
    await runTail({
      client,
      historyClient,
      databaseUrl,
      indexerConfig,
      manifest,
      options: { maxCycles: options.maxCycles, signal: controller.signal },
      replayConfig,
      rpcHealthGate,
      riskCanonicalityValidator: () => riskStore.validateLatestCanonical(
        (requestedBlock) => riskReader.getBlock(requestedBlock),
      ),
      riskSnapshotter: async (blockNumber) => collectAndSaveRiskSnapshot({
        blockNumber,
        collect: () => collectRiskSnapshot({
          blockNumber,
          config: riskConfig,
          reader: riskReader,
        }),
        store: riskStore,
      }),
      strategyCheckpointter: strategyStore === null
        ? undefined
        : async (risk) => {
          const checkpoint = await collectStrategyCheckpoint({
            concurrency: strategyConfig.concurrency,
            manifest,
            reader: strategyReader,
            risk,
            streamKey: indexerConfig.streamKey,
          });
          const saved = await strategyStore.save(checkpoint);
          log("info", saved.created
            ? "tail_strategy_checkpoint_saved"
            : "tail_strategy_checkpoint_already_exists", {
            blockNumber: checkpoint.blockNumber,
            checkpointRunId: saved.checkpointRunId,
            excludedPools: checkpoint.excludedPools,
            validPools: checkpoint.validPools,
          });
        },
      tailConfig,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lock.close();
    await rpcHealthGate.close();
    await riskStore.close();
    await strategyStore?.close();
  }
}

main().catch((error: unknown) => {
  log("error", "tail_failed", { error });
  process.exitCode = 1;
});
