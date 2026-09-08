import assert from "node:assert/strict";
import { MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO, MIN_TICK, Q96, sqrtRatioAtTick } from "../backtest/principal.js";

// Integer v3 swap-step equations; references and differential evidence are in
// notes/active-lp-research-2026-09-07/README.md. No floating-point token math.
const MAX256 = (1n << 256n) - 1n;
export const ceilDiv = (a: bigint, b: bigint): bigint => {
  assert(a >= 0n && b > 0n, "Invalid unsigned division");
  return (a + b - 1n) / b;
};
export function delta(a: bigint, b: bigint, liquidity: bigint, token: 0 | 1, up: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  assert(a > 0n && liquidity >= 0n);
  const numerator = token === 0 ? liquidity * Q96 * (b - a) : liquidity * (b - a);
  const denominator = token === 0 ? a * b : Q96;
  return up ? ceilDiv(numerator, denominator) : numerator / denominator;
}
function nextPrice(p: bigint, l: bigint, amount: bigint, token: 0 | 1, add: boolean): bigint {
  assert(p > 0n && l > 0n && amount >= 0n);
  if (amount === 0n) return p;
  if (token === 1) return add ? p + amount * Q96 / l : p - ceilDiv(amount * Q96, l);
  const n = l * Q96, product = amount * p;
  if (add && (product > MAX256 || n + product > MAX256)) return ceilDiv(n, n / p + amount);
  assert(product <= MAX256 && (add || n > product));
  return ceilDiv(n * p, add ? n + product : n - product);
}
export interface SwapStep { price: bigint; amountIn: bigint; amountOut: bigint; fee: bigint }
export function swapStep(p: bigint, target: bigint, l: bigint, remaining: bigint, feePips: number): SwapStep {
  assert(Number.isInteger(feePips) && feePips >= 0 && feePips < 1_000_000);
  const down = p >= target, exactIn = remaining >= 0n;
  const inputToken = down ? 0 : 1, outputToken = down ? 1 : 0;
  const fee = BigInt(feePips), denominator = 1_000_000n - fee;
  const available = exactIn ? remaining * denominator / 1_000_000n : -remaining;
  const needed = delta(p, target, l, exactIn ? inputToken : outputToken, exactIn);
  const price = available >= needed ? target : nextPrice(p, l, available, exactIn ? inputToken : outputToken, exactIn);
  const amountIn = delta(p, price, l, inputToken, true);
  let amountOut = delta(p, price, l, outputToken, false);
  if (!exactIn && amountOut > -remaining) amountOut = -remaining;
  const feeAmount = exactIn && price !== target ? remaining - amountIn : ceilDiv(amountIn * fee, denominator);
  assert(feeAmount >= 0n && price >= MIN_SQRT_RATIO && price <= MAX_SQRT_RATIO);
  return { price, amountIn, amountOut, fee: feeAmount };
}

export function tickAtPrice(price: bigint): number {
  assert(price >= MIN_SQRT_RATIO && price < MAX_SQRT_RATIO);
  let low = MIN_TICK, high = MAX_TICK;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sqrtRatioAtTick(mid) <= price) low = mid; else high = mid - 1;
  }
  return low;
}
export function lowerBound(ticks: readonly number[], tick: number): number {
  let low = 0, high = ticks.length;
  while (low < high) { const mid = (low + high) >>> 1; if (ticks[mid]! < tick) low = mid + 1; else high = mid; }
  return low;
}

export interface FeeSegment {
  from: bigint; to: bigint; tickBefore: number; liquidity: bigint;
  fee: bigint; token: 0 | 1; crossed: number | null;
}
export interface ObservedSwap { price: bigint; tick: number; liquidity: bigint; amount0: bigint; amount1: bigint }
export interface SwapSource {
  price: bigint; tick: number; liquidity: bigint; fee: number; spacing: number;
  ticks: readonly number[]; net: (tick: number) => bigint;
}

