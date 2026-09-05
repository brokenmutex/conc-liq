import { z } from "zod";
import type { PerpReferenceQualityConfig } from "./domain.js";
import { parseUnsignedDecimalX18 } from "./math.js";

const positiveInteger = z.coerce.number().int().positive();
const nonnegativeInteger = z.coerce.number().int().nonnegative();
const unsignedDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);

const environmentSchema = z.object({
  HYPERLIQUID_INFO_URL: z.string().url().default("https://api.hyperliquid.xyz/info"),
  PERP_REFERENCE_COIN: z.string().min(1).default("xyz:NVDA"),
  PERP_REFERENCE_DEX: z.string().min(1).default("xyz"),
  PERP_REFERENCE_MAX_IMPACT_SPREAD_PPM: nonnegativeInteger.default(10_000),
  PERP_REFERENCE_MAX_MARK_ORACLE_DEVIATION_PPM: nonnegativeInteger.default(5_000),
  PERP_REFERENCE_MAX_MID_ORACLE_DEVIATION_PPM: nonnegativeInteger.default(10_000),
  PERP_REFERENCE_MIN_DAY_NOTIONAL_USD: unsignedDecimal.default("1000000"),
  PERP_REFERENCE_MIN_OPEN_INTEREST_NOTIONAL_USD: unsignedDecimal.default("5000000"),
  PERP_REFERENCE_REQUEST_TIMEOUT_MS: positiveInteger.default(10_000),
});

export interface PerpReferenceConfig {
  readonly coin: string;
  readonly dex: string;
  readonly infoUrl: string;
  readonly quality: PerpReferenceQualityConfig;
  readonly requestTimeoutMs: number;
}

export function loadPerpReferenceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PerpReferenceConfig {
  const parsed = environmentSchema.parse(environment);
  if (!parsed.PERP_REFERENCE_COIN.startsWith(`${parsed.PERP_REFERENCE_DEX}:`)) {
    throw new Error("PERP_REFERENCE_COIN must be prefixed by PERP_REFERENCE_DEX");
  }
  return {
    coin: parsed.PERP_REFERENCE_COIN,
    dex: parsed.PERP_REFERENCE_DEX,
    infoUrl: new URL(parsed.HYPERLIQUID_INFO_URL).toString(),
    quality: {
      maxImpactSpreadPpm: BigInt(parsed.PERP_REFERENCE_MAX_IMPACT_SPREAD_PPM),
      maxMarkOracleDeviationPpm: BigInt(
        parsed.PERP_REFERENCE_MAX_MARK_ORACLE_DEVIATION_PPM,
      ),
      maxMidOracleDeviationPpm: BigInt(
        parsed.PERP_REFERENCE_MAX_MID_ORACLE_DEVIATION_PPM,
      ),
      minDayNotionalUsdX18: parseUnsignedDecimalX18(
        parsed.PERP_REFERENCE_MIN_DAY_NOTIONAL_USD,
        "PERP_REFERENCE_MIN_DAY_NOTIONAL_USD",
      ),
      minOpenInterestNotionalUsdX18: parseUnsignedDecimalX18(
        parsed.PERP_REFERENCE_MIN_OPEN_INTEREST_NOTIONAL_USD,
        "PERP_REFERENCE_MIN_OPEN_INTEREST_NOTIONAL_USD",
      ),
    },
    requestTimeoutMs: parsed.PERP_REFERENCE_REQUEST_TIMEOUT_MS,
  };
}
