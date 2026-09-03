import { ROBINHOOD_CHAIN_ID } from "../constants.js";
import { selectCanonicalAssets } from "../registry.js";
import type { RiskConfig } from "./config.js";
import type {
  OracleFeedMetadata,
  OracleRiskSnapshot,
  RiskSnapshot,
  TokenRiskState,
} from "./domain.js";
import {
  evaluateAssetRisk,
  evaluateOracleRisk,
  sanitizeRiskError,
} from "./evaluate.js";
import type { RiskChainReader } from "./reader.js";
import {
  fetchFeedDirectory,
  fetchRegistrySource,
  selectOracleFeed,
} from "./source.js";

async function readOracleRisk(input: {
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly feed: OracleFeedMetadata;
  readonly maxPriceAgeSeconds: number;
  readonly reader: RiskChainReader;
}): Promise<OracleRiskSnapshot> {
  try {
    const state = await input.reader.readOracle(input.feed.address, input.blockNumber);
    return evaluateOracleRisk({
      blockTimestamp: input.blockTimestamp,
      feed: input.feed,
      maxPriceAgeSeconds: input.maxPriceAgeSeconds,
      state,
    });
  } catch (error) {
    return evaluateOracleRisk({
      blockTimestamp: input.blockTimestamp,
      feed: input.feed,
      maxPriceAgeSeconds: input.maxPriceAgeSeconds,
      readError: sanitizeRiskError(error),
      state: null,
    });
  }
}

async function readTokenRisk(
  reader: RiskChainReader,
  address: Parameters<RiskChainReader["readToken"]>[0],
  blockNumber: bigint,
): Promise<{ readonly error: string | null; readonly state: TokenRiskState | null }> {
  try {
    return {
      error: null,
      state: await reader.readToken(address, blockNumber),
    };
  } catch (error) {
    return { error: sanitizeRiskError(error), state: null };
  }
}

export async function collectRiskSnapshot(input: {
  readonly blockNumber: bigint;
  readonly config: RiskConfig;
  readonly reader: RiskChainReader;
}): Promise<RiskSnapshot> {
  const [chainId, block, registrySource, feedSource] = await Promise.all([
    input.reader.getChainId(),
    input.reader.getBlock(input.blockNumber),
    fetchRegistrySource(input.config.assetsUrl, input.config.httpTimeoutMs),
    fetchFeedDirectory(input.config.feedDirectoryUrl, input.config.httpTimeoutMs),
  ]);
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `RPC chain ID mismatch: expected ${ROBINHOOD_CHAIN_ID}, received ${chainId}`,
    );
  }
  if (block.number !== input.blockNumber) {
    throw new Error(`RPC returned block ${block.number} for requested ${input.blockNumber}`);
  }

  const registryAssets = selectCanonicalAssets(
    registrySource.payload,
    input.config.symbols,
  );
  const quoteFeed = selectOracleFeed(feedSource.payload, "USDG");
  const quoteOracle = quoteFeed === null
    ? null
    : await readOracleRisk({
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      feed: quoteFeed,
      maxPriceAgeSeconds: input.config.maxPriceAgeSeconds,
      reader: input.reader,
    });
  const globalReasons = [
    "market_session_unverified",
    "sequencer_feed_unavailable",
  ];
  const assets = [];

  for (const registry of registryAssets) {
    const feed = selectOracleFeed(feedSource.payload, registry.symbol);
    const [token, oracle] = await Promise.all([
      readTokenRisk(input.reader, registry.address, block.number),
      feed === null
        ? Promise.resolve(null)
        : readOracleRisk({
          blockNumber: block.number,
          blockTimestamp: block.timestamp,
          feed,
          maxPriceAgeSeconds: input.config.maxPriceAgeSeconds,
          reader: input.reader,
        }),
    ]);
    assets.push(evaluateAssetRisk({
      blockTimestamp: block.timestamp,
      globalReasons,
      onchain: token.state,
      onchainReadError: token.error ?? undefined,
      oracle,
      quoteOracle,
      registry,
    }));
  }

  const reasons = [...globalReasons];
  if (quoteOracle === null) {
    reasons.push("quote_oracle_feed_missing");
  } else {
    reasons.push(...quoteOracle.reasons.map((reason) => `quote_${reason}`));
  }
  for (const asset of assets) {
    if (!asset.executionEligible) {
      reasons.push(`asset_ineligible:${asset.registry.symbol}`);
    }
  }

  return {
    assets,
    blockHash: block.hash,
    blockNumber: block.number.toString(),
    blockTimestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
    chainId,
    executionEligible: reasons.length === 0,
    feedDirectory: feedSource.evidence,
    observedAt: new Date().toISOString(),
    quoteOracle,
    reasons: [...new Set(reasons)],
    registry: registrySource.evidence,
    schemaVersion: 1,
    sequencer: {
      executionEligible: false,
      reasons: ["sequencer_feed_unavailable"],
      status: "unavailable",
    },
  };
}