/** Replay the observed swap, not a hypothetical trade against modified liquidity. */
export function reconstructSwap(source: SwapSource, observed: ObservedSwap): FeeSegment[] {
  const down = observed.price < source.price || (observed.price === source.price && observed.amount0 > 0n);
  const input = down ? observed.amount0 : observed.amount1;
  const output = -(down ? observed.amount1 : observed.amount0);
  assert(input >= 0n && output >= 0n, "Invalid observed swap direction");
  assert(source.spacing > 0 && Number.isInteger(source.spacing));
  function attempt(exactIn: boolean, useEndLimit: boolean): FeeSegment[] | null {
    let price = source.price, tick = source.tick, liquidity = source.liquidity;
    // A price-limited call may specify more than the amounts reported by its
    // Swap event. One unspent unit also permits traversing empty liquidity after
    // the last filled tick; that movement produces no additional token cashflow.
    const unspent = useEndLimit ? 1n : 0n;
    let remaining = exactIn ? input + unspent : -(output + unspent), totalIn = 0n, totalOut = 0n;
    const limit = useEndLimit ? observed.price : down ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
    const segments: FeeSegment[] = [];
    if (price === limit) return null;
    for (let step = 0; remaining !== 0n && price !== limit; step++) {
      if (step > 20_000) return null;
      let compressed = Math.floor(tick / source.spacing);
      if (!down) compressed++;
      const wordBoundary = down ? Math.floor(compressed / 256) * 256 : Math.floor(compressed / 256) * 256 + 255;
      const index = lowerBound(source.ticks, compressed * source.spacing + (down ? 1 : 0));
      const candidate = source.ticks[down ? index - 1 : index];
      const initialized = candidate !== undefined && (down ? candidate >= wordBoundary * source.spacing : candidate <= wordBoundary * source.spacing);
      const nextTick = Math.max(MIN_TICK, Math.min(MAX_TICK, initialized ? candidate! : wordBoundary * source.spacing));
      const boundary = sqrtRatioAtTick(nextTick);
      const target = down ? (boundary < limit ? limit : boundary) : (boundary > limit ? limit : boundary);
      const result = swapStep(price, target, liquidity, remaining, source.fee);
      totalIn += result.amountIn + result.fee; totalOut += result.amountOut;
      if (totalIn > input || totalOut > output) return null;
      const crossed = result.price === boundary && initialized ? nextTick : null;
      segments.push({ from: price, to: result.price, tickBefore: tick, liquidity, fee: result.fee, token: down ? 0 : 1, crossed });
      remaining += exactIn ? -(result.amountIn + result.fee) : result.amountOut;
      if (result.price === boundary) {
        if (initialized) liquidity += (down ? -1n : 1n) * source.net(nextTick);
        tick = down ? nextTick - 1 : nextTick;
      } else if (price !== result.price) {
        if (result.price === observed.price && observed.tick >= MIN_TICK && observed.tick < MAX_TICK &&
            sqrtRatioAtTick(observed.tick) <= result.price && result.price < sqrtRatioAtTick(observed.tick + 1)) tick = observed.tick;
        else tick = tickAtPrice(result.price);
      }
      price = result.price;
      if (liquidity < 0n || liquidity >= (1n << 128n)) return null;
      if (down ? price < observed.price : price > observed.price) return null;
    }
    return price === observed.price && tick === observed.tick && liquidity === observed.liquidity && totalIn === input && totalOut === output ? segments : null;
  }
  // Swap logs omit exact-in/out mode and price limit. Accept only a reconstruction
  // matching both token cashflows, ending price, tick and active liquidity exactly.
  for (const [exactIn, endLimit] of [[true, false], [false, false], [true, true], [false, true]] as const) {
    try { const segments = attempt(exactIn, endLimit); if (segments) return segments; } catch { /* Try the other observed-envelope interpretation. */ }
  }
  throw new Error("Observed swap cannot be reconstructed exactly");
}
