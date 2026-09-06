import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
});

export interface JoinedPolicyCliOptions {
  readonly budgetQuote?: bigint;
  readonly fee?: number;
  readonly halfWidths?: readonly number[];
  readonly help: boolean;
  readonly lookback?: number;
  readonly minExternalFallbackCheckpoints?: number;
  readonly minPassingCheckpoints?: number;
  readonly minWeekendFallbackCheckpoints?: number;
  readonly minWindowHours?: number;
  readonly rwaSymbol?: string;
  readonly triggerPercent?: number;
}

function value(arguments_: readonly string[], index: number, flag: string): string {
  const result = arguments_[index + 1];
  if (result === undefined || result.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return result;
}

function positiveInteger(raw: string, flag: string): number {
  if (!/^[1-9]\d*$/u.test(raw)) throw new Error(`${flag} requires a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} exceeds safe integer range`);
  return parsed;
}

function nonnegativeInteger(raw: string, flag: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`${flag} requires a nonnegative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} exceeds safe integer range`);
  return parsed;
}

function quoteRaw(raw: string, flag: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u.exec(raw);
  if (match === null) {
    throw new Error(`${flag} requires a positive USDG amount with up to 6 decimals`);
  }
  const parsed = BigInt(match[1]!) * 1_000_000n +
    BigInt((match[2] ?? "").padEnd(6, "0"));
  if (parsed === 0n) throw new Error(`${flag} must be positive`);
  return parsed;
}

export function parseJoinedPolicyCli(
  arguments_: readonly string[],
): JoinedPolicyCliOptions {
  const result: {
    budgetQuote?: bigint;
    fee?: number;
    halfWidths?: number[];
    help: boolean;
    lookback?: number;
    minExternalFallbackCheckpoints?: number;
    minPassingCheckpoints?: number;
    minWeekendFallbackCheckpoints?: number;
    minWindowHours?: number;
    rwaSymbol?: string;
    triggerPercent?: number;
  } = { help: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]!;
    if (flag === "--help" || flag === "-h") {
      result.help = true;
      continue;
    }
    const raw = value(arguments_, index, flag);
    switch (flag) {
      case "--rwa":
        if (result.rwaSymbol !== undefined) throw new Error(`${flag} supplied twice`);
        result.rwaSymbol = raw.toUpperCase();
        if (!/^[A-Z0-9]{1,16}$/u.test(result.rwaSymbol)) {
          throw new Error(`${flag} requires a canonical symbol`);
        }
        break;
      case "--fee":
        if (result.fee !== undefined) throw new Error(`${flag} supplied twice`);
        result.fee = positiveInteger(raw, flag);
        if (result.fee > 1_000_000) throw new Error(`${flag} exceeds uint24 fee domain`);
        break;
      case "--budget-usdg":
        if (result.budgetQuote !== undefined) throw new Error(`${flag} supplied twice`);
        result.budgetQuote = quoteRaw(raw, flag);
        break;
      case "--half-widths":
        if (result.halfWidths !== undefined) throw new Error(`${flag} supplied twice`);
        result.halfWidths = raw.split(",").map((entry) => positiveInteger(entry, flag));
        break;
      case "--trigger-percent":
        if (result.triggerPercent !== undefined) throw new Error(`${flag} supplied twice`);
        result.triggerPercent = positiveInteger(raw, flag);
        if (result.triggerPercent > 100) throw new Error(`${flag} must be 1..100`);
        break;
      case "--lookback":
        if (result.lookback !== undefined) throw new Error(`${flag} supplied twice`);
        result.lookback = positiveInteger(raw, flag);
        if (result.lookback < 2 || result.lookback > 256) {
          throw new Error(`${flag} must be 2..256`);
        }
        break;
      case "--min-passing-checkpoints":
        if (result.minPassingCheckpoints !== undefined) throw new Error(`${flag} supplied twice`);
        result.minPassingCheckpoints = positiveInteger(raw, flag);
        if (result.minPassingCheckpoints < 2) throw new Error(`${flag} must be at least 2`);
        break;
      case "--min-window-hours":
        if (result.minWindowHours !== undefined) throw new Error(`${flag} supplied twice`);
        result.minWindowHours = positiveInteger(raw, flag);
        break;
      case "--min-weekend-fallback-checkpoints":
        if (result.minWeekendFallbackCheckpoints !== undefined) {
          throw new Error(`${flag} supplied twice`);
        }
        result.minWeekendFallbackCheckpoints = nonnegativeInteger(raw, flag);
        break;
      case "--min-external-fallback-checkpoints":
        if (result.minExternalFallbackCheckpoints !== undefined) {
          throw new Error(`${flag} supplied twice`);
        }
        result.minExternalFallbackCheckpoints = nonnegativeInteger(raw, flag);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
    index += 1;
  }
  return result;
}

export function loadJoinedPolicyEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): { readonly databaseUrl: string; readonly streamKey: string } {
  const parsed = environmentSchema.parse(environment);
  return { databaseUrl: parsed.DATABASE_URL, streamKey: parsed.INDEXER_STREAM_KEY };
}
