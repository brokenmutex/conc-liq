import { calculatePositionFees, feeGrowthInside } from "../accounting/math.js";
import { principalAmounts } from "../backtest/principal.js";
import type {
  NftPoolSource,
  NftPositionSnapshot,
  NftPositionState,
  NftTickSource,
} from "./domain.js";
import type { AccountingRunReference } from "../backtest/domain.js";
import type { Address } from "viem";

function addressKey(address: string): string {
  return address.toLowerCase();
}

function tickKey(poolAddress: string, tick: number): string {
  return `${addressKey(poolAddress)}:${tick}`;
}

function findPool(
  pools: readonly NftPoolSource[],
  position: NftPositionState,
): NftPoolSource {
  const matches = pools.filter((pool) =>
    addressKey(pool.token0) === addressKey(position.token0) &&
    addressKey(pool.token1) === addressKey(position.token1) &&
    pool.fee === position.fee
  );
  if (matches.length !== 1) {
    throw new Error(
      `NFT ${position.tokenId} does not resolve to exactly one monitored pool`,
    );
  }
  return matches[0]!;
}

function requireDecimals(value: number, token: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`Token ${token} decimals are invalid`);
  }
}

export function evaluateNftPosition(input: {
  readonly position: NftPositionState;
  readonly pools: readonly NftPoolSource[];
  readonly positionManager: Address;
  readonly run: AccountingRunReference;
  readonly streamKey: string;
  readonly ticks: readonly NftTickSource[];
  readonly token0Decimals: number;
  readonly token1Decimals: number;
}): NftPositionSnapshot {
  if (input.position.tokenId <= 0n) throw new Error("NFT token ID must be positive");
  requireDecimals(input.token0Decimals, input.position.token0);
  requireDecimals(input.token1Decimals, input.position.token1);
  const pool = findPool(input.pools, input.position);
  const ticks = new Map(input.ticks.map((tick) => [
    tickKey(tick.poolAddress, tick.tick),
    tick,
  ]));
  let claimable0 = input.position.tokensOwed0;
  let claimable1 = input.position.tokensOwed1;
  let feeGrowthInside0X128: bigint | null = null;
  let feeGrowthInside1X128: bigint | null = null;
  let pending0 = 0n;
  let pending1 = 0n;
  let principal0 = 0n;
  let principal1 = 0n;
  let region: NftPositionSnapshot["region"] = "empty";
  if (input.position.liquidity > 0n) {
    const lower = ticks.get(tickKey(pool.poolAddress, input.position.tickLower));
    const upper = ticks.get(tickKey(pool.poolAddress, input.position.tickUpper));
    if (lower === undefined || upper === undefined) {
      throw new Error(
        `Active NFT ${input.position.tokenId} has incomplete boundary tick state`,
      );
    }
    feeGrowthInside0X128 = feeGrowthInside({
      currentTick: pool.tick,
      feeGrowthGlobalX128: pool.feeGrowthGlobal0X128,
      lowerFeeGrowthOutsideX128: lower.feeGrowthOutside0X128,
      tickLower: input.position.tickLower,
      tickUpper: input.position.tickUpper,
      upperFeeGrowthOutsideX128: upper.feeGrowthOutside0X128,
    });
    feeGrowthInside1X128 = feeGrowthInside({
      currentTick: pool.tick,
      feeGrowthGlobalX128: pool.feeGrowthGlobal1X128,
      lowerFeeGrowthOutsideX128: lower.feeGrowthOutside1X128,
      tickLower: input.position.tickLower,
      tickUpper: input.position.tickUpper,
      upperFeeGrowthOutsideX128: upper.feeGrowthOutside1X128,
    });
    const fees = calculatePositionFees({
      feeGrowthInside0LastX128: input.position.feeGrowthInside0LastX128,
      feeGrowthInside0X128,
      feeGrowthInside1LastX128: input.position.feeGrowthInside1LastX128,
      feeGrowthInside1X128,
      liquidity: input.position.liquidity,
      tokensOwed0: input.position.tokensOwed0,
      tokensOwed1: input.position.tokensOwed1,
    });
    claimable0 = fees.claimable0;
    claimable1 = fees.claimable1;
    pending0 = fees.pending0;
    pending1 = fees.pending1;
    const principal = principalAmounts({
      liquidity: input.position.liquidity,
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower: input.position.tickLower,
      tickUpper: input.position.tickUpper,
    });
    principal0 = principal.amount0;
    principal1 = principal.amount1;
    region = principal.region;
  }
  return {
    claimable0: claimable0.toString(),
    claimable1: claimable1.toString(),
    computedAt: new Date().toISOString(),
    currentTick: pool.tick,
    executionEligible: false,
    fee: pool.fee,
    feeGrowthInside0LastX128:
      input.position.feeGrowthInside0LastX128.toString(),
    feeGrowthInside0X128: feeGrowthInside0X128?.toString() ?? null,
    feeGrowthInside1LastX128:
      input.position.feeGrowthInside1LastX128.toString(),
    feeGrowthInside1X128: feeGrowthInside1X128?.toString() ?? null,
    liquidity: input.position.liquidity.toString(),
    methodology: "npm_position_value_exact",
    nonce: input.position.nonce.toString(),
    operator: input.position.operator,
    ownerAddress: input.position.ownerAddress,
    pending0: pending0.toString(),
    pending1: pending1.toString(),
    poolAddress: pool.poolAddress,
    positionManager: input.positionManager,
    principal0: principal0.toString(),
    principal1: principal1.toString(),
    region,
    run: input.run,
    rwaSymbol: pool.rwaSymbol,
    schemaVersion: 1,
    sqrtPriceX96: pool.sqrtPriceX96.toString(),
    streamKey: input.streamKey,
    tickLower: input.position.tickLower,
    tickUpper: input.position.tickUpper,
    token0: pool.token0,
    token0Decimals: input.token0Decimals,
    token1: pool.token1,
    token1Decimals: input.token1Decimals,
    tokenId: input.position.tokenId.toString(),
    tokensOwed0: input.position.tokensOwed0.toString(),
    tokensOwed1: input.position.tokensOwed1.toString(),
  };
}
