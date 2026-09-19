import assert from "node:assert/strict";
import { evaluateOracleRisk } from "../risk/evaluate.js";
import type { OracleFeedMetadata } from "../risk/domain.js";
import { oracleQuotePerRwaX18 } from "../oracle/math.js";
import { oracleRoundAt, type PublishedOracleRound } from "./historical-reference.js";

export interface ClosedSession { start: number; end: number }
export interface SessionReferenceSource {
  rwa: { feed: OracleFeedMetadata; rounds: readonly PublishedOracleRound[] };
  quote: { feed: OracleFeedMetadata; rounds: readonly PublishedOracleRound[] };
}
export interface SessionReferencePolicy {
  rwaMaxAgeSeconds: number; quoteMaxAgeSeconds: number;
  closures: readonly ClosedSession[];
}
/** Explicit research calendar; no inferred holiday/weekend exemptions. */
export function sessionReferenceAt(source: SessionReferenceSource, policy: SessionReferencePolicy, at: number) {
  assert(Number.isSafeInteger(at));
  for (let i = 0; i < policy.closures.length; i++) {
    const c = policy.closures[i]!;
    assert(Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end) && c.start < c.end);
    if (i) assert(c.start >= policy.closures[i - 1]!.end);
  }
  const closed = policy.closures.find(c => at >= c.start && at < c.end);
  const rwa = oracleRoundAt(source.rwa.rounds, closed ? closed.start : at);
  const quote = oracleRoundAt(source.quote.rounds, at);
  const rwaRisk = evaluateOracleRisk({ blockTimestamp: BigInt(closed ? closed.start : at), feed: source.rwa.feed,
    maxPriceAgeSeconds: policy.rwaMaxAgeSeconds, state: rwa?.state ?? null });
  const quoteRisk = evaluateOracleRisk({ blockTimestamp: BigInt(at), feed: source.quote.feed,
    maxPriceAgeSeconds: policy.quoteMaxAgeSeconds, state: quote?.state ?? null });
  const reasons = [...rwaRisk.reasons.map(r => `rwa_${r}`), ...quoteRisk.reasons.map(r => `quote_${r}`)];
  const lastReopen = policy.closures.filter(c => c.end <= at).at(-1)?.end;
  if (!closed && lastReopen !== undefined && (rwa === null || rwa.availableAt < lastReopen || Number(rwa.state.updatedAt) < lastReopen)) reasons.push("awaiting_post_reopening_round");
  const available = reasons.length === 0 && rwa !== null && quote !== null;
  return { at, available, priceX18: available ? oracleQuotePerRwaX18({ rwaAnswer: BigInt(rwa!.state.answer),
    rwaFeedDecimals: rwa!.state.decimals, quoteAnswer: BigInt(quote!.state.answer), quoteFeedDecimals: quote!.state.decimals }) : null,
    mode: closed ? "scheduled_closed_held" : "active_session", reasons,
    rwaPublishedAt: rwa?.availableAt ?? null, rwaUpdatedAt: rwa ? Number(rwa.state.updatedAt) : null,
    quoteUpdatedAt: quote ? Number(quote.state.updatedAt) : null, heldExpiresAt: closed?.end ?? null,
    executionEligible: false as const };
}
