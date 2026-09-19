import assert from "node:assert/strict";
import { sqrtRatioAtTick } from "../backtest/principal.js";
import { sizeLiquidityForQuoteBudget } from "../simulator/math.js";
import type { RangeObservation } from "./range-screen.js";

export interface CapacitySegment { from: bigint; to: bigint; tickBefore: number; liquidity: bigint }
type Range = { tickLower: number; tickUpper: number };
const share = (ours: bigint, historical: bigint) => {
  assert(ours > 0n && historical >= 0n);
  return Number(ours * 1_000_000n / (ours + historical));
};
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
  return { count: sorted.length, minPpm: sorted[0] ?? null, medianPpm: percentile(0.5), p95Ppm: percentile(0.95),
    maxPpm: sorted.at(-1) ?? null, aboveOnePercent: sorted.filter(v => v > 10_000).length,
    aboveFivePercent: sorted.filter(v => v > 50_000).length, aboveTenPercent: sorted.filter(v => v > 100_000).length };
}

/** Constant-budget placement probes, not a self-financing portfolio ledger. */
export class CapacityScreen {
  private liquidity = 0n;
  private readonly observations: number[] = [];
  private readonly segments: number[] = [];
  private readonly placements: { at: number; tickLower: number; tickUpper: number; liquidity: string; sharePpm: number;
    principal0Raw: string; principal1Raw: string; sizingResidualQuoteRaw: string }[] = [];
  public constructor(private readonly deployedQuote: bigint) { assert(deployedQuote > 0n); }
  public place(sample: RangeObservation, range: Range): void {
    const size = sizeLiquidityForQuoteBudget({ budgetQuote: this.deployedQuote, sqrtPriceX96: sample.price,
      token0: "USDG", token1: "NVDA", quoteToken: "USDG", ...range });
    this.liquidity = size.liquidity;
    this.placements.push({ at: sample.at, ...range, liquidity: size.liquidity.toString(), sharePpm: share(size.liquidity, sample.liquidity),
      principal0Raw: size.amount0.toString(), principal1Raw: size.amount1.toString(), sizingResidualQuoteRaw: size.idleQuote.toString() });
  }
  public observe(sample: RangeObservation, range: Range, includeSegments: boolean): void {
    if (sample.tick >= range.tickLower && sample.tick < range.tickUpper) this.observations.push(share(this.liquidity, sample.liquidity));
    if (!includeSegments) return;
    const lower = sqrtRatioAtTick(range.tickLower), upper = sqrtRatioAtTick(range.tickUpper);
    for (const s of sample.segments ?? []) {
      const lo = s.from < s.to ? s.from : s.to, hi = s.from > s.to ? s.from : s.to;
      const overlaps = lo === hi ? s.tickBefore >= range.tickLower && s.tickBefore < range.tickUpper : lo < upper && hi > lower;
      if (overlaps) this.segments.push(share(this.liquidity, s.liquidity));
    }
  }
  public result() {
    return { deployedQuoteRaw: this.deployedQuote.toString(), placements: this.placements,
      placementShares: distribution(this.placements.map(p => p.sharePpm)), activeMinuteShares: distribution(this.observations),
      overlappingObservedSwapSegmentShares: distribution(this.segments),
      methodology: "ours / (historical active liquidity + ours), independently sized with bigint at each geometric placement",
      limitations: ["Placements reset the nominal deployed budget; they are not funded rebalances or feasible mint quotes",
        "Principal sizing uses floor-rounded withdrawable amounts valued at pool spot, not independent true price",
        "Segment statistics are unweighted and use the unchanged observed price path; added liquidity would change that path",
        "One/five/ten percent counts are capacity diagnostics, not approved execution limits or profitability tests"] };
  }
}
