import { z } from "zod";
import { log } from "./logger.js";
import { replayOracleMarkedPolicies } from "./oracle-policy/replay.js";
import { PostgresOraclePolicyReplayStore } from "./oracle-policy/store.js";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
});

interface CliOptions {
  readonly budgetQuote?: bigint;
  readonly entryCostQuote?: bigint;
  readonly fee?: number;
  readonly firstCheckpointRunId?: string;
  readonly halfWidths?: readonly number[];
  readonly help: boolean;
  readonly lastCheckpointRunId?: string;
  readonly lookback: number;
  readonly rebalanceCostQuote?: bigint;
  readonly rwaSymbol?: string;
  readonly triggerPercent?: number;
}

function requireValue(
  arguments_: readonly string[],
  index: number,
  flag: string,
): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseUsdRaw(value: string, flag: string, allowZero: boolean): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value);
  if (match === null) {
    throw new Error(`${flag} requires a nonnegative USDG amount with up to 6 decimals`);
  }
  const raw = BigInt(match[1]!) * 1_000_000n +
    BigInt((match[2] ?? "").padEnd(6, "0"));
  if (!allowZero && raw === 0n) throw new Error(`${flag} must be positive`);
  return raw;
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} exceeds the safe integer range`);
  }
  return parsed;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let budgetQuote: bigint | undefined;
  let entryCostQuote: bigint | undefined;
  let fee: number | undefined;
  let firstCheckpointRunId: string | undefined;
  let halfWidths: number[] | undefined;
  let help = false;
  let lastCheckpointRunId: string | undefined;
  let lookback = 60;
  let lookbackSupplied = false;
  let rebalanceCostQuote: bigint | undefined;
  let rwaSymbol: string | undefined;
  let triggerPercent: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const value = () => requireValue(arguments_, index, argument);
    switch (argument) {
      case "--rwa":
        if (rwaSymbol !== undefined) throw new Error("--rwa supplied twice");
        rwaSymbol = value().toUpperCase();
        if (!/^[A-Z0-9]{1,16}$/.test(rwaSymbol)) {
          throw new Error("--rwa requires a canonical asset symbol");
        }
        index += 1;
        break;
      case "--fee":
        if (fee !== undefined) throw new Error("--fee supplied twice");
        fee = positiveInteger(value(), argument);
        index += 1;
        break;
      case "--budget-usdg":
        if (budgetQuote !== undefined) throw new Error("--budget-usdg supplied twice");
        budgetQuote = parseUsdRaw(value(), argument, false);
        index += 1;
        break;
      case "--entry-cost-usdg":
        if (entryCostQuote !== undefined) {
          throw new Error("--entry-cost-usdg supplied twice");
        }
        entryCostQuote = parseUsdRaw(value(), argument, true);
        index += 1;
        break;
      case "--rebalance-cost-usdg":
        if (rebalanceCostQuote !== undefined) {
          throw new Error("--rebalance-cost-usdg supplied twice");
        }
        rebalanceCostQuote = parseUsdRaw(value(), argument, true);
        index += 1;
        break;
      case "--trigger-percent":
        if (triggerPercent !== undefined) {
          throw new Error("--trigger-percent supplied twice");
        }
        triggerPercent = positiveInteger(value(), argument);
        if (triggerPercent > 100) {
          throw new Error("--trigger-percent must be between 1 and 100");
        }
        index += 1;
        break;
      case "--half-widths":
        if (halfWidths !== undefined) throw new Error("--half-widths supplied twice");
        halfWidths = value().split(",").map((entry) =>
          positiveInteger(entry, argument)
        );
        index += 1;
        break;
      case "--lookback":
        if (lookbackSupplied) throw new Error("--lookback supplied twice");
        lookback = positiveInteger(value(), argument);
        if (lookback < 2 || lookback > 256) {
          throw new Error("--lookback must be between 2 and 256");
        }
        lookbackSupplied = true;
        index += 1;
        break;
      case "--from-checkpoint":
        if (firstCheckpointRunId !== undefined) {
          throw new Error("--from-checkpoint supplied twice");
        }
        firstCheckpointRunId = value();
        if (!/^[1-9]\d*$/.test(firstCheckpointRunId)) {
          throw new Error("--from-checkpoint requires a positive run ID");
        }
        index += 1;
        break;
      case "--to-checkpoint":
        if (lastCheckpointRunId !== undefined) {
          throw new Error("--to-checkpoint supplied twice");
        }
        lastCheckpointRunId = value();
        if (!/^[1-9]\d*$/.test(lastCheckpointRunId)) {
          throw new Error("--to-checkpoint requires a positive run ID");
        }
        index += 1;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if ((firstCheckpointRunId === undefined) !== (lastCheckpointRunId === undefined)) {
    throw new Error("--from-checkpoint and --to-checkpoint must be supplied together");
  }
  if (firstCheckpointRunId !== undefined && lookbackSupplied) {
    throw new Error("--lookback cannot be combined with explicit checkpoint endpoints");
  }
  return {
    budgetQuote,
    entryCostQuote,
    fee,
    firstCheckpointRunId,
    halfWidths,
    help,
    lastCheckpointRunId,
    lookback,
    rebalanceCostQuote,
    rwaSymbol,
    triggerPercent,
  };
}

function printHelp(): void {
  console.log(`Usage: npm run oracle-policy:replay -- [options]

