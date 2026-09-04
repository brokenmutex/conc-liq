import type { RangePoolCheckpoint, RangeReplayInterval } from "../simulator/domain.js";

export interface OraclePolicyCheckpointReference {
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly blockTimestamp: string;
  readonly capturedAt: string;
  readonly chainId: number;
  readonly checkpointRunId: string;
  readonly riskRunId: string;
}

export interface OraclePolicyCheckpoint {
  readonly oraclePriceX18: bigint | null;
  readonly pool: RangePoolCheckpoint;
  readonly poolPriceX18: bigint;
  readonly reasons: readonly string[];
  readonly run: OraclePolicyCheckpointReference;
  readonly status: "valid" | "excluded";
  readonly tokenDecimals: number;
}

export interface OraclePolicyReplaySource {
  readonly checkpoints: readonly OraclePolicyCheckpoint[];
  readonly fee: number;
  readonly indexedThroughBlock: bigint;
  readonly intervals: readonly RangeReplayInterval[];
  readonly poolAddress: string;
  readonly quoteToken: string;
  readonly rwaAddress: string;
  readonly rwaDecimals: number;
  readonly rwaSymbol: string;
  readonly streamKey: string;
  readonly targetSetHash: string;
  readonly token0: string;
  readonly token1: string;
}

export interface OraclePolicyReplayStep {
  readonly actionCostQuote: string;
  readonly activeTickLower: number;
  readonly activeTickUpper: number;
  readonly endAmount0: string;
  readonly endAmount1: string;
  readonly endingTickLower: number;
  readonly endingTickUpper: number;
  readonly fee0: string;
  readonly fee1: string;
  readonly feeValueQuote: string;
  readonly fromCheckpointRunId: string;
  readonly hodlValueQuote: string;
  readonly index: number;
  readonly lpAlphaQuote: string;
  readonly navQuote: string;
  readonly oraclePriceX18: string;
  readonly pathMaxTick: number;
  readonly pathMinTick: number;
  readonly poolPriceX18: string;
  readonly poolSpotNavBeforeActionQuote: string;
  readonly rebalanced: boolean;
  readonly toCheckpointRunId: string;
}

export interface OraclePolicyReplayCandidate {
  readonly absolutePnlQuote: string | null;
  readonly completedIntervals: number;
  readonly failureCheckpointRunId: string | null;
  readonly failureReason: string | null;
  readonly finalAmount0: string | null;
  readonly finalAmount1: string | null;
  readonly finalLiquidity: string | null;
  readonly finalNavQuote: string | null;
  readonly finalTickLower: number | null;
  readonly finalTickUpper: number | null;
  readonly halfWidthSpacings: number;
  readonly hodlEndValueQuote: string | null;
  readonly initialAmount0: string | null;
  readonly initialAmount1: string | null;
  readonly initialNavQuote: string | null;
  readonly lpAlphaQuote: string | null;
  readonly markedFeeValueQuote: string;
  readonly maxDrawdownPpm: string;
  readonly rank: number | null;
  readonly rebalances: number;
  readonly status: "complete" | "excluded";
  readonly steps: readonly OraclePolicyReplayStep[];
  readonly totalCostQuote: string;
}

export interface OraclePolicyReplay {
  readonly assumptions: readonly string[];
  readonly budgetQuote: string;
  readonly candidates: readonly OraclePolicyReplayCandidate[];
  readonly checkpointCount: number;
  readonly completedCandidates: number;
  readonly computedAt: string;
  readonly entryCostQuote: string;
  readonly excludedCandidates: number;
  readonly executionEligible: false;
  readonly fee: number;
  readonly first: OraclePolicyCheckpointReference;
  readonly indexedThroughBlock: string;
  readonly intervalCount: number;
  readonly last: OraclePolicyCheckpointReference;
  readonly methodology: "oracle_marked_stateful_certified_replay_v1";
  readonly policySetHash: string;
  readonly poolAddress: string;
  readonly quoteDecimals: 6;
  readonly quoteToken: string;
  readonly rebalanceCostQuote: string;
  readonly rwaAddress: string;
  readonly rwaDecimals: number;
  readonly rwaSymbol: string;
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly targetSetHash: string;
  readonly tickSpacing: number;
  readonly token0: string;
  readonly token1: string;
  readonly triggerPercent: number;
}
