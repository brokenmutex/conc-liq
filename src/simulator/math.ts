import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  principalAmounts,
  sqrtRatioAtTick,
} from "../backtest/principal.js";

const Q192 = 1n << 192n;
const UINT128_MAX = (1n << 128n) - 1n;

export function tickSpacingForFee(fee: number): number {
  const spacing = new Map([
    [100, 1],
    [500, 10],
    [3_000, 60],
    [10_000, 200],
  ]).get(fee);
  if (spacing === undefined) {
    throw new Error(`Unsupported canonical fee tier ${fee}`);
  }
  return spacing;
}

export function centeredRange(input: {
  readonly currentTick: number;
  readonly halfWidthSpacings: number;
  readonly tickSpacing: number;
}): { readonly tickLower: number; readonly tickUpper: number } {
  if (
    !Number.isSafeInteger(input.halfWidthSpacings) ||
    input.halfWidthSpacings <= 0
  ) {
    throw new Error("Range half-width must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.tickSpacing) || input.tickSpacing <= 0) {
    throw new Error("Tick spacing must be a positive safe integer");
  }
  const center = Math.floor(input.currentTick / input.tickSpacing) *
    input.tickSpacing;
  const offset = input.halfWidthSpacings * input.tickSpacing;
  if (!Number.isSafeInteger(offset)) {
    throw new Error("Range half-width exceeds the safe tick domain");
  }
  const tickLower = center - offset;
  const tickUpper = center + offset;
  if (
    tickLower < MIN_TICK || tickUpper > MAX_TICK ||
    tickLower >= tickUpper ||
    input.currentTick < tickLower || input.currentTick >= tickUpper
  ) {
    throw new Error("Centered range is outside the canonical tick domain");
  }
  return { tickLower, tickUpper };
}

export function validateTickAndSqrtPrice(input: {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
}): void {
  if (
    !Number.isSafeInteger(input.tick) ||
    input.tick < MIN_TICK || input.tick > MAX_TICK
  ) {
    throw new Error(`Pool tick ${input.tick} is outside the canonical range`);
  }
  if (
    input.sqrtPriceX96 < MIN_SQRT_RATIO ||
    input.sqrtPriceX96 >= MAX_SQRT_RATIO
  ) {
    throw new Error("Pool sqrt price is outside the canonical range");
  }
  const atTick = sqrtRatioAtTick(input.tick);
  const beforeNext = input.tick === MAX_TICK
    ? MAX_SQRT_RATIO
    : sqrtRatioAtTick(input.tick + 1);
  if (input.sqrtPriceX96 < atTick || input.sqrtPriceX96 >= beforeNext) {
    throw new Error("Pool tick and sqrt price disagree");
  }
}

export function quoteValue(input: {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly quoteToken: string;
  readonly sqrtPriceX96: bigint;
  readonly token0: string;
  readonly token1: string;
}): bigint {
  if (input.amount0 < 0n || input.amount1 < 0n) {
    throw new Error("Token amounts must be nonnegative");
  }
  if (input.sqrtPriceX96 <= 0n) {
    throw new Error("Pool sqrt price must be positive");
  }
  const quoteIsToken0 = input.quoteToken.toLowerCase() ===
    input.token0.toLowerCase();
  const quoteIsToken1 = input.quoteToken.toLowerCase() ===
    input.token1.toLowerCase();
  if (quoteIsToken0 === quoteIsToken1) {
    throw new Error("Exactly one pool token must be the quote token");
  }
  const priceX192 = input.sqrtPriceX96 * input.sqrtPriceX96;
  return quoteIsToken0
    ? input.amount0 + input.amount1 * Q192 / priceX192
    : input.amount1 + input.amount0 * priceX192 / Q192;
}

export function sizeLiquidityForQuoteBudget(input: {
  readonly budgetQuote: bigint;
  readonly quoteToken: string;
  readonly sqrtPriceX96: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly token0: string;
  readonly token1: string;
}): {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly idleQuote: bigint;
  readonly liquidity: bigint;
} {
  if (input.budgetQuote <= 0n) {
    throw new Error("Quote budget must be positive");
  }
  const valueForLiquidity = (liquidity: bigint): bigint => {
    const principal = principalAmounts({
      liquidity,
      sqrtPriceX96: input.sqrtPriceX96,
      tickLower: input.tickLower,
      tickUpper: input.tickUpper,
    });
    return quoteValue({
      amount0: principal.amount0,
      amount1: principal.amount1,
      quoteToken: input.quoteToken,
      sqrtPriceX96: input.sqrtPriceX96,
      token0: input.token0,
      token1: input.token1,
    });
  };
  let lower = 0n;
  let upper = UINT128_MAX;
  while (lower < upper) {
    const middle = lower + (upper - lower + 1n) / 2n;
    if (valueForLiquidity(middle) <= input.budgetQuote) lower = middle;
    else upper = middle - 1n;
  }
  const principal = principalAmounts({
    liquidity: lower,
    sqrtPriceX96: input.sqrtPriceX96,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
  });
  const deployedValue = quoteValue({
    amount0: principal.amount0,
    amount1: principal.amount1,
    quoteToken: input.quoteToken,
    sqrtPriceX96: input.sqrtPriceX96,
    token0: input.token0,
    token1: input.token1,
  });
  return {
    amount0: principal.amount0,
    amount1: principal.amount1,
    idleQuote: input.budgetQuote - deployedValue,
    liquidity: lower,
  };
}
