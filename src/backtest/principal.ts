import type { AccountingRunReference } from "./domain.js";

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MIN_SQRT_RATIO = 4_295_128_739n;
export const MAX_SQRT_RATIO =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
export const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

const TICK_MULTIPLIERS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
] as const;

export type PrincipalRegion = "above_range" | "below_range" | "in_range";

export interface PrincipalPositionSource {
  readonly liquidity: bigint;
  readonly ownerAddress: string;
  readonly tickLower: number;
  readonly tickUpper: number;
}

export interface PrincipalPoolSource {
  readonly activePositions: number;
  readonly fee: number;
  readonly poolAddress: string;
  readonly positions: readonly PrincipalPositionSource[];
  readonly rwaSymbol: string;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly token0: string;
  readonly token1: string;
}

export interface PrincipalPositionSnapshot extends PrincipalPositionSource {
  readonly amount0: string;
  readonly amount1: string;
  readonly poolAddress: string;
  readonly region: PrincipalRegion;
  readonly sqrtRatioLowerX96: string;
  readonly sqrtRatioUpperX96: string;
}

export interface PrincipalPoolSnapshot {
  readonly aboveRangePositions: number;
  readonly amount0: string;
  readonly amount1: string;
  readonly belowRangePositions: number;
  readonly fee: number;
  readonly inRangePositions: number;
  readonly poolAddress: string;
  readonly positionCount: number;
  readonly rwaSymbol: string;
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly token0: string;
  readonly token1: string;
}

export interface PrincipalSnapshot {
  readonly computedAt: string;
  readonly executionEligible: false;
  readonly methodology: "canonical_liquidity_amounts_floor";
  readonly pools: readonly PrincipalPoolSnapshot[];
  readonly positions: readonly PrincipalPositionSnapshot[];
  readonly run: AccountingRunReference;
  readonly schemaVersion: 1;
  readonly streamKey: string;
  readonly totals: {
    readonly aboveRangePositions: number;
    readonly belowRangePositions: number;
    readonly inRangePositions: number;
    readonly positionCount: number;
  };
}

function requireTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`Tick ${tick} is outside the canonical Uniswap V3 range`);
  }
}

export function sqrtRatioAtTick(tick: number): bigint {
  requireTick(tick);
  const absoluteTick = Math.abs(tick);
  let ratio = (absoluteTick & 1) === 0 ? Q128 : TICK_MULTIPLIERS[0];
  for (let bit = 1; bit < TICK_MULTIPLIERS.length; bit += 1) {
    if ((absoluteTick & (1 << bit)) !== 0) {
      ratio = (ratio * TICK_MULTIPLIERS[bit]!) >> 128n;
    }
  }
  if (tick > 0) ratio = UINT256_MAX / ratio;
  const remainderMask = (1n << 32n) - 1n;
  return (ratio >> 32n) + ((ratio & remainderMask) === 0n ? 0n : 1n);
}

function requireLiquidity(liquidity: bigint): void {
  if (liquidity < 0n || liquidity > UINT128_MAX) {
    throw new Error("Liquidity must fit uint128");
  }
}

function requireSqrtRatio(sqrtRatioX96: bigint): void {
  if (sqrtRatioX96 < MIN_SQRT_RATIO || sqrtRatioX96 >= MAX_SQRT_RATIO) {
    throw new Error("Current sqrt ratio is outside the canonical pool range");
  }
}

function amount0ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  const numerator = (liquidity << 96n) * (sqrtRatioBX96 - sqrtRatioAX96);
  return (numerator / sqrtRatioBX96) / sqrtRatioAX96;
}

function amount1ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  return (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96;
}

export function principalAmounts(input: {
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
}): {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly region: PrincipalRegion;
  readonly sqrtRatioLowerX96: bigint;
  readonly sqrtRatioUpperX96: bigint;
} {
  requireLiquidity(input.liquidity);
  requireSqrtRatio(input.sqrtPriceX96);
  requireTick(input.tickLower);
  requireTick(input.tickUpper);
  if (input.tickLower >= input.tickUpper) {
    throw new Error("Position lower tick must be below upper tick");
  }
  const sqrtRatioLowerX96 = sqrtRatioAtTick(input.tickLower);
  const sqrtRatioUpperX96 = sqrtRatioAtTick(input.tickUpper);
  const amounts = amountsForLiquidity({
    liquidity: input.liquidity,
    sqrtPriceX96: input.sqrtPriceX96,
    sqrtRatioAX96: sqrtRatioLowerX96,
    sqrtRatioBX96: sqrtRatioUpperX96,
  });
  return { ...amounts, sqrtRatioLowerX96, sqrtRatioUpperX96 };
}

