import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import {
  DEFAULT_RISK_GATE_MAX_CANONICALITY_AGE_SECONDS,
  DEFAULT_RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS,
} from "../risk/gate.js";

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z.object({
  CANARY_MAX_CHECKPOINT_AGE_SECONDS: positiveInteger.default(180),
  DATABASE_URL: z.string().min(1),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
  RISK_GATE_MAX_CANONICALITY_AGE_SECONDS: positiveInteger.default(
    DEFAULT_RISK_GATE_MAX_CANONICALITY_AGE_SECONDS,
  ),
  RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS: positiveInteger.default(
    DEFAULT_RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS,
  ),
});

export interface GuardedCanaryConfig {
  readonly databaseUrl: string;
  readonly maxCheckpointAgeSeconds: number;
  readonly maxRiskCanonicalityAgeSeconds: number;
  readonly maxRiskSnapshotAgeSeconds: number;
  readonly streamKey: string;
}

export interface GuardedCanaryCliOptions {
  readonly budgetCapQuote?: bigint;
  readonly budgetQuote?: bigint;
  readonly halfWidthSpacings?: number;
  readonly help: boolean;
  readonly maxLiquiditySharePpm?: bigint;
  readonly maxOracleDeviationPpm?: bigint;
  readonly operator?: Address;
  readonly slippageBps?: number;
  readonly ttlSeconds?: number;
}

function value(arguments_: readonly string[], index: number, flag: string): string {
  const found = arguments_[index + 1];
  if (found === undefined || found.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return found;
}

function parseUsdRaw(raw: string, flag: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u.exec(raw);
  if (match === null) {
    throw new Error(`${flag} requires a positive USDG amount with up to 6 decimals`);
  }
  const result = BigInt(match[1]!) * 1_000_000n +
    BigInt((match[2] ?? "").padEnd(6, "0"));
  if (result === 0n) throw new Error(`${flag} must be positive`);
  return result;
}

function positiveSafeInteger(raw: string, flag: string): number {
  if (!/^[1-9]\d*$/u.test(raw)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} exceeds safe integer range`);
  return parsed;
}

function nonnegativeSafeInteger(raw: string, flag: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`${flag} must be a nonnegative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} exceeds safe integer range`);
  return parsed;
}

export function parseGuardedCanaryCli(
  arguments_: readonly string[],
): GuardedCanaryCliOptions {
  const result: {
    budgetCapQuote?: bigint;
    budgetQuote?: bigint;
    halfWidthSpacings?: number;
    help: boolean;
    maxLiquiditySharePpm?: bigint;
    maxOracleDeviationPpm?: bigint;
    operator?: Address;
    slippageBps?: number;
    ttlSeconds?: number;
  } = { help: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]!;
    if (flag === "--help" || flag === "-h") {
      result.help = true;
      continue;
    }
    const raw = value(arguments_, index, flag);
    switch (flag) {
      case "--operator":
        if (result.operator !== undefined) throw new Error(`${flag} supplied twice`);
        if (!isAddress(raw)) throw new Error(`${flag} requires an EVM address`);
        result.operator = getAddress(raw);
        break;
      case "--budget-usdg":
        if (result.budgetQuote !== undefined) throw new Error(`${flag} supplied twice`);
        result.budgetQuote = parseUsdRaw(raw, flag);
        break;
      case "--budget-cap-usdg":
        if (result.budgetCapQuote !== undefined) throw new Error(`${flag} supplied twice`);
        result.budgetCapQuote = parseUsdRaw(raw, flag);
        break;
      case "--half-width-spacings":
        if (result.halfWidthSpacings !== undefined) throw new Error(`${flag} supplied twice`);
        result.halfWidthSpacings = positiveSafeInteger(raw, flag);
        break;
      case "--slippage-bps":
        if (result.slippageBps !== undefined) throw new Error(`${flag} supplied twice`);
        result.slippageBps = positiveSafeInteger(raw, flag);
        break;
      case "--max-oracle-deviation-ppm":
        if (result.maxOracleDeviationPpm !== undefined) throw new Error(`${flag} supplied twice`);
        result.maxOracleDeviationPpm = BigInt(nonnegativeSafeInteger(raw, flag));
        break;
      case "--max-liquidity-share-ppm":
        if (result.maxLiquiditySharePpm !== undefined) throw new Error(`${flag} supplied twice`);
        result.maxLiquiditySharePpm = BigInt(positiveSafeInteger(raw, flag));
        break;
      case "--ttl-seconds":
        if (result.ttlSeconds !== undefined) throw new Error(`${flag} supplied twice`);
        result.ttlSeconds = positiveSafeInteger(raw, flag);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
    index += 1;
  }
  return result;
}

export function loadGuardedCanaryConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GuardedCanaryConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    databaseUrl: parsed.DATABASE_URL,
    maxCheckpointAgeSeconds: parsed.CANARY_MAX_CHECKPOINT_AGE_SECONDS,
    maxRiskCanonicalityAgeSeconds: parsed.RISK_GATE_MAX_CANONICALITY_AGE_SECONDS,
    maxRiskSnapshotAgeSeconds: parsed.RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS,
    streamKey: parsed.INDEXER_STREAM_KEY,
  };
}
