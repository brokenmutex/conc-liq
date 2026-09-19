export interface IndependentReference {
  readonly priceX18: bigint;
  readonly publishedAt: number;
  readonly expiresAt: number;
  readonly canonical: boolean;
  readonly qualityPassing: boolean;
}
/** User-selected inclusive +/-5%; missing/expired references never use pool spot. */
export function referenceBand(poolPriceX18: bigint, at: number, reference: IndependentReference | null): {
  available: boolean; inside: boolean; reason: string | null;
} {
  if (poolPriceX18 <= 0n || !Number.isSafeInteger(at) || !reference || reference.priceX18 <= 0n ||
      !reference.canonical || !reference.qualityPassing || !Number.isSafeInteger(reference.publishedAt) ||
      !Number.isSafeInteger(reference.expiresAt) || reference.publishedAt > at || at >= reference.expiresAt ||
      reference.expiresAt <= reference.publishedAt) return { available: false, inside: false, reason: "independent_reference_unavailable" };
  const difference = poolPriceX18 > reference.priceX18 ? poolPriceX18 - reference.priceX18 : reference.priceX18 - poolPriceX18;
  const inside = difference * 100n <= reference.priceX18 * 5n;
  return { available: true, inside, reason: inside ? null : "outside_five_percent_reference_band" };
}
