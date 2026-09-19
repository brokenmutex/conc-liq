import assert from "node:assert/strict";
import { sqrtRatioAtTick, MIN_TICK, MAX_TICK } from "../backtest/principal.js";
import { tickSpacingForFee, sizeLiquidityForQuoteBudget } from "../simulator/math.js";
import { CapacityScreen, type CapacitySegment } from "./capacity.js";
import { tickAtPrice } from "./swap.js";

export interface RangeObservation { at: number; tick: number; price: bigint; liquidity: bigint; pathMinTick: number; pathMaxTick: number; segments?: readonly CapacitySegment[] }
export type ScreenPolicy = "fixed" | "edge" | "immediate70" | "persistent70";
const numerator = (1n << 192n) * 10n ** 30n; // NVDA token1 (18 decimals), USDG token0 (6).
export const nvdaPriceX18 = (sqrtPriceX96: bigint): bigint => numerator / (sqrtPriceX96 * sqrtPriceX96);

/** Exact human-price percentage bounds, rounded inward to the pool's tick grid. */
export function percentageRange(price: bigint, halfWidthBps: number, spacing: number): { tickLower: number; tickUpper: number } {
  assert(price > 0n && Number.isInteger(halfWidthBps) && halfWidthBps > 0 && halfWidthBps < 10000);
  assert(Number.isInteger(spacing) && spacing > 0);
  const centerDenominator = price * price;
  // Human USDG/NVDA price is inverse to squared raw sqrt price.
  const firstTick = (test: (tick: number) => boolean) => {
    let low = MIN_TICK, high = MAX_TICK;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (test(mid)) high = mid; else low = mid + 1; }
    return low;
  };
  const lower = firstTick(tick => sqrtRatioAtTick(tick) ** 2n * BigInt(10000 + halfWidthBps) >= centerDenominator * 10000n);
  const upperExclusive = firstTick(tick => sqrtRatioAtTick(tick) ** 2n * BigInt(10000 - halfWidthBps) > centerDenominator * 10000n);
  const tickLower = Math.ceil(lower / spacing) * spacing, tickUpper = Math.floor((upperExclusive - 1) / spacing) * spacing;
  assert(tickLower < tickUpper && tickLower >= MIN_TICK && tickUpper <= MAX_TICK, "No feasible inward-rounded range");
  return { tickLower, tickUpper };
}

/** Total raw tick distance, not tick-spacing multiples or ticks on each side. */
export function rawTickRange(price: bigint, totalWidthTicks: number, spacing: number): { tickLower: number; tickUpper: number } {
  assert(Number.isSafeInteger(spacing) && spacing > 0);
  assert(Number.isSafeInteger(totalWidthTicks) && totalWidthTicks > 0 && totalWidthTicks % spacing === 0,
    "Raw tick width must be a positive multiple of pool tick spacing");
  const tick = tickAtPrice(price);
  // Compare all nearest grid placements in exact squared-price distance from
  // the geometric midpoint. The starting price must be inside [lower,upper).
  const base = Math.floor((tick - totalWidthTicks / 2) / spacing) * spacing;
  const candidates = [base, base + spacing].filter(lower => lower >= MIN_TICK && lower + totalWidthTicks <= MAX_TICK &&
    sqrtRatioAtTick(lower) <= price && price < sqrtRatioAtTick(lower + totalWidthTicks));
  assert(candidates.length > 0, "No feasible raw-tick range");
  const distance = (lower: number) => {
    const midSquared = sqrtRatioAtTick(lower) * sqrtRatioAtTick(lower + totalWidthTicks);
    return midSquared > price * price ? midSquared - price * price : price * price - midSquared;
  };
  const tickLower = candidates.reduce((best, lower) => distance(lower) < distance(best) ? lower : best);
  return { tickLower, tickUpper: tickLower + totalWidthTicks };
}

