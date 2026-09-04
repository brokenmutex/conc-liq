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
