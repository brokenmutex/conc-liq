import type { ExpectedPricingMode } from "../perp-reference/domain.js";

export const PERP_BASIS_METHOD = "perp_pool_basis_shadow_v1" as const;

export interface PerpBasisConfig {
  readonly maxPoolDeviationPpm: bigint;
  readonly maxQuoteDepegPpm: bigint;
  readonly maxQuoteOracleAgeSeconds: number;
  readonly maxSourceAgeSeconds: number;
  readonly maxSourceSkewSeconds: number;
}

export interface PerpBasisTokenState {
  readonly effectiveAt: string;
  readonly newUiMultiplierX18: string;
  readonly oraclePaused: boolean;
  readonly uiMultiplierX18: string;
}

export interface PerpBasisQuoteOracle {
  readonly answer: string;
  readonly answeredInRound: string;
  readonly baseAsset: string;
  readonly decimals: number;
  readonly decimalsMatch: boolean;
  readonly descriptionMatches: boolean;
  readonly feedAddress: string;
  readonly heartbeatSeconds: number;
  readonly quoteAsset: string;
  readonly roundComplete: boolean;
  readonly roundId: string;
  readonly timestampNotFuture: boolean;
  readonly updatedAt: string;
}

export interface PerpBasisSource {
  readonly asset: {
    readonly corporateActionPending: boolean;
    readonly currentMultiplier: string;
    readonly multiplierConsistent: boolean;
    readonly pendingMultiplier: string | null;
    readonly registryActive: boolean;
    readonly registryAddress: string;
    readonly token: PerpBasisTokenState | null;
    readonly tokenAddress: string;
    readonly tradingCapabilitiesComplete: boolean;
    readonly tradingCapabilitiesTradable: boolean;
  };
  readonly chain: {
    readonly blockHash: string;
    readonly blockNumber: string;
    readonly blockTimestamp: string;
    readonly canonical: boolean;
    readonly canonicalBlockNumber: string | null;
    readonly canonicalExpectedHash: string | null;
    readonly canonicalObservedHash: string | null;
    readonly capturedAt: string;
    readonly chainlinkOraclePriceX18: string | null;
    readonly checkpointRunId: string;
    readonly fee: number;
    readonly liquidity: string;
    readonly poolAddress: string;
    readonly poolPriceX18: string;
    readonly poolReasons: readonly string[];
    readonly poolStatus: "excluded" | "valid";
    readonly poolUnlocked: boolean;
    readonly riskRunId: string;
    readonly rwaAddress: string;
    readonly rwaSymbol: string;
    readonly streamKey: string;
    readonly token0: string;
    readonly token1: string;
  };
  readonly perp: {
    readonly coin: string;
    readonly dex: string;
    readonly evidenceSha256: string;
    readonly expectedPricingMode: ExpectedPricingMode;
    readonly markPrice: string;
    readonly midPrice: string | null;
    readonly observedAt: string;
    readonly oraclePriceX18: string;
    readonly qualityPass: boolean;
    readonly reasons: readonly string[];
    readonly snapshotRunId: string;
    readonly status: "observed" | "quality_rejected";
  };
  readonly quoteOracle: PerpBasisQuoteOracle | null;
}

export type PerpBasisReferenceMode =
  | "chainlink_primary_comparison"
  | "perp_external_session_candidate"
  | "perp_internal_weekend_candidate";

export interface PerpBasisAssessment {
  readonly evaluatedAt: string;
  readonly executionEligible: false;
  readonly fallbackCandidate: boolean;
  readonly limitations: readonly string[];
  readonly methodology: typeof PERP_BASIS_METHOD;
  readonly metrics: {
    readonly chainlinkPerpDeviationPpm: string | null;
    readonly chainlinkPriceX18: string | null;
    readonly checkpointAgeSeconds: number | null;
    readonly multiplierX18: string | null;
    readonly perpMarkUsdX18: string;
    readonly perpMidUsdX18: string | null;
    readonly perpOracleUsdX18: string;
    readonly perpReferenceUsdX18: string;
    readonly perpSnapshotAgeSeconds: number | null;
    readonly poolPerpDeviationPpm: string | null;
    readonly poolPriceX18: string;
    readonly quoteOracleAgeSeconds: number | null;
    readonly sourceSkewSeconds: number;
    readonly tokenReferenceUsdX18: string | null;
    readonly tokenReferenceUsdgX18: string | null;
    readonly usdgUsdX18: string | null;
  };
  readonly primaryReferenceAvailable: boolean;
  readonly primaryReferenceReasons: readonly string[];
  readonly qualityPass: boolean;
  readonly reasons: readonly string[];
  readonly referenceMode: PerpBasisReferenceMode;
  readonly schemaVersion: 1;
  readonly source: PerpBasisSource;
  readonly status: "observed" | "quality_rejected";
  readonly thresholds: {
    readonly maxPoolDeviationPpm: string;
    readonly maxQuoteDepegPpm: string;
    readonly maxQuoteOracleAgeSeconds: number;
    readonly maxSourceAgeSeconds: number;
    readonly maxSourceSkewSeconds: number;
  };
}