/** Geometry only: no token swaps, costs, reference substitution or profit claims. */
export function screenRanges(samples: readonly RangeObservation[], fee: number, policy: ScreenPolicy, halfWidthBps: number, deployedQuote?: bigint, totalWidthTicks?: number) {
  assert(samples.length > 1 && ["fixed", "edge", "immediate70", "persistent70"].includes(policy));
  const spacing = tickSpacingForFee(fee), first = samples[0]!;
  const makeRange = (price: bigint) => totalWidthTicks === undefined ? percentageRange(price, halfWidthBps, spacing) : rawTickRange(price, totalWidthTicks, spacing);
  let range = makeRange(first.price), center = first.price;
  const initial = { ...range };
  let pending: { at: number; range: typeof range; center: bigint } | null = null;
  let persistence = 0, lastMove = first.at - 600, signals = 0, moves = 0, missedMoves = 0;
  let outside = 0, crossedIntervals = 0, maxOutsideStreak = 0, streak = 0;
  const capacity = deployedQuote === undefined ? null : new CapacityScreen(deployedQuote);
  capacity?.place(first, range);
  const initialLiquidity = sizeLiquidityForQuoteBudget({ budgetQuote: deployedQuote ?? 800_000_000n, sqrtPriceX96: first.price,
    token0: "USDG", token1: "NVDA", quoteToken: "USDG", ...range }).liquidity;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    if (index) assert(sample.at === samples[index - 1]!.at + 60, "Screen requires the frozen one-minute decision grid");
    capacity?.observe(sample, range, index > 0);
    // Retrospective path extrema are used only for coverage metrics, never signals.
    if (index && (sample.pathMinTick < range.tickLower || sample.pathMaxTick >= range.tickUpper)) crossedIntervals++;
    const out = sample.tick < range.tickLower || sample.tick >= range.tickUpper;
    if (out) { outside++; streak++; maxOutsideStreak = Math.max(maxOutsideStreak, streak); } else streak = 0;
    if (pending && sample.at >= pending.at) {
      if (sample.tick >= pending.range.tickLower && sample.tick < pending.range.tickUpper) {
        range = pending.range; center = pending.center; lastMove = sample.at; moves++;
        capacity?.place(sample, range);
      } else missedMoves++;
      pending = null; persistence = 0;
      continue;
    }
    if (policy === "fixed" || pending) continue;
    const nowHuman = numerator / (sample.price * sample.price), centerHuman = numerator / (center * center);
    const down = nowHuman < centerHuman;
    const boundaryHuman = numerator / (sqrtRatioAtTick(down ? range.tickUpper : range.tickLower) ** 2n);
    const distance = down ? centerHuman - nowHuman : nowHuman - centerHuman;
    const width = down ? centerHuman - boundaryHuman : boundaryHuman - centerHuman;
    const triggered = policy === "edge" ? sample.tick < range.tickLower || sample.tick >= range.tickUpper : distance > 0n && distance * 100n >= width * 70n;
    if (!triggered) { persistence = 0; continue; }
    persistence++;
    if (policy === "persistent70" && (persistence < 2 || sample.at - lastMove < 600)) continue;
    // Freeze the range at signal time. Apply at a later observation only if it
    // still contains the pool price; this remains a geometric action proxy.
    try { pending = { at: sample.at + 60, range: makeRange(sample.price), center: sample.price }; signals++; }
    catch { missedMoves++; persistence = 0; }
  }
  return { fee, policy, halfWidthBps: totalWidthTicks === undefined ? halfWidthBps : null,
    ...(totalWidthTicks === undefined ? {} : { totalWidthTicks, rangeUnit: "raw_ticks_total_lower_to_upper",
      centering: "Nearest feasible tick-grid midpoint to signal price; actual bounds may be asymmetric around that price" }),
    observations: samples.length, initialRange: initial,
    ...(capacity ? { capacity: capacity.result() } : {}),
    initialHypotheticalLiquidity: initialLiquidity.toString(),
    initialLiquiditySharePpm: (initialLiquidity * 1000000n / (first.liquidity + initialLiquidity)).toString(),
    outOfRangeObservations: outside, outOfRangePpm: Math.floor(outside * 1000000 / samples.length),
    intervalsWithRangeCrossing: crossedIntervals, maxConsecutiveOutOfRangeObservations: maxOutsideStreak,
    recenterSignals: signals, geometricRangeChanges: moves, expiredRangeChanges: missedMoves, pendingAtEnd: pending !== null,
    executionEligible: false, rank: null, netAlphaQuote: null, executionCostsQuote: null, feesQuote: null,
    evidenceClass: "unguarded_range_geometry_screen", referencePolicyResult: "unavailable_no_historical_independent_reference",
    limitations: ["Range changes are geometric proxies, not executable portfolio rebalances", "No inventory intervention, swap sizing, costs or hypothetical fee income is modeled",
      "Occupancy is sampled each minute; interval extrema separately disclose excursions", "This variant cannot validate the proposed guarded policy or rank profitability"] };
}
