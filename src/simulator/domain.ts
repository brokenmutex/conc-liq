import type { AccountingRunReference, AccountingRunSource } from "../backtest/domain.js";

export interface RangePoolCheckpoint {
  readonly feeGrowthGlobal0X128: bigint;
  readonly feeGrowthGlobal1X128: bigint;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
}

export interface RangeSimulationSource {
  readonly fee: number;
  readonly from: AccountingRunSource;
  readonly fromPool: RangePoolCheckpoint;
  readonly pathMaxTick: number;
  readonly pathMinTick: number;
  readonly poolAddress: string;
  readonly quoteToken: string;
  readonly rwaSymbol: string;
  readonly streamKey: string;
  readonly swapCount: bigint;
  readonly to: AccountingRunSource;
  readonly toPool: RangePoolCheckpoint;
  readonly token0: string;
  readonly token1: string;
}

export interface CanonicalRangeSimulationSource extends Omit<
  RangeSimulationSource,
  "from" | "to"
> {
  readonly from: AccountingRunReference;
  readonly to: AccountingRunReference;
}

export interface RangePolicyCandidate {
  readonly absolutePnlQuote: string | null;
  readonly divergenceQuote: string | null;
  readonly endAmount0: string | null;
  readonly endAmount1: string | null;
  readonly endPrincipalValueQuote: string | null;
  readonly exclusionReason: string | null;
  readonly fee0: string | null;
  readonly fee1: string | null;
  readonly feeValueQuote: string | null;
  readonly grossEndValueQuote: string | null;
  readonly halfWidthSpacings: number;
  readonly hodlEndValueQuote: string | null;
  readonly idleQuote: string;
  readonly liquidity: string;
  readonly liquiditySharePpm: string;
  readonly lpAlphaQuote: string | null;
  readonly netEndValueQuote: string | null;
  readonly rank: number | null;
  readonly startAmount0: string;
  readonly startAmount1: string;
  readonly status: "complete" | "excluded";
  readonly tickLower: number;
  readonly tickUpper: number;
}

export interface RangePolicySimulation {
  readonly assumptions: readonly string[];
  readonly budgetQuote: string;
  readonly candidates: readonly RangePolicyCandidate[];
  readonly completedCandidates: number;
  readonly computedAt: string;
  readonly costQuote: string;
  readonly excludedCandidates: number;
  readonly executionEligible: false;
  readonly fee: number;
  readonly from: AccountingRunReference;
  readonly methodology: "static_centered_observed_fee_growth_v1";
  readonly pathMaxTick: number;
  readonly pathMinTick: number;
  readonly policySetHash: string;
  readonly poolAddress: string;
  readonly quoteDecimals: 6;
  readonly quoteToken: string;
  readonly rwaSymbol: string;
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly swapCount: string;
  readonly tickSpacing: number;
  readonly to: AccountingRunReference;
  readonly token0: string;
  readonly token1: string;
}

export interface RangeReplayCheckpoint {
  readonly pool: RangePoolCheckpoint;
  readonly run: AccountingRunSource;
}

export interface CanonicalRangeReplayCheckpoint extends Omit<
  RangeReplayCheckpoint,
  "run"
> {
  readonly run: AccountingRunReference;
}

export interface RangeReplayInterval {
  readonly fromRunId: string;
  readonly pathMaxTick: number;
  readonly pathMinTick: number;
  readonly swapCount: bigint;
  readonly toRunId: string;
}

export interface RangePolicyReplaySource {
  readonly checkpoints: readonly RangeReplayCheckpoint[];
  readonly fee: number;
  readonly intervals: readonly RangeReplayInterval[];
  readonly poolAddress: string;
  readonly quoteToken: string;
  readonly rwaSymbol: string;
  readonly streamKey: string;
  readonly token0: string;
  readonly token1: string;
}

export interface CanonicalRangePolicyReplaySource extends Omit<
  RangePolicyReplaySource,
  "checkpoints"
> {
  readonly checkpoints: readonly CanonicalRangeReplayCheckpoint[];
}

export interface RangePolicyReplayStep {
  readonly actionCostQuote: string;
  readonly fee0: string;
  readonly fee1: string;
  readonly feeValueQuote: string;
  readonly fromRunId: string;
  readonly hodlValueQuote: string;
  readonly index: number;
  readonly lpAlphaQuote: string;
  readonly navQuote: string;
  readonly pathMaxTick: number;
  readonly pathMinTick: number;
  readonly rebalanced: boolean;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly toRunId: string;
}

export interface RangePolicyReplayCandidate {
  readonly absolutePnlQuote: string | null;
  readonly completedIntervals: number;
  readonly failureReason: string | null;
  readonly failureRunId: string | null;
  readonly feeValueQuote: string;
  readonly finalLiquidity: string | null;
  readonly finalNavQuote: string | null;
  readonly finalTickLower: number | null;
  readonly finalTickUpper: number | null;
  readonly halfWidthSpacings: number;
  readonly hodlEndValueQuote: string | null;
  readonly lpAlphaQuote: string | null;
  readonly maxDrawdownPpm: string;
  readonly rank: number | null;
  readonly rebalances: number;
  readonly status: "complete" | "excluded";
  readonly steps: readonly RangePolicyReplayStep[];
  readonly totalCostQuote: string;
}

export interface RangePolicyReplay {
  readonly assumptions: readonly string[];
  readonly budgetQuote: string;
  readonly candidates: readonly RangePolicyReplayCandidate[];
  readonly checkpointCount: number;
  readonly completedCandidates: number;
  readonly computedAt: string;
  readonly entryCostQuote: string;
  readonly excludedCandidates: number;
  readonly executionEligible: false;
  readonly fee: number;
  readonly first: AccountingRunReference;
  readonly intervalCount: number;
  readonly last: AccountingRunReference;
  readonly methodology: "stateful_certified_interval_replay_v1";
  readonly policySetHash: string;
  readonly poolAddress: string;
  readonly quoteDecimals: 6;
  readonly quoteToken: string;
  readonly rebalanceCostQuote: string;
  readonly rwaSymbol: string;
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly tickSpacing: number;
  readonly token0: string;
  readonly token1: string;
  readonly triggerPercent: number;
}
