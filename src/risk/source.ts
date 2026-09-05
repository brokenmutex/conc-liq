import { createHash } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { RegistryPayload } from "../registry.js";
import { parseRegistry } from "../registry.js";
import type {
  MarketSessionSnapshot,
  OracleFeedMetadata,
  SourceEvidence,
} from "./domain.js";

const feedSchema = z.object({
  decimals: z.number().int().min(0).max(255),
  docs: z.object({
    baseAsset: z.string().default(""),
    blockchainName: z.string().default(""),
    marketHours: z.string().min(1).optional(),
    productTypeCode: z.string().default(""),
    quoteAsset: z.string().default(""),
  }),
  heartbeat: z.number().int().positive(),
  name: z.string().min(1),
  proxyAddress: z.string(),
});

const feedDirectorySchema = z.array(feedSchema);
export type FeedDirectoryPayload = z.infer<typeof feedDirectorySchema>;

export interface FetchedSource<T> {
  readonly evidence: SourceEvidence;
  readonly payload: T;
}

async function fetchText(
  url: string,
  timeoutMs: number,
  accept: string,
): Promise<{
  readonly evidence: SourceEvidence;
  readonly raw: string;
}> {
  const response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Canonical source returned HTTP ${response.status}`);
  }
  const raw = await response.text();
  return {
    evidence: {
      fetchedAt: new Date().toISOString(),
      sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      url,
    },
    raw,
  };
}

async function fetchJsonText(url: string, timeoutMs: number): Promise<{
  readonly evidence: SourceEvidence;
  readonly value: unknown;
}> {
  const source = await fetchText(url, timeoutMs, "application/json");
  return {
    evidence: source.evidence,
    value: JSON.parse(source.raw) as unknown,
  };
}

export async function fetchRegistrySource(
  url: string,
  timeoutMs: number,
): Promise<FetchedSource<RegistryPayload>> {
  const source = await fetchJsonText(url, timeoutMs);
  return {
    evidence: source.evidence,
    payload: parseRegistry(source.value),
  };
}

export async function fetchFeedDirectory(
  url: string,
  timeoutMs: number,
): Promise<FetchedSource<FeedDirectoryPayload>> {
  const source = await fetchJsonText(url, timeoutMs);
  return {
    evidence: source.evidence,
    payload: feedDirectorySchema.parse(source.value),
  };
}

const STOCK_TOKENS_24_7_MARKER = /Markets\s+beyond\s+borders,?\s*24\/7/iu;

export function evaluateMarketSessionPolicy(
  raw: string,
  evidence: SourceEvidence,
): MarketSessionSnapshot {
  const verified = STOCK_TOKENS_24_7_MARKER.test(raw);
  return {
    evidence,
    executionEligible: verified,
    policy: "robinhood_stock_tokens_24_7",
    reasons: verified ? [] : ["market_session_unverified"],
    status: verified ? "open_24_7" : "unverified",
  };
}

export async function fetchMarketSessionPolicy(
  url: string,
  timeoutMs: number,
): Promise<MarketSessionSnapshot> {
  const source = await fetchText(url, timeoutMs, "text/html");
  return evaluateMarketSessionPolicy(source.raw, source.evidence);
}

function expectedProductType(symbol: string): string {
  return symbol === "USDG" || symbol === "ETH"
    ? "RefPrice"
    : "primaryTokenizedPrice";
}

export function selectOracleFeed(
  directory: FeedDirectoryPayload,
  requestedSymbol: string,
): OracleFeedMetadata | null {
  const symbol = requestedSymbol.toUpperCase();
  const candidates = directory.filter((feed) =>
    feed.docs.baseAsset.toUpperCase() === symbol &&
    feed.docs.blockchainName.toUpperCase() === "ROBINHOOD" &&
    feed.docs.quoteAsset.toUpperCase() === "USD" &&
    feed.docs.productTypeCode === expectedProductType(symbol) &&
    isAddress(feed.proxyAddress)
  );
  if (candidates.length > 1) {
    throw new Error(`Chainlink directory contains duplicate ${symbol}/USD feeds`);
  }
  const feed = candidates[0];
  if (feed === undefined) {
    return null;
  }
  return {
    address: getAddress(feed.proxyAddress),
    baseAsset: feed.docs.baseAsset,
    decimals: feed.decimals,
    heartbeatSeconds: feed.heartbeat,
    marketHours: feed.docs.marketHours ?? null,
    name: feed.name,
    productTypeCode: feed.docs.productTypeCode,
    quoteAsset: feed.docs.quoteAsset,
  };
}
