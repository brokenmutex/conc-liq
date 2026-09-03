import type { Hash } from "viem";

export interface ReplayCoordinate {
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
  readonly logIndex: number;
}

export interface ReplayCursor {
  readonly streamKey: string;
  readonly chainId: number;
  readonly targetSetHash: Hash;
  readonly last: ReplayCoordinate | null;
  readonly eventsApplied: bigint;
  readonly completeThroughBlock: bigint | null;
  readonly completeThroughHash: Hash | null;
}

export interface ReplaySource {
  readonly streamKey: string;
  readonly chainId: number;
  readonly targetSetHash: Hash;
  readonly lastScannedBlock: bigint;
  readonly lastScannedHash: Hash;
}

export interface StoredReplayEvent extends ReplayCoordinate {
  readonly poolAddress: string;
  readonly eventName: string;
  readonly args: unknown;
}

export interface ReplayPoolState {
  readonly poolAddress: string;
  readonly chainId: number;
  readonly rwaSymbol: string;
  readonly fee: number;
  initialized: boolean;
  sqrtPriceX96: bigint | null;
  tick: number | null;
  liquidity: bigint;
  observationCardinalityNext: number | null;
  feeProtocol0: number;
  feeProtocol1: number;
  eventCount: bigint;
  mintCount: bigint;
  burnCount: bigint;
  swapCount: bigint;
  collectCount: bigint;
  flashCount: bigint;
  lastEventBlock: bigint | null;
  lastEventTransactionIndex: number | null;
  lastEventLogIndex: number | null;
}

export interface ReplayTickState {
  readonly poolAddress: string;
  readonly tick: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
}

export interface ReplayPositionState {
  readonly poolAddress: string;
  readonly ownerAddress: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  liquidity: bigint;
  mintedLiquidity: bigint;
  burnedLiquidity: bigint;
  mintedAmount0: bigint;
  mintedAmount1: bigint;
  burnedAmount0: bigint;
  burnedAmount1: bigint;
  collectedAmount0: bigint;
  collectedAmount1: bigint;
}

export interface ReplayChanges {
  readonly pools: readonly ReplayPoolState[];
  readonly positions: readonly ReplayPositionState[];
  readonly ticks: readonly ReplayTickState[];
  readonly deletedTicks: readonly { poolAddress: string; tick: number }[];
}
