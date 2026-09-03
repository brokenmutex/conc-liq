import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const nonnegativeInteger = z.coerce.number().int().nonnegative();

const indexerEnvironmentSchema = z.object({
  INDEXER_CONFIRMATION_DEPTH: nonnegativeInteger.default(64),
  INDEXER_INITIAL_CHUNK_SIZE: positiveInteger.default(10_000),
  INDEXER_MAX_CHUNK_SIZE: positiveInteger.default(25_000),
  INDEXER_MIN_CHUNK_SIZE: positiveInteger.default(100),
  INDEXER_POOLS_PATH: z.string().min(1).default("config/indexer-pools.json"),
  INDEXER_REORG_OVERLAP: nonnegativeInteger.default(256),
  INDEXER_STREAM_KEY: z.string().min(1).default("robinhood-v3-rwa-usdg-v1"),
  RH_INDEXER_RPC_URL: z.string().url().optional(),
  RH_RPC_URL: z
    .string()
    .url()
    .default("https://rpc.mainnet.chain.robinhood.com"),
  RPC_TIMEOUT_MS: positiveInteger.default(15_000),
});

export interface IndexerConfig {
  readonly confirmationDepth: number;
  readonly initialChunkSize: number;
  readonly maxChunkSize: number;
  readonly minChunkSize: number;
  readonly poolsPath: string;
  readonly reorgOverlap: number;
  readonly rpcTimeoutMs: number;
  readonly rpcUrl: string;
  readonly streamKey: string;
}

export function loadIndexerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IndexerConfig {
  const parsed = indexerEnvironmentSchema.parse(environment);
  if (parsed.INDEXER_MIN_CHUNK_SIZE > parsed.INDEXER_INITIAL_CHUNK_SIZE) {
    throw new Error("INDEXER_MIN_CHUNK_SIZE must not exceed INDEXER_INITIAL_CHUNK_SIZE");
  }
  if (parsed.INDEXER_INITIAL_CHUNK_SIZE > parsed.INDEXER_MAX_CHUNK_SIZE) {
    throw new Error("INDEXER_INITIAL_CHUNK_SIZE must not exceed INDEXER_MAX_CHUNK_SIZE");
  }

  return {
    confirmationDepth: parsed.INDEXER_CONFIRMATION_DEPTH,
    initialChunkSize: parsed.INDEXER_INITIAL_CHUNK_SIZE,
    maxChunkSize: parsed.INDEXER_MAX_CHUNK_SIZE,
    minChunkSize: parsed.INDEXER_MIN_CHUNK_SIZE,
    poolsPath: parsed.INDEXER_POOLS_PATH,
    reorgOverlap: parsed.INDEXER_REORG_OVERLAP,
    rpcTimeoutMs: parsed.RPC_TIMEOUT_MS,
    rpcUrl: parsed.RH_INDEXER_RPC_URL ?? parsed.RH_RPC_URL,
    streamKey: parsed.INDEXER_STREAM_KEY,
  };
}
