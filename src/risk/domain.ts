import type { Address, Hash } from "viem";
import type { CanonicalAsset } from "../domain.js";

export interface SourceEvidence {
  readonly fetchedAt: string;
  readonly sha256: string;
  readonly url: string;
}

export interface MarketSessionSnapshot {
  readonly evidence: SourceEvidence;
  readonly executionEligible: boolean;
  readonly policy: "robinhood_stock_tokens_24_7";
  readonly reasons: readonly string[];
  readonly status: "open_24_7" | "unverified";
}

export interface OracleFeedMetadata {
  readonly address: Address;
  readonly baseAsset: string;
  readonly decimals: number;
  readonly heartbeatSeconds: number;
  readonly marketHours: string | null;
  readonly name: string;
  readonly productTypeCode: string;
  readonly quoteAsset: string;
}

export interface OracleRoundState {
  readonly answer: string;
  readonly answeredInRound: string;
  readonly codeHash: Hash;
  readonly decimals: number;
  readonly description: string;
  readonly roundId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface OracleRiskSnapshot {
  readonly executionEligible: boolean;
  readonly feed: OracleFeedMetadata;
  readonly flags: {
    readonly answerPositive: boolean;
    readonly decimalsMatch: boolean;
    readonly descriptionMatches: boolean;
    readonly priceFresh: boolean;
    readonly roundComplete: boolean;
    readonly timestampNotFuture: boolean;
  } | null;
  readonly maxAgeSeconds: number;
  readonly priceAgeSeconds: number | null;
  readonly readError: string | null;
  readonly reasons: readonly string[];
  readonly state: OracleRoundState | null;
}

export interface TokenRiskState {
  readonly codeHash: Hash;
  readonly effectiveAt: string;
  readonly newUIMultiplier: string;
  readonly oraclePaused: boolean;
  readonly uiMultiplier: string;
}

export interface AssetRiskSnapshot {
  readonly executionEligible: boolean;
  readonly flags: {
    readonly corporateActionPending: boolean;
    readonly multiplierConsistent: boolean;
    readonly registryActive: boolean;
    readonly tradingCapabilitiesComplete: boolean;
    readonly tradingCapabilitiesTradable: boolean;
  };
  readonly onchain: TokenRiskState | null;
  readonly onchainReadError: string | null;
  readonly oracle: OracleRiskSnapshot | null;
  readonly reasons: readonly string[];
  readonly registry: CanonicalAsset;
}

export interface RiskSnapshot {
  readonly assets: readonly AssetRiskSnapshot[];
  readonly blockHash: Hash;
  readonly blockNumber: string;
  readonly blockTimestamp: string;
  readonly chainId: number;
  readonly executionEligible: boolean;
  readonly feedDirectory: SourceEvidence;
  readonly marketSession: MarketSessionSnapshot;
  readonly observedAt: string;
  readonly quoteOracle: OracleRiskSnapshot | null;
  readonly reasons: readonly string[];
  readonly registry: SourceEvidence;
  readonly schemaVersion: 2;
  readonly sequencer: {
    readonly executionEligible: false;
    readonly reasons: readonly ["sequencer_feed_unavailable"];
    readonly status: "unavailable";
  };
}
