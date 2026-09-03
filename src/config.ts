import { z } from "zod";
import { DEFAULT_FEE_TIERS, DEFAULT_RWA_SYMBOLS } from "./constants.js";

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  HTTP_TIMEOUT_MS: positiveInteger.default(10_000),
  RH_RPC_URL: z
    .string()
    .url()
    .default("https://rpc.mainnet.chain.robinhood.com"),
  ROBINHOOD_ASSETS_URL: z
    .string()
    .url()
    .default("https://api.robinhood.com/rhj/assets"),
  RPC_TIMEOUT_MS: positiveInteger.default(15_000),
  RWA_SYMBOLS: z.string().optional(),
  SNAPSHOT_JSONL_PATH: z.string().min(1).default("data/snapshots.jsonl"),
  UNISWAP_V3_FEE_TIERS: z.string().optional(),
});

export interface ObserverConfig {
  readonly assetsUrl: string;
  readonly databaseUrl?: string;
  readonly feeTiers: readonly number[];
  readonly httpTimeoutMs: number;
  readonly jsonlPath: string;
  readonly rpcTimeoutMs: number;
  readonly rpcUrl: string;
  readonly symbols: readonly string[];
}

function commaSeparated(value: string | undefined, defaults: readonly string[]): string[] {
  const items = (value === undefined ? defaults : value.split(","))
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

  return [...new Set(items)];
}

function parseFeeTiers(value: string | undefined): number[] {
  const raw = value === undefined
    ? [...DEFAULT_FEE_TIERS]
    : value.split(",").map((item) => Number(item.trim()));

  if (
    raw.length === 0 ||
    raw.some((fee) => !Number.isInteger(fee) || fee <= 0 || fee > 1_000_000)
  ) {
    throw new Error("UNISWAP_V3_FEE_TIERS must be comma-separated positive uint24 values");
  }

  return [...new Set(raw)];
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ObserverConfig {
  const parsed = environmentSchema.parse(environment);
  const symbols = commaSeparated(parsed.RWA_SYMBOLS, DEFAULT_RWA_SYMBOLS);

  if (symbols.length === 0) {
    throw new Error("RWA_SYMBOLS must contain at least one symbol");
  }

  return {
    assetsUrl: parsed.ROBINHOOD_ASSETS_URL,
    databaseUrl: parsed.DATABASE_URL,
    feeTiers: parseFeeTiers(parsed.UNISWAP_V3_FEE_TIERS),
    httpTimeoutMs: parsed.HTTP_TIMEOUT_MS,
    jsonlPath: parsed.SNAPSHOT_JSONL_PATH,
    rpcTimeoutMs: parsed.RPC_TIMEOUT_MS,
    rpcUrl: parsed.RH_RPC_URL,
    symbols,
  };
}
