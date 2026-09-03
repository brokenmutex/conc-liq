import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { loadReplayConfig } from "./replay/config.js";
import { runReplay } from "./replay/runner.js";
import { PostgresReplayStore } from "./replay/store.js";

interface CliOptions {
  readonly batchSize?: number;
  readonly help: boolean;
  readonly maxBatches?: number;
  readonly rebuild: boolean;
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let batchSize: number | undefined;
  let help = false;
  let maxBatches: number | undefined;
  let rebuild = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--batch-size":
        batchSize = positiveInteger(requireValue(arguments_, index, argument), argument);
        index += 1;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--max-batches":
        maxBatches = positiveInteger(requireValue(arguments_, index, argument), argument);
        index += 1;
        break;
      case "--rebuild":
        rebuild = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { batchSize, help, maxBatches, rebuild };
}

function printHelp(): void {
  console.log(`Usage: npm run replay -- [options]

Options:
  --rebuild              Delete and deterministically rebuild derived v3 state
  --batch-size NUMBER    Source events committed per atomic replay batch
  --max-batches NUMBER   Bound work to exercise checkpoint/resume behavior
  -h, --help              Show this help

Environment:
  DATABASE_URL           Required PostgreSQL source and derived-state database
  INDEXER_STREAM_KEY     Indexed event stream to replay
  REPLAY_BATCH_SIZE      Default batch size (25000)
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
  const batchSize = options.batchSize ?? replayConfig.batchSize;
  if (batchSize > 100_000) {
    throw new Error("--batch-size cannot exceed 100000");
  }

  const store = new PostgresReplayStore(databaseUrl);
  try {
    await store.open(indexerConfig.streamKey);
    const result = await runReplay(store, indexerConfig.streamKey, {
      batchSize,
      maxBatches: options.maxBatches,
      rebuild: options.rebuild,
    });
    log("info", "replay_run_complete", { ...result });
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "replay_failed", { error });
  process.exitCode = 1;
});
