import { z } from "zod";
import { buildStableFeeBaseline } from "./backtest/baseline.js";
import { validateBaselineSource } from "./backtest/canonical.js";
import type { BaselineSourceInput } from "./backtest/canonical.js";
import {
  InsufficientAccountingRunsError,
  PostgresStableFeeBaselineStore,
} from "./backtest/store.js";
import { createHistoricalClient } from "./history/client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

interface CliOptions {
  readonly fromRunId?: string;
  readonly help: boolean;
  readonly ifAvailable: boolean;
  readonly toRunId?: string;
}

function requireRunId(
  arguments_: readonly string[],
  index: number,
  flag: string,
): string {
  const value = arguments_[index + 1];
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} requires a positive accounting run ID`);
  }
  return value;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let fromRunId: string | undefined;
  let help = false;
  let ifAvailable = false;
  let toRunId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--from-run":
        if (fromRunId !== undefined) throw new Error("--from-run supplied twice");
        fromRunId = requireRunId(arguments_, index, argument);
        index += 1;
        break;
      case "--to-run":
        if (toRunId !== undefined) throw new Error("--to-run supplied twice");
        toRunId = requireRunId(arguments_, index, argument);
        index += 1;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--if-available":
        if (ifAvailable) throw new Error("--if-available supplied twice");
        ifAvailable = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if ((fromRunId === undefined) !== (toRunId === undefined)) {
    throw new Error("--from-run and --to-run must be supplied together");
  }
  return { fromRunId, help, ifAvailable, toRunId };
}

function printHelp(): void {
  console.log(`Usage: npm run backtest:baseline -- [options]

Persists an exact raw-token fee-accrual baseline for core positions that stayed
active and had no Mint/Burn update between two canonical accounting checkpoints.
Defaults to the newest two still-canonical accounting runs.

Options:
  --from-run ID          Older accounting run (requires --to-run)
  --to-run ID            Newer accounting run (requires --from-run)
  --if-available         Exit successfully when fewer than two runs exist
  -h, --help             Show this help

Environment:
  DATABASE_URL           Required PostgreSQL database
  INDEXER_STREAM_KEY     Indexed/replayed stream
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
  const client = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs);
  const store = new PostgresStableFeeBaselineStore(environment.DATABASE_URL);
  try {
    await store.assertReady();
    let source: BaselineSourceInput;
    try {
      source = await store.load({
        fromRunId: options.fromRunId,
        streamKey: indexer.streamKey,
        toRunId: options.toRunId,
      });
    } catch (error) {
      if (options.ifAvailable && error instanceof InsufficientAccountingRunsError) {
        log("info", "stable_fee_baseline_skipped", {
          reason: "insufficient_accounting_runs",
        });
        return;
      }
      throw error;
    }
    const input = await validateBaselineSource({ client, source });
    const baseline = buildStableFeeBaseline(input);
    const saved = await store.save(baseline);
    log("info", saved.created
      ? "stable_fee_baseline_saved"
      : "stable_fee_baseline_already_exists", {
      baselineId: saved.baselineId,
      blockDelta: baseline.blockDelta,
      elapsedSeconds: baseline.elapsedSeconds,
      fromRunId: baseline.from.runId,
      stablePositions: baseline.totals.stablePositions,
      toRunId: baseline.to.runId,
      touchedPositions: baseline.totals.touchedPositions,
    });
    console.log(JSON.stringify(baseline, (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "stable_fee_baseline_failed", { error });
  process.exitCode = 1;
});
