export const PERP_REFERENCE_SOURCE = "hyperliquid_info_api" as const;
export const PERP_REFERENCE_METHOD = "xyz_hip3_shadow_quality_v1" as const;
export const PERP_WEEKEND_METHOD = "xyz_weekend_reopen_assessment_v1" as const;

export type ExpectedPricingMode =
  | "scheduled_internal_weekend"
  | "external_session_expected";

export interface PerpReferenceEvidence {
  readonly fetchedAt: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly sha256: `sha256:${string}`;
  readonly url: string;
}

export interface HyperliquidPerpAsset {
  readonly isDelisted: boolean;
  readonly marginMode: string | null;
  readonly maxLeverage: number;
  readonly name: string;
  readonly onlyIsolated: boolean;
  readonly szDecimals: number;
}

export interface HyperliquidPerpContext {
  readonly dayBaseVolume: string;
  readonly dayNotionalVolume: string;
  readonly funding: string;
  readonly impactPrices: readonly [string, string] | null;
  readonly markPrice: string;
  readonly midPrice: string | null;
  readonly openInterest: string;
  readonly oraclePrice: string;
  readonly premium: string | null;
  readonly previousDayPrice: string;
}

export interface PerpMarketContextSource {
  readonly asset: HyperliquidPerpAsset;
  readonly assetIndex: number;
  readonly context: HyperliquidPerpContext;
  readonly evidence: PerpReferenceEvidence;
}

export interface PerpReferenceQualityConfig {
  readonly maxImpactSpreadPpm: bigint;
  readonly maxMarkOracleDeviationPpm: bigint;
  readonly maxMidOracleDeviationPpm: bigint;
  readonly minDayNotionalUsdX18: bigint;
  readonly minOpenInterestNotionalUsdX18: bigint;
}

export interface PerpReferenceSnapshot {
  readonly asset: HyperliquidPerpAsset;
  readonly assetIndex: number;
  readonly coin: string;
  readonly context: HyperliquidPerpContext;
  readonly dex: string;
  readonly evidence: PerpReferenceEvidence;
  readonly executionEligible: false;
  readonly expectedPricingMode: ExpectedPricingMode;
  readonly flags: {
    readonly assetActive: boolean;
    readonly dayVolumeSufficient: boolean;
    readonly impactPricesValid: boolean;
    readonly impactSpreadBounded: boolean;
    readonly markOracleAligned: boolean;
    readonly midOracleAligned: boolean;
    readonly openInterestSufficient: boolean;
    readonly pricesPositive: boolean;
  };
  readonly limitations: readonly string[];
  readonly methodology: typeof PERP_REFERENCE_METHOD;
  readonly metrics: {
    readonly dayNotionalUsdX18: string;
    readonly impactSpreadPpm: string | null;
    readonly markOracleDeviationPpm: string | null;
    readonly midOracleDeviationPpm: string | null;
    readonly openInterestNotionalUsdX18: string;
    readonly oraclePriceX18: string;
  };
  readonly observedAt: string;
  readonly qualityPass: boolean;
  readonly reasons: readonly string[];
  readonly schemaVersion: 1;
  readonly source: typeof PERP_REFERENCE_SOURCE;
  readonly status: "observed" | "quality_rejected";
  readonly thresholds: {
    readonly maxImpactSpreadPpm: string;
    readonly maxMarkOracleDeviationPpm: string;
    readonly maxMidOracleDeviationPpm: string;
    readonly minDayNotionalUsdX18: string;
    readonly minOpenInterestNotionalUsdX18: string;
  };
}

export interface RawPerpCandle {
  readonly close: string;
  readonly closeTimeMs: number;
  readonly high: string;
  readonly interval: "1h";
  readonly low: string;
  readonly open: string;
  readonly openTimeMs: number;
  readonly symbol: string;
  readonly tradeCount: number;
  readonly volume: string;
}

export interface PerpCandle {
  readonly closePriceX18: string;
  readonly closeTimeMs: number;
  readonly highPriceX18: string;
  readonly interval: "1h";
  readonly lowPriceX18: string;
  readonly openPriceX18: string;
  readonly openTimeMs: number;
  readonly raw: RawPerpCandle;
  readonly tradeCount: string;
  readonly volumeX18: string;
}

export interface PerpCandleSource {
  readonly candles: readonly PerpCandle[];
  readonly evidence: PerpReferenceEvidence;
  readonly fromTimeMs: number;
  readonly interval: "1h";
  readonly toTimeMs: number;
}

export interface WeekendSessionAssessment {
  readonly baseVolumeX18: string;
  readonly candleCount: number;
  readonly directionCorrect: boolean | null;
  readonly externalClosePriceX18: string | null;
  readonly internalEndMs: number;
  readonly internalStartMs: number;
  readonly maxDownExcursionPpm: string | null;
  readonly maxUpExcursionPpm: string | null;
  readonly reasons: readonly string[];
  readonly reopenGapPpm: string | null;
  readonly reopenPriceX18: string | null;
  readonly reopenTimeMs: number | null;
  readonly sessionKey: string;
  readonly status: "complete" | "excluded";
  readonly tradeCount: string;
  readonly weekendClosePriceX18: string | null;
  readonly weekendMovePpm: string | null;
}

export interface WeekendAssessmentSummary {
  readonly completeSessions: number;
  readonly directionCorrectPpm: string | null;
  readonly excludedSessions: number;
  readonly maxAbsReopenGapPpm: string | null;
  readonly medianAbsReopenGapPpm: string | null;
  readonly p90AbsReopenGapPpm: string | null;
  readonly sessions: number;
}

export interface PerpWeekendAssessment {
  readonly assumptions: readonly string[];
  readonly candleCount: number;
  readonly coin: string;
  readonly computedAt: string;
  readonly dex: string;
  readonly evidence: PerpReferenceEvidence;
  readonly executionEligible: false;
  readonly fromTimeMs: number;
  readonly interval: "1h";
  readonly methodology: typeof PERP_WEEKEND_METHOD;
  readonly schemaVersion: 1;
  readonly sessions: readonly WeekendSessionAssessment[];
  readonly source: typeof PERP_REFERENCE_SOURCE;
  readonly summary: WeekendAssessmentSummary;
  readonly toTimeMs: number;
}
