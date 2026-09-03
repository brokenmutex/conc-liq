import { createHash } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { RegistryPayload } from "../registry.js";
import { parseRegistry } from "../registry.js";
import type { OracleFeedMetadata, SourceEvidence } from "./domain.js";

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

async function fetchJsonText(url: string, timeoutMs: number): Promise<{
  readonly evidence: SourceEvidence;
  readonly value: unknown;
}> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Canonical JSON source returned HTTP ${response.status}`);
  }
  const raw = await response.text();
  return {
    evidence: {
      fetchedAt: new Date().toISOString(),
      sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      url,
    },
    value: JSON.parse(raw) as unknown,
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

function expectedProductType(symbol: string): string {
  return symbol === "USDG" ? "RefPrice" : "primaryTokenizedPrice";
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
