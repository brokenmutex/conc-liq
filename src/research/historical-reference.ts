import assert from "node:assert/strict";
import type { OracleFeedMetadata, OracleRoundState } from "../risk/domain.js";
import { evaluateOracleRisk } from "../risk/evaluate.js";
import { oracleQuotePerRwaX18 } from "../oracle/math.js";
import { referenceBand } from "./reference.js";

export interface PublishedOracleRound {
  blockNumber: number;
  blockHash: string;
  availableAt: number;
  state: OracleRoundState;
}

export function oracleRoundAt(rounds: readonly PublishedOracleRound[], at: number): PublishedOracleRound | null {
  let chosen: PublishedOracleRound | null = null;
  for (const round of rounds) {
    if (chosen) assert(round.blockNumber > chosen.blockNumber && round.availableAt >= chosen.availableAt, "Oracle publications must be in canonical order");
    if (round.availableAt > at) break;
    chosen = round;
  }
  return chosen;
}

/** Price-reference evidence only. Issuer/sequencer gates remain separate. */
export function historicalReferenceAt(input: {
  at: number; poolPriceX18?: bigint; maxAgeSeconds: number;
  rwaFeed: OracleFeedMetadata; quoteFeed: OracleFeedMetadata;
  rwaRounds: readonly PublishedOracleRound[]; quoteRounds: readonly PublishedOracleRound[];
}) {
  assert(Number.isSafeInteger(input.at) && Number.isSafeInteger(input.maxAgeSeconds) && input.maxAgeSeconds > 0);
  const rwa = oracleRoundAt(input.rwaRounds, input.at), quote = oracleRoundAt(input.quoteRounds, input.at);
  const assess = (round: PublishedOracleRound | null, feed: OracleFeedMetadata) => evaluateOracleRisk({
    blockTimestamp: BigInt(input.at), feed, state: round?.state ?? null, maxPriceAgeSeconds: input.maxAgeSeconds,
  });
  const rwaRisk = assess(rwa, input.rwaFeed), quoteRisk = assess(quote, input.quoteFeed);
  const reasons = [...rwaRisk.reasons.map(r => `rwa_${r}`), ...quoteRisk.reasons.map(r => `quote_${r}`)];
  const positive = rwa !== null && quote !== null && BigInt(rwa.state.answer) > 0n && BigInt(quote.state.answer) > 0n;
  const priceX18 = positive ? oracleQuotePerRwaX18({ rwaAnswer: BigInt(rwa.state.answer), quoteAnswer: BigInt(quote.state.answer),
    rwaFeedDecimals: rwa.state.decimals, quoteFeedDecimals: quote.state.decimals }) : null;
  const available = reasons.length === 0 && priceX18 !== null;
  // Risk evaluation admits age <= maxAge on integer-second timestamps. The
  // shared band helper expires at equality, so +1 preserves that same policy.
  const expiresAt = available ? Math.min(Number(rwa!.state.updatedAt) + rwaRisk.maxAgeSeconds + 1,
    Number(quote!.state.updatedAt) + quoteRisk.maxAgeSeconds + 1) : null;
  const reference = available ? { priceX18: priceX18!, publishedAt: Math.max(rwa!.availableAt, quote!.availableAt),
    expiresAt: expiresAt!, canonical: true, qualityPassing: true } : null;
  return { at: input.at, available, priceX18: available ? priceX18!.toString() : null,
    observedButUnqualifiedPriceX18: priceX18?.toString() ?? null, reasons,
    rwaAgeSeconds: rwaRisk.priceAgeSeconds, quoteAgeSeconds: quoteRisk.priceAgeSeconds,
    rwaPublicationBlock: rwa?.blockNumber ?? null, quotePublicationBlock: quote?.blockNumber ?? null,
    band: input.poolPriceX18 === undefined ? null : referenceBand(input.poolPriceX18, input.at, reference),
    executionEligible: false as const };
}
