const X18 = 1_000_000_000_000_000_000n;

function scale(decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals are outside the uint8 domain");
  }
  return 10n ** BigInt(decimals);
}

export function oracleMarkedQuoteValue(input: {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly oraclePriceX18: bigint;
  readonly quoteDecimals: number;
  readonly quoteToken: string;
  readonly rwaDecimals: number;
  readonly token0: string;
  readonly token1: string;
}): bigint {
  if (input.amount0 < 0n || input.amount1 < 0n) {
    throw new Error("Token amounts must be nonnegative");
  }
  if (input.oraclePriceX18 <= 0n) {
    throw new Error("Oracle price must be positive");
  }
  const quoteIsToken0 = input.quoteToken.toLowerCase() ===
    input.token0.toLowerCase();
  const quoteIsToken1 = input.quoteToken.toLowerCase() ===
    input.token1.toLowerCase();
  if (quoteIsToken0 === quoteIsToken1) {
    throw new Error("Exactly one pool token must be the quote token");
  }
  const quoteAmount = quoteIsToken0 ? input.amount0 : input.amount1;
  const rwaAmount = quoteIsToken0 ? input.amount1 : input.amount0;
  const rwaValueQuote = rwaAmount * input.oraclePriceX18 *
    scale(input.quoteDecimals) / (scale(input.rwaDecimals) * X18);
  return quoteAmount + rwaValueQuote;
}