Replays stateful Uniswap V3 range policies over synchronized strategy
checkpoints. PostgreSQL supplies stored canonicality, oracle marks, pool state,
and indexed Swap paths; this command makes no RPC calls.

Required:
  --rwa SYMBOL                  Canonical RWA symbol, for example NVDA
  --fee PIPS                    Canonical V3 fee tier, for example 500
  --budget-usdg AMOUNT          Starting budget in USDG display units
  --entry-cost-usdg AMOUNT      Explicit one-time entry cost
  --rebalance-cost-usdg AMOUNT  Explicit cost charged at every recenter
  --trigger-percent INTEGER     Recenter distance as 1-100% of half-width
  --half-widths LIST            Comma-separated half-widths in tick spacings

Optional:
  --lookback COUNT              Newest checkpoints (default 60; max 256)
  --from-checkpoint ID          First checkpoint (requires --to-checkpoint)
  --to-checkpoint ID            Last checkpoint; includes intervening runs
  -h, --help                    Show this help

Environment:
  DATABASE_URL                  Required PostgreSQL database
  INDEXER_STREAM_KEY            Event stream (default robinhood-v3-rwa-usdg-v1)
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (
    options.rwaSymbol === undefined || options.fee === undefined ||
    options.budgetQuote === undefined || options.entryCostQuote === undefined ||
    options.rebalanceCostQuote === undefined ||
    options.triggerPercent === undefined || options.halfWidths === undefined
  ) {
    throw new Error(
      "--rwa, --fee, --budget-usdg, --entry-cost-usdg, " +
      "--rebalance-cost-usdg, --trigger-percent, and --half-widths are required",
    );
  }
  const environment = environmentSchema.parse(process.env);
  const store = new PostgresOraclePolicyReplayStore(environment.DATABASE_URL);
  try {
    await store.assertReady();
    const source = await store.load({
      fee: options.fee,
      firstCheckpointRunId: options.firstCheckpointRunId,
      lastCheckpointRunId: options.lastCheckpointRunId,
      lookback: options.lookback,
      rwaSymbol: options.rwaSymbol,
      streamKey: environment.INDEXER_STREAM_KEY,
    });
    const replay = replayOracleMarkedPolicies({
      budgetQuote: options.budgetQuote,
      entryCostQuote: options.entryCostQuote,
      halfWidths: options.halfWidths,
      rebalanceCostQuote: options.rebalanceCostQuote,
      source,
      triggerPercent: options.triggerPercent,
    });
    const saved = await store.save(replay);
    log("info", saved.created
      ? "oracle_policy_replay_saved"
      : "oracle_policy_replay_already_exists", {
      completedCandidates: replay.completedCandidates,
      excludedCandidates: replay.excludedCandidates,
      firstCheckpointRunId: replay.first.checkpointRunId,
      lastCheckpointRunId: replay.last.checkpointRunId,
      pool: `${replay.rwaSymbol}/${replay.fee}`,
      replayRunId: saved.replayRunId,
    });
    console.log(JSON.stringify(replay, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "oracle_policy_replay_failed", { error });
  process.exitCode = 1;
});
