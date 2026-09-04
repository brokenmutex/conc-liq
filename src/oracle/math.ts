const Q192 = 1n << 192n;
const X18 = 1_000_000_000_000_000_000n;
const ONE_MILLION = 1_000_000n;

function scale(decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token or feed decimals are outside the uint8 domain");
  }
  return 10n ** BigInt(decimals);
}

export function poolQuotePerRwaX18(input: {
  readonly quoteDecimals: number;
  readonly quoteToken: string;
  readonly rwaDecimals: number;
  readonly sqrtPriceX96: bigint;
  readonly token0: string;
  readonly token1: string;
}): bigint {
  if (input.sqrtPriceX96 <= 0n) throw new Error("Pool sqrt price must be positive");
  const quoteIsToken0 = input.quoteToken.toLowerCase() ===
    input.token0.toLowerCase();
  const quoteIsToken1 = input.quoteToken.toLowerCase() ===
    input.token1.toLowerCase();
  if (quoteIsToken0 === quoteIsToken1) {
    throw new Error("Pool must contain the quote token exactly once");
  }
  const priceX192 = input.sqrtPriceX96 * input.sqrtPriceX96;
  const displayScale = scale(input.rwaDecimals) * X18;
  const quoteScale = scale(input.quoteDecimals);
  return quoteIsToken0
    ? Q192 * displayScale / (priceX192 * quoteScale)
    : priceX192 * displayScale / (Q192 * quoteScale);
}

export function oracleQuotePerRwaX18(input: {
  readonly quoteAnswer: bigint;
  readonly quoteFeedDecimals: number;
  readonly rwaAnswer: bigint;
  readonly rwaFeedDecimals: number;
}): bigint {
  if (input.rwaAnswer <= 0n || input.quoteAnswer <= 0n) {
    throw new Error("Oracle answers must be positive");
  }
  return input.rwaAnswer * scale(input.quoteFeedDecimals) * X18 /
    (input.quoteAnswer * scale(input.rwaFeedDecimals));
}

export function signedDeviationPpm(reference: bigint, observed: bigint): bigint {
  if (reference <= 0n || observed <= 0n) {
    throw new Error("Deviation prices must be positive");
  }
  return (observed - reference) * ONE_MILLION / reference;
}
