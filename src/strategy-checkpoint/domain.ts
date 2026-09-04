import type { Address, Hash } from "viem";
import type { OracleValuationMark } from "../oracle/domain.js";

export interface StrategyPoolState {
  readonly feeGrowthGlobal0X128: string;
  readonly feeGrowthGlobal1X128: string;
  readonly liquidity: string;
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly unlocked: boolean;
}

export interface StrategyPoolCheckpoint {
  readonly fee: number;
  readonly poolAddress: Address;
  readonly rwaAddress: Address;
  readonly rwaSymbol: string;
  readonly state: StrategyPoolState;
  readonly token0: Address;
  readonly token1: Address;
  readonly valuation: OracleValuationMark;
}

export interface StrategyCheckpointSnapshot {
  readonly assumptions: readonly string[];
  readonly blockHash: Hash;
  readonly blockNumber: string;
  readonly blockTimestamp: string;
  readonly capturedAt: string;
  readonly chainId: number;
  readonly excludedPools: number;
  readonly executionEligible: false;
  readonly methodology: "synchronized_risk_pool_checkpoint_v1";
  readonly pools: readonly StrategyPoolCheckpoint[];
  readonly riskObservedAt: string;
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly targetSetHash: Hash;
  readonly validPools: number;
}
