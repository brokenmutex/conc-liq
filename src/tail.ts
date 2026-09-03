import { createRobinhoodClient } from "./client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { loadPoolManifest } from "./indexer/manifest.js";
import { validatePoolManifest } from "./indexer/validate.js";
import { log } from "./logger.js";
import { loadReplayConfig } from "./replay/config.js";
import { loadRiskConfig } from "./risk/config.js";
import { ViemRiskChainReader } from "./risk/reader.js";
import { collectRiskSnapshot } from "./risk/runner.js";
import { collectAndSaveRiskSnapshot, PostgresRiskStore } from "./risk/store.js";
import { loadTailConfig } from "./tail/config.js";
import { PostgresTailLock } from "./tail/lock.js";
import { calculateSafeHead, runTail } from "./tail/runner.js";

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
  RH_INDEXER_RPC_URL              Private read RPC; falls back to RH_RPC_URL
  INDEXER_CONFIRMATION_DEPTH      Blocks withheld from the index tip
  TAIL_POLL_INTERVAL_MS           Successful-cycle cadence (default 10000)
  TAIL_ERROR_DELAY_MS             Initial retry delay (default 5000)
  TAIL_MAX_CONSECUTIVE_FAILURES   Exit after this many failures (default 5)
  RISK_SNAPSHOT_INTERVAL_MS       Risk-source cadence (default 60000)
  RISK_MAX_PRICE_AGE_SECONDS      Strict price age ceiling (default 300)
  ROBINHOOD_MARKET_POLICY_URL     Official Stock Tokens market policy
`);
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
  const tailConfig = loadTailConfig();
  const manifest = await loadPoolManifest(indexerConfig.poolsPath);
  const client = createRobinhoodClient(indexerConfig.rpcUrl, indexerConfig.rpcTimeoutMs);
  const riskReader = new ViemRiskChainReader(client);
  const head = await client.getBlockNumber();
  const safeHead = calculateSafeHead(head, indexerConfig.confirmationDepth);
  await validatePoolManifest(client, manifest, safeHead);
  log("info", "tail_manifest_verified", {
    poolCount: manifest.pools.length,
    safeHead,
    targetSetHash: manifest.targetSetHash,
  });

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    log("info", "tail_stop_requested", { signal });
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const lock = new PostgresTailLock(databaseUrl);
  const riskStore = new PostgresRiskStore(databaseUrl);
  try {
    await riskStore.migrate();
    await lock.acquire(indexerConfig.streamKey);
    await runTail({
      client,
      databaseUrl,
      indexerConfig,
      manifest,
      options: { maxCycles: options.maxCycles, signal: controller.signal },
      replayConfig,
      riskSnapshotter: async (blockNumber) => collectAndSaveRiskSnapshot({
        blockNumber,
        collect: () => collectRiskSnapshot({
          blockNumber,
          config: riskConfig,
          reader: riskReader,
        }),
        store: riskStore,
      }),
      tailConfig,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lock.close();
    await riskStore.close();
  }
}

main().catch((error: unknown) => {
  log("error", "tail_failed", { error });
  process.exitCode = 1;
});
