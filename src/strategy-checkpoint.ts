import { z } from "zod";
import { createRobinhoodClient } from "./client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { loadPoolManifest } from "./indexer/manifest.js";
import { log } from "./logger.js";
import { loadRiskConfig } from "./risk/config.js";
import { ViemRiskChainReader } from "./risk/reader.js";
import { collectRiskSnapshot } from "./risk/runner.js";
import {
  collectAndSaveRiskSnapshot,
  PostgresRiskStore,
} from "./risk/store.js";
import { collectStrategyCheckpoint } from "./strategy-checkpoint/collector.js";
import { loadStrategyCheckpointConfig } from "./strategy-checkpoint/config.js";
import { ViemStrategyCheckpointReader } from "./strategy-checkpoint/reader.js";
import { PostgresStrategyCheckpointStore } from "./strategy-checkpoint/store.js";
import { calculateSafeHead } from "./tail/runner.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";
import { selectStrategyCheckpointManifest } from "./strategy-checkpoint/select.js";

const environmentSchema = z.object({ DATABASE_URL: z.string().min(1) });

interface CliOptions {
  readonly blockNumber?: bigint;
  readonly fee?: number;
  readonly help: boolean;
  readonly rwaSymbol?: string;
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let blockNumber: bigint | undefined;
  let fee: number | undefined;
  let help = false;
  let rwaSymbol: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--block": {
        const value = requireValue(arguments_, index, argument);
        if (!/^\d+$/u.test(value)) {
          throw new Error("--block must be a nonnegative integer");
        }
        blockNumber = BigInt(value);
        index += 1;
        break;
      }
      case "--rwa": {
        if (rwaSymbol !== undefined) throw new Error("--rwa supplied twice");
        rwaSymbol = requireValue(arguments_, index, argument).toUpperCase();
        if (!/^[A-Z0-9]{1,16}$/u.test(rwaSymbol)) {
          throw new Error("--rwa requires a canonical symbol");
        }
        index += 1;
        break;
      }
      case "--fee": {
        if (fee !== undefined) throw new Error("--fee supplied twice");
        const value = requireValue(arguments_, index, argument);
        if (!/^[1-9]\d*$/u.test(value)) {
          throw new Error("--fee requires a positive integer");
        }
        fee = Number(value);
        if (!Number.isSafeInteger(fee) || fee > 1_000_000) {
          throw new Error("--fee is outside the V3 fee domain");
        }
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if ((rwaSymbol === undefined) !== (fee === undefined)) {
    throw new Error("--rwa and --fee must be supplied together");
  }
  return { blockNumber, fee, help, rwaSymbol };
}

function printHelp(): void {
  console.log(`Usage: npm run strategy:checkpoint -- [options]

Capture a lightweight pool and oracle checkpoint at one confirmation-safe block.
This stores one risk snapshot plus exact slot0, liquidity, and global fee growth
for every manifest pool; it does not read ticks or positions.

Options:
  --block NUMBER   Pin reads to an explicit block (default: confirmation-safe head)
  --rwa SYMBOL     Limit collection to one RWA (requires --fee)
  --fee PIPS       Limit collection to one fee-tier pool (requires --rwa)
  -h, --help       Show this help

Environment:
  DATABASE_URL                         Required PostgreSQL database
  RH_INDEXER_RPC_URL                   Private read RPC; falls back to RH_RPC_URL
  STRATEGY_CHECKPOINT_CONCURRENCY      Concurrent pool readers (default 4)
  RISK_MAX_PRICE_AGE_SECONDS           Strict oracle freshness ceiling
  RPC_HEALTH_GATE_ENABLED              Require healthy quorum state (default true)
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const indexer = loadIndexerConfig();
  const riskConfig = loadRiskConfig();
  const strategyConfig = loadStrategyCheckpointConfig();
  const fullManifest = await loadPoolManifest(indexer.poolsPath);
  const manifest = selectStrategyCheckpointManifest({
    fee: options.fee,
    manifest: fullManifest,
    rwaSymbol: options.rwaSymbol,
  });
  const selectedRiskConfig = options.rwaSymbol === undefined
    ? riskConfig
    : { ...riskConfig, symbols: [options.rwaSymbol] };
  const gateConfig = loadRpcHealthGateConfig();
  const gate = new PostgresRpcHealthGate({
    cacheMs: gateConfig.cacheMs,
    connectionString: environment.DATABASE_URL,
    enabled: gateConfig.enabled,
    maxSampleAgeSeconds: gateConfig.maxSampleAgeSeconds,
  });
  const client = createRobinhoodClient(indexer.rpcUrl, indexer.rpcTimeoutMs, {
    beforeRequest: async () => { await gate.assertBulkAllowed(); },
    retryCount: 0,
  });
  const riskReader = new ViemRiskChainReader(client);
  const strategyReader = new ViemStrategyCheckpointReader(client);
  const riskStore = new PostgresRiskStore(environment.DATABASE_URL);
  const strategyStore = new PostgresStrategyCheckpointStore(
    environment.DATABASE_URL,
  );
  try {
    await Promise.all([gate.migrate(), riskStore.migrate(), strategyStore.migrate()]);
    await gate.assertBulkAllowed();
    const blockNumber = options.blockNumber ?? calculateSafeHead(
      await client.getBlockNumber(),
      indexer.confirmationDepth,
    );
    const risk = await collectAndSaveRiskSnapshot({
      blockNumber,
      collect: () => collectRiskSnapshot({
        blockNumber,
        config: selectedRiskConfig,
        reader: riskReader,
      }),
      store: riskStore,
    });
    const checkpoint = await collectStrategyCheckpoint({
      concurrency: strategyConfig.concurrency,
      manifest,
      reader: strategyReader,
      risk,
      streamKey: indexer.streamKey,
    });
    const saved = await strategyStore.save(checkpoint);
    const canonicality = await riskStore.validateRunCanonical(
      saved.riskRunId,
      (requestedBlock) => riskReader.getBlock(requestedBlock),
    );
    log("info", saved.created
      ? "strategy_checkpoint_saved"
      : "strategy_checkpoint_already_exists", {
      blockNumber: checkpoint.blockNumber,
      canonicality,
      checkpointRunId: saved.checkpointRunId,
      excludedPools: checkpoint.excludedPools,
      poolCount: checkpoint.pools.length,
      validPools: checkpoint.validPools,
    });
    console.log(JSON.stringify(checkpoint, null, 2));
  } finally {
    await Promise.all([gate.close(), riskStore.close(), strategyStore.close()]);
  }
}

main().catch((error: unknown) => {
  log("error", "strategy_checkpoint_failed", { error });
  process.exitCode = 1;
});
