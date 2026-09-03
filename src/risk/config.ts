import { z } from "zod";
import { DEFAULT_RWA_SYMBOLS } from "../constants.js";

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z.object({
  CHAINLINK_ROBINHOOD_FEEDS_URL: z
    .string()
    .url()
    .default("https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json"),
  HTTP_TIMEOUT_MS: positiveInteger.default(10_000),
  RISK_MAX_PRICE_AGE_SECONDS: positiveInteger.default(300),
  ROBINHOOD_ASSETS_URL: z
    .string()
    .url()
    .default("https://api.robinhood.com/rhj/assets"),
  RWA_SYMBOLS: z.string().optional(),
});

export interface RiskConfig {
  readonly assetsUrl: string;
  readonly feedDirectoryUrl: string;
  readonly httpTimeoutMs: number;
  readonly maxPriceAgeSeconds: number;
  readonly symbols: readonly string[];
}

function parseSymbols(value: string | undefined): string[] {
  const symbols = (value === undefined ? DEFAULT_RWA_SYMBOLS : value.split(","))
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  const unique = [...new Set(symbols)];
  if (unique.length === 0) {
    throw new Error("RWA_SYMBOLS must contain at least one symbol");
  }
  return unique;
}

export function loadRiskConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RiskConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    assetsUrl: parsed.ROBINHOOD_ASSETS_URL,
    feedDirectoryUrl: parsed.CHAINLINK_ROBINHOOD_FEEDS_URL,
    httpTimeoutMs: parsed.HTTP_TIMEOUT_MS,
    maxPriceAgeSeconds: parsed.RISK_MAX_PRICE_AGE_SECONDS,
    symbols: parseSymbols(parsed.RWA_SYMBOLS),
  };
}
