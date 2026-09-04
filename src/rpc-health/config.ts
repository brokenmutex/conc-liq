import { z } from "zod";
import { ROBINHOOD_CHAIN_ID } from "../constants.js";

export const DEFAULT_RPC_HEALTH_REFERENCES = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood-mainnet-rpc.blockreq.com/v1/rpc/public",
] as const;

const positiveInteger = z.coerce.number().int().positive();
const nonnegativeInteger = z.coerce.number().int().nonnegative();

const monitorEnvironmentSchema = z.object({
  RH_INDEXER_RPC_URL: z.string().url().optional(),
  RH_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  RPC_HEALTH_CONFIRMATION_DEPTH: nonnegativeInteger.default(64),
  RPC_HEALTH_HARD_LAG_BLOCKS: positiveInteger.default(100),
  RPC_HEALTH_HARD_LAG_SECONDS: positiveInteger.default(30),
  RPC_HEALTH_HARD_LATENCY_MS: positiveInteger.default(5_000),
  RPC_HEALTH_POLL_INTERVAL_MS: positiveInteger.default(10_000),
  RPC_HEALTH_RECOVERY_SAMPLES: positiveInteger.default(12),
  RPC_HEALTH_REFERENCE_QUORUM: positiveInteger.default(2),
  RPC_HEALTH_REFERENCE_URLS: z.string().min(1).default(
    DEFAULT_RPC_HEALTH_REFERENCES.join(","),
  ),
  RPC_HEALTH_REQUEST_TIMEOUT_MS: positiveInteger.default(5_000),
  RPC_HEALTH_SOFT_LAG_BLOCKS: nonnegativeInteger.default(20),
  RPC_HEALTH_SOFT_LAG_SECONDS: nonnegativeInteger.default(5),
  RPC_HEALTH_SOFT_LATENCY_MS: positiveInteger.default(2_000),
  RPC_HEALTH_STALL_SECONDS: positiveInteger.default(30),
});

const gateEnvironmentSchema = z.object({
  RPC_HEALTH_CACHE_MS: positiveInteger.default(2_000),
  RPC_HEALTH_GATE_ENABLED: z.enum(["true", "false"]).default("true"),
  RPC_HEALTH_MAX_SAMPLE_AGE_SECONDS: positiveInteger.default(30),
});

export interface RpcHealthPolicyConfig {
  readonly confirmationDepth: number;
  readonly expectedChainId: number;
  readonly hardLagBlocks: bigint;
  readonly hardLagSeconds: bigint;
  readonly hardLatencyMs: number;
  readonly recoverySamples: number;
  readonly referenceQuorum: number;
  readonly softLagBlocks: bigint;
  readonly softLagSeconds: bigint;
  readonly softLatencyMs: number;
  readonly stallSeconds: number;
}

export interface RpcHealthMonitorConfig extends RpcHealthPolicyConfig {
  readonly pollIntervalMs: number;
  readonly privateUrl: string;
  readonly referenceUrls: readonly string[];
  readonly requestTimeoutMs: number;
}

export interface RpcHealthGateConfig {
  readonly cacheMs: number;
  readonly enabled: boolean;
  readonly maxSampleAgeSeconds: number;
}

function normalizedUrls(value: string): string[] {
  const urls = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const normalized = urls.map((entry) => new URL(entry).toString());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("RPC health reference URLs must be unique");
  }
  return normalized;
}

export function loadRpcHealthMonitorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RpcHealthMonitorConfig {
  const parsed = monitorEnvironmentSchema.parse(environment);
  const privateUrl = new URL(
    parsed.RH_INDEXER_RPC_URL ?? parsed.RH_RPC_URL,
  ).toString();
  const referenceUrls = normalizedUrls(parsed.RPC_HEALTH_REFERENCE_URLS);
  if (referenceUrls.length < parsed.RPC_HEALTH_REFERENCE_QUORUM) {
    throw new Error("RPC health reference count is below the configured quorum");
  }
  if (referenceUrls.includes(privateUrl)) {
    throw new Error("Private RPC endpoint must not also be a quorum reference");
  }
  if (parsed.RPC_HEALTH_HARD_LAG_BLOCKS <= parsed.RPC_HEALTH_SOFT_LAG_BLOCKS) {
    throw new Error("Hard block lag must exceed soft block lag");
  }
  if (parsed.RPC_HEALTH_HARD_LAG_SECONDS <= parsed.RPC_HEALTH_SOFT_LAG_SECONDS) {
    throw new Error("Hard time lag must exceed soft time lag");
  }
  if (parsed.RPC_HEALTH_HARD_LATENCY_MS <= parsed.RPC_HEALTH_SOFT_LATENCY_MS) {
    throw new Error("Hard RPC latency must exceed soft RPC latency");
  }
  return {
    confirmationDepth: parsed.RPC_HEALTH_CONFIRMATION_DEPTH,
    expectedChainId: ROBINHOOD_CHAIN_ID,
    hardLagBlocks: BigInt(parsed.RPC_HEALTH_HARD_LAG_BLOCKS),
    hardLagSeconds: BigInt(parsed.RPC_HEALTH_HARD_LAG_SECONDS),
    hardLatencyMs: parsed.RPC_HEALTH_HARD_LATENCY_MS,
    pollIntervalMs: parsed.RPC_HEALTH_POLL_INTERVAL_MS,
    privateUrl,
    recoverySamples: parsed.RPC_HEALTH_RECOVERY_SAMPLES,
    referenceQuorum: parsed.RPC_HEALTH_REFERENCE_QUORUM,
    referenceUrls,
    requestTimeoutMs: parsed.RPC_HEALTH_REQUEST_TIMEOUT_MS,
    softLagBlocks: BigInt(parsed.RPC_HEALTH_SOFT_LAG_BLOCKS),
    softLagSeconds: BigInt(parsed.RPC_HEALTH_SOFT_LAG_SECONDS),
    softLatencyMs: parsed.RPC_HEALTH_SOFT_LATENCY_MS,
    stallSeconds: parsed.RPC_HEALTH_STALL_SECONDS,
  };
}

export function loadRpcHealthGateConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RpcHealthGateConfig {
  const parsed = gateEnvironmentSchema.parse(environment);
  return {
    cacheMs: parsed.RPC_HEALTH_CACHE_MS,
    enabled: parsed.RPC_HEALTH_GATE_ENABLED === "true",
    maxSampleAgeSeconds: parsed.RPC_HEALTH_MAX_SAMPLE_AGE_SECONDS,
  };
}
