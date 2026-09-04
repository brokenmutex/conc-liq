import type { Address } from "viem";
import type { AccountingRunReference, AccountingRunSource } from "../backtest/domain.js";
import type { PrincipalRegion } from "../backtest/principal.js";

export interface NftPoolSource {
  readonly fee: number;
  readonly feeGrowthGlobal0X128: bigint;
  readonly feeGrowthGlobal1X128: bigint;
  readonly poolAddress: Address;
  readonly rwaSymbol: string;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly token0: Address;
  readonly token1: Address;
}

export interface NftTickSource {
  readonly feeGrowthOutside0X128: bigint;
  readonly feeGrowthOutside1X128: bigint;
  readonly poolAddress: Address;
  readonly tick: number;
}

export interface NftSourceInput {
  readonly pools: readonly NftPoolSource[];
  readonly run: AccountingRunSource;
  readonly streamKey: string;
  readonly ticks: readonly NftTickSource[];
}

export interface NftPositionState {
  readonly fee: number;
  readonly feeGrowthInside0LastX128: bigint;
  readonly feeGrowthInside1LastX128: bigint;
  readonly liquidity: bigint;
  readonly nonce: bigint;
  readonly operator: Address;
  readonly ownerAddress: Address;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly token0: Address;
  readonly token1: Address;
  readonly tokenId: bigint;
  readonly tokensOwed0: bigint;
  readonly tokensOwed1: bigint;
}

export interface NftPositionSnapshot {
  readonly claimable0: string;
  readonly claimable1: string;
  readonly computedAt: string;
  readonly currentTick: number;
  readonly executionEligible: false;
  readonly fee: number;
  readonly feeGrowthInside0LastX128: string;
  readonly feeGrowthInside0X128: string | null;
  readonly feeGrowthInside1LastX128: string;
  readonly feeGrowthInside1X128: string | null;
  readonly liquidity: string;
  readonly methodology: "npm_position_value_exact";
  readonly nonce: string;
  readonly operator: Address;
  readonly ownerAddress: Address;
  readonly pending0: string;
  readonly pending1: string;
  readonly poolAddress: Address;
  readonly positionManager: Address;
  readonly principal0: string;
  readonly principal1: string;
  readonly region: PrincipalRegion | "empty";
  readonly run: AccountingRunReference;
  readonly rwaSymbol: string;
  readonly schemaVersion: 1;
  readonly sqrtPriceX96: string;
  readonly streamKey: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly token0: Address;
  readonly token0Decimals: number;
  readonly token1: Address;
  readonly token1Decimals: number;
  readonly tokenId: string;
  readonly tokensOwed0: string;
  readonly tokensOwed1: string;
}
