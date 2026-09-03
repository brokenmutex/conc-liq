import type { Address, Hash } from "viem";

export interface AccountingSourcePool {
  readonly chainId: number;
  readonly fee: number;
  readonly liquidity: bigint;
  readonly poolAddress: Address;
  readonly rwaSymbol: string;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
}

export interface AccountingSourceTick {
  readonly liquidityGross: bigint;
  readonly liquidityNet: bigint;
  readonly poolAddress: Address;
  readonly tick: number;
}

export interface AccountingSourcePosition {
  readonly liquidity: bigint;
  readonly ownerAddress: Address;
  readonly poolAddress: Address;
  readonly tickLower: number;
  readonly tickUpper: number;
}

export interface AccountingSourceSnapshot {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly chainId: number;
  readonly eventsApplied: bigint;
  readonly pools: readonly AccountingSourcePool[];
  readonly positions: readonly AccountingSourcePosition[];
  readonly streamKey: string;
  readonly ticks: readonly AccountingSourceTick[];
}

export interface TickFeeState extends AccountingSourceTick {
  readonly feeGrowthOutside0X128: bigint;
  readonly feeGrowthOutside1X128: bigint;
}

export interface PositionFeeState extends AccountingSourcePosition {
  readonly claimable0: bigint;
  readonly claimable1: bigint;
  readonly feeGrowthInside0LastX128: bigint;
  readonly feeGrowthInside0X128: bigint | null;
  readonly feeGrowthInside1LastX128: bigint;
  readonly feeGrowthInside1X128: bigint | null;
  readonly pending0: bigint;
  readonly pending1: bigint;
  readonly tokensOwed0: bigint;
  readonly tokensOwed1: bigint;
}

export interface PoolFeeState extends AccountingSourcePool {
  readonly activePositions: number;
  readonly claimable0: bigint;
  readonly claimable1: bigint;
  readonly feeGrowthGlobal0X128: bigint;
  readonly feeGrowthGlobal1X128: bigint;
  readonly pending0: bigint;
  readonly pending1: bigint;
  readonly positions: number;
  readonly token0: Address;
  readonly token1: Address;
  readonly tokensOwed0: bigint;
  readonly tokensOwed1: bigint;
}

export interface FeeAccountingSnapshot {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly chainId: number;
  readonly eventsApplied: bigint;
  readonly observedAt: string;
  readonly pools: readonly PoolFeeState[];
  readonly positions: readonly PositionFeeState[];
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly ticks: readonly TickFeeState[];
}
