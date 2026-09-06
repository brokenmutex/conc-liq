import { createRobinhoodClient } from "./client.js";
import { createHistoricalClient, loadHistoryConfig } from "./history/client.js";
import { PostgresTailLock } from "./tail/lock.js";
import { log } from "./logger.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { earliestCreationBlock, loadPoolManifest } from "./indexer/manifest.js";
import { runBackfill } from "./indexer/runner.js";
import { PostgresEventStore } from "./indexer/store.js";
import { validatePoolManifest } from "./indexer/validate.js";

interface CliOptions {
  readonly dryRun: boolean;
  readonly fromBlock?: bigint;
  readonly help: boolean;
  readonly maxChunks?: number;
  readonly toBlock?: bigint;
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseNonnegativeBigInt(value: string, flag: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a nonnegative integer`);
  }
  return BigInt(value);
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let dryRun = false;
  let fromBlock: bigint | undefined;
  let help = false;
  let maxChunks: number | undefined;
  let toBlock: bigint | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--from-block":
        fromBlock = parseNonnegativeBigInt(
          requireValue(arguments_, index, argument),
          argument,
        );
        index += 1;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--max-chunks": {
        const raw = requireValue(arguments_, index, argument);
        maxChunks = Number(raw);
        if (!Number.isInteger(maxChunks) || maxChunks <= 0) {
          throw new Error("--max-chunks must be a positive integer");
        }
        index += 1;
        break;
      }
      case "--to-block":
        toBlock = parseNonnegativeBigInt(
          requireValue(arguments_, index, argument),
          argument,
        );
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { dryRun, fromBlock, help, maxChunks, toBlock };
}

function printHelp(): void {
  console.log(`Usage: npm run backfill -- [options]

Options:
  --dry-run             Read and decode logs without PostgreSQL writes
  --from-block NUMBER   Start or intentionally rewind at this L2 block
  --to-block NUMBER     Stop at this confirmed L2 block
  --max-chunks NUMBER   Bound work for smoke tests or scheduled batches
  -h, --help            Show this help

Environment:
  DATABASE_URL          Required unless --dry-run is used
  RH_INDEXER_RPC_URL    Live validation RPC; HISTORY_SOURCE=hypersync isolates history
  INDEXER_POOLS_PATH    Verified pool target manifest
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = loadIndexerConfig();
  const manifest = await loadPoolManifest(config.poolsPath);
  const client = createRobinhoodClient(config.rpcUrl, config.rpcTimeoutMs);
  const isolated = loadHistoryConfig(config.rpcUrl).source !== "legacy";
  const historyClient = isolated ? createHistoricalClient(config.rpcUrl, config.rpcTimeoutMs) : client;
  const head = await client.getBlockNumber();
  const confirmationDepth = BigInt(config.confirmationDepth);
  if (head < confirmationDepth) {
    throw new Error(`Head ${head} is below confirmation depth ${confirmationDepth}`);
  }
  const safeHead = head - confirmationDepth;
  const toBlock = options.toBlock ?? safeHead;
  if (toBlock > safeHead) {
    throw new Error(`--to-block ${toBlock} exceeds confirmed head ${safeHead}`);
  }

  await validatePoolManifest(client, manifest, safeHead, undefined, historyClient);
  log("info", "indexer_manifest_verified", {
    earliestCreationBlock: earliestCreationBlock(manifest),
    poolCount: manifest.pools.length,
    safeHead,
    sourceSnapshotBlock: manifest.source.snapshotBlock,
    targetSetHash: manifest.targetSetHash,
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (!options.dryRun && (databaseUrl === undefined || databaseUrl.length === 0)) {
    throw new Error("DATABASE_URL is required unless --dry-run is used");
  }
  const store = options.dryRun ? undefined : new PostgresEventStore(databaseUrl!);
  const lock = options.dryRun ? undefined : new PostgresTailLock(databaseUrl!);
  try {
    await lock?.acquire(config.streamKey);
    const result = await runBackfill(
      historyClient,
      manifest,
      config,
      {
        dryRun: options.dryRun,
        liveClient: isolated ? client : undefined,
        explicitFromBlock: options.fromBlock,
        maxChunks: options.maxChunks,
        toBlock,
      },
      store,
    );
    log("info", "indexer_run_complete", { ...result });
  } finally {
    await store?.close();
    await lock?.close();
  }
}

main().catch((error: unknown) => {
  log("error", "indexer_failed", { error });
  process.exitCode = 1;
});
