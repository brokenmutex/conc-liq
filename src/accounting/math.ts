const Q128 = 1n << 128n;
const Q256 = 1n << 256n;
const UINT128_MAX = Q128 - 1n;

function uint256(value: bigint): bigint {
  const reduced = value % Q256;
  return reduced < 0n ? reduced + Q256 : reduced;
}

export function subtractUint256(left: bigint, right: bigint): bigint {
  return uint256(left - right);
}

export function feeGrowthInside(input: {
  readonly currentTick: number;
  readonly feeGrowthGlobalX128: bigint;
  readonly lowerFeeGrowthOutsideX128: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly upperFeeGrowthOutsideX128: bigint;
}): bigint {
  const below = input.currentTick >= input.tickLower
    ? input.lowerFeeGrowthOutsideX128
    : subtractUint256(
      input.feeGrowthGlobalX128,
      input.lowerFeeGrowthOutsideX128,
    );
  const above = input.currentTick < input.tickUpper
    ? input.upperFeeGrowthOutsideX128
    : subtractUint256(
      input.feeGrowthGlobalX128,
      input.upperFeeGrowthOutsideX128,
    );
  return subtractUint256(
    subtractUint256(input.feeGrowthGlobalX128, below),
    above,
  );
}

export function calculatePositionFees(input: {
  readonly feeGrowthInside0LastX128: bigint;
  readonly feeGrowthInside0X128: bigint;
  readonly feeGrowthInside1LastX128: bigint;
  readonly feeGrowthInside1X128: bigint;
  readonly liquidity: bigint;
  readonly tokensOwed0: bigint;
  readonly tokensOwed1: bigint;
}): {
  readonly claimable0: bigint;
  readonly claimable1: bigint;
  readonly pending0: bigint;
  readonly pending1: bigint;
} {
  if (
    input.liquidity < 0n ||
    input.liquidity > UINT128_MAX ||
    input.tokensOwed0 < 0n ||
    input.tokensOwed0 > UINT128_MAX ||
    input.tokensOwed1 < 0n ||
    input.tokensOwed1 > UINT128_MAX
  ) {
    throw new Error("Position fee accounting input exceeds uint128 bounds");
  }
  const pending0 = subtractUint256(
    input.feeGrowthInside0X128,
    input.feeGrowthInside0LastX128,
  ) * input.liquidity / Q128;
  const pending1 = subtractUint256(
    input.feeGrowthInside1X128,
    input.feeGrowthInside1LastX128,
  ) * input.liquidity / Q128;
  if (
    pending0 > UINT128_MAX ||
    pending1 > UINT128_MAX ||
    input.tokensOwed0 + pending0 > UINT128_MAX ||
    input.tokensOwed1 + pending1 > UINT128_MAX
  ) {
    throw new Error("Position fee accounting exceeds uint128 bounds");
  }
  return {
    claimable0: input.tokensOwed0 + pending0,
    claimable1: input.tokensOwed1 + pending1,
    pending0,
    pending1,
  };
}
