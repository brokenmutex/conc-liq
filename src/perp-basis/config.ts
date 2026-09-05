import { z } from "zod";
import type { PerpBasisConfig } from "./domain.js";

const nonnegativeInteger = z.coerce.number().int().nonnegative();
const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z.object({
  PERP_BASIS_MAX_POOL_DEVIATION_PPM: nonnegativeInteger.default(20_000),
  PERP_BASIS_MAX_QUOTE_DEPEG_PPM: nonnegativeInteger.default(10_000),
  PERP_BASIS_MAX_QUOTE_ORACLE_AGE_SECONDS: positiveInteger.default(86_400),
  PERP_BASIS_MAX_SOURCE_AGE_SECONDS: positiveInteger.default(600),
  PERP_BASIS_MAX_SOURCE_SKEW_SECONDS: positiveInteger.default(360),
});

export function loadPerpBasisConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PerpBasisConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    maxPoolDeviationPpm: BigInt(parsed.PERP_BASIS_MAX_POOL_DEVIATION_PPM),
    maxQuoteDepegPpm: BigInt(parsed.PERP_BASIS_MAX_QUOTE_DEPEG_PPM),
    maxQuoteOracleAgeSeconds: parsed.PERP_BASIS_MAX_QUOTE_ORACLE_AGE_SECONDS,
    maxSourceAgeSeconds: parsed.PERP_BASIS_MAX_SOURCE_AGE_SECONDS,
    maxSourceSkewSeconds: parsed.PERP_BASIS_MAX_SOURCE_SKEW_SECONDS,
  };
}