export function amountsForLiquidity(input: {
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly sqrtRatioAX96: bigint;
  readonly sqrtRatioBX96: bigint;
}): {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly region: PrincipalRegion;
} {
  requireLiquidity(input.liquidity);
  requireSqrtRatio(input.sqrtPriceX96);
  let sqrtRatioLowerX96 = input.sqrtRatioAX96;
  let sqrtRatioUpperX96 = input.sqrtRatioBX96;
  if (sqrtRatioLowerX96 > sqrtRatioUpperX96) {
    [sqrtRatioLowerX96, sqrtRatioUpperX96] = [
      sqrtRatioUpperX96,
      sqrtRatioLowerX96,
    ];
  }
  if (
    sqrtRatioLowerX96 < MIN_SQRT_RATIO ||
    sqrtRatioUpperX96 > MAX_SQRT_RATIO ||
    sqrtRatioLowerX96 >= sqrtRatioUpperX96
  ) {
    throw new Error("Position sqrt ratios are outside the canonical range");
  }
  let amount0 = 0n;
  let amount1 = 0n;
  let region: PrincipalRegion;
  if (input.sqrtPriceX96 <= sqrtRatioLowerX96) {
    region = "below_range";
    amount0 = amount0ForLiquidity(
      sqrtRatioLowerX96,
      sqrtRatioUpperX96,
      input.liquidity,
    );
  } else if (input.sqrtPriceX96 < sqrtRatioUpperX96) {
    region = "in_range";
    amount0 = amount0ForLiquidity(
      input.sqrtPriceX96,
      sqrtRatioUpperX96,
      input.liquidity,
    );
    amount1 = amount1ForLiquidity(
      sqrtRatioLowerX96,
      input.sqrtPriceX96,
      input.liquidity,
    );
  } else {
    region = "above_range";
    amount1 = amount1ForLiquidity(
      sqrtRatioLowerX96,
      sqrtRatioUpperX96,
      input.liquidity,
    );
  }
  if (amount0 > UINT256_MAX || amount1 > UINT256_MAX) {
    throw new Error("Principal amount exceeds uint256");
  }
  return { amount0, amount1, region };
}

function validatePoolTick(pool: PrincipalPoolSource): void {
  requireTick(pool.tick);
  requireSqrtRatio(pool.sqrtPriceX96);
  const atTick = sqrtRatioAtTick(pool.tick);
  const beforeNextTick = pool.tick === MAX_TICK
    ? MAX_SQRT_RATIO
    : sqrtRatioAtTick(pool.tick + 1);
  if (pool.sqrtPriceX96 < atTick || pool.sqrtPriceX96 >= beforeNextTick) {
    throw new Error(`Pool tick and sqrt price disagree for ${pool.poolAddress}`);
  }
}

export function reconstructPrincipalSnapshot(input: {
  readonly pools: readonly PrincipalPoolSource[];
  readonly run: AccountingRunReference;
  readonly streamKey: string;
}): PrincipalSnapshot {
  const poolKeys = new Set<string>();
  const pools: PrincipalPoolSnapshot[] = [];
  const positions: PrincipalPositionSnapshot[] = [];
  for (const pool of input.pools) {
    const key = pool.poolAddress.toLowerCase();
    if (poolKeys.has(key)) throw new Error(`Duplicate principal pool ${key}`);
    poolKeys.add(key);
    validatePoolTick(pool);
    if (pool.positions.length !== pool.activePositions) {
      throw new Error(`Active position count disagrees for ${pool.poolAddress}`);
    }
    let amount0 = 0n;
    let amount1 = 0n;
    let aboveRangePositions = 0;
    let belowRangePositions = 0;
    let inRangePositions = 0;
    const positionKeys = new Set<string>();
    for (const position of pool.positions) {
      if (position.liquidity <= 0n) {
        throw new Error("Principal reconstruction requires active positions");
      }
      const positionKey = `${position.ownerAddress.toLowerCase()}:` +
        `${position.tickLower}:${position.tickUpper}`;
      if (positionKeys.has(positionKey)) {
        throw new Error(`Duplicate principal position ${key}:${positionKey}`);
      }
      positionKeys.add(positionKey);
      const amounts = principalAmounts({
        liquidity: position.liquidity,
        sqrtPriceX96: pool.sqrtPriceX96,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
      });
      amount0 += amounts.amount0;
      amount1 += amounts.amount1;
      if (amounts.region === "below_range") belowRangePositions += 1;
      else if (amounts.region === "in_range") inRangePositions += 1;
      else aboveRangePositions += 1;
      positions.push({
        ...position,
        amount0: amounts.amount0.toString(),
        amount1: amounts.amount1.toString(),
        poolAddress: pool.poolAddress,
        region: amounts.region,
        sqrtRatioLowerX96: amounts.sqrtRatioLowerX96.toString(),
        sqrtRatioUpperX96: amounts.sqrtRatioUpperX96.toString(),
      });
    }
    pools.push({
      aboveRangePositions,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      belowRangePositions,
      fee: pool.fee,
      inRangePositions,
      poolAddress: pool.poolAddress,
      positionCount: pool.positions.length,
      rwaSymbol: pool.rwaSymbol,
      sqrtPriceX96: pool.sqrtPriceX96.toString(),
      tick: pool.tick,
      token0: pool.token0,
      token1: pool.token1,
    });
  }
  const totals = pools.reduce((total, pool) => ({
    aboveRangePositions: total.aboveRangePositions + pool.aboveRangePositions,
    belowRangePositions: total.belowRangePositions + pool.belowRangePositions,
    inRangePositions: total.inRangePositions + pool.inRangePositions,
    positionCount: total.positionCount + pool.positionCount,
  }), {
    aboveRangePositions: 0,
    belowRangePositions: 0,
    inRangePositions: 0,
    positionCount: 0,
  });
  return {
    computedAt: new Date().toISOString(),
    executionEligible: false,
    methodology: "canonical_liquidity_amounts_floor",
    pools,
    positions,
    run: input.run,
    schemaVersion: 1,
    streamKey: input.streamKey,
    totals,
  };
}
