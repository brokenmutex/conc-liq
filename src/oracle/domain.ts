import type { CanonicalAsset } from "../domain.js";
import type { AccountingRunReference } from "../backtest/domain.js";
import type {
  OracleFeedMetadata,
  OracleRoundState,
  SourceEvidence,
  TokenRiskState,
} from "../risk/domain.js";

export interface OracleValuationMark {
  readonly blockNumber: string;
  readonly blockTimestamp: string;
  readonly deviationPpm: string | null;
  readonly oraclePriceX18: string | null;
  readonly poolPriceX18: string;
  readonly quoteOracle: OracleRoundState | null;
  readonly quoteOracleAgeSeconds: number | null;
  readonly quoteOracleReadError: string | null;
  readonly reasons: readonly string[];
  readonly rwaOracle: OracleRoundState | null;
  readonly rwaOracleAgeSeconds: number | null;
  readonly rwaOracleReadError: string | null;
  readonly status: "valid" | "excluded";
  readonly token: TokenRiskState | null;
  readonly tokenDecimals: number | null;
  readonly tokenDecimalsReadError: string | null;
  readonly tokenReadError: string | null;
}

export interface OracleCalibrationMark extends OracleValuationMark {
  readonly accountingRunId: string;
}

export interface OracleCalibrationRun {
  readonly assumptions: readonly string[];
  readonly calibrationHash: string;
  readonly computedAt: string;
  readonly executionEligible: false;
  readonly excludedMarks: number;
  readonly feedDirectory: SourceEvidence;
  readonly fee: number;
  readonly first: AccountingRunReference;
  readonly last: AccountingRunReference;
  readonly marks: readonly OracleCalibrationMark[];
  readonly maxPriceAgeSeconds: number;
  readonly methodology: "block_pinned_multiplier_adjusted_oracle_basis_v1";
  readonly poolAddress: string;
  readonly quoteDecimals: 6;
  readonly quoteFeed: OracleFeedMetadata;
  readonly quoteToken: string;
  readonly registry: SourceEvidence;
  readonly registryAsset: CanonicalAsset;
  readonly rwaFeed: OracleFeedMetadata;
  readonly rwaSymbol: string;
  readonly schemaVersion: 2;
  readonly streamKey: string;
  readonly token0: string;
  readonly token1: string;
  readonly validMarks: number;
}
