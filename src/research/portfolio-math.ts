import assert from "node:assert/strict";
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO, MIN_TICK, MAX_TICK, sqrtRatioAtTick } from "../backtest/principal.js";
import { delta, lowerBound, swapStep, tickAtPrice, type SwapSource, type FeeSegment } from "./swap.js";

export interface TickRange { tickLower: number; tickUpper: number }
export function positionAmounts(price: bigint, range: TickRange, liquidity: bigint, roundUp: boolean) {
  const lower = sqrtRatioAtTick(range.tickLower), upper = sqrtRatioAtTick(range.tickUpper);
  const bounded = price < lower ? lower : price > upper ? upper : price;
  return { amount0: delta(bounded, upper, liquidity, 0, roundUp), amount1: delta(lower, bounded, liquidity, 1, roundUp) };
}
export const nvdaValueQuote = (amount: bigint, referenceX18: bigint) => amount * referenceX18 / 10n ** 30n;

/** Exact-in quote against historical depth after our hypothetical LP is removed. */
export function historicalSwapQuote(source: SwapSource, amountIn: bigint, tokenIn: 0 | 1, slippageBps = 50) {
  assert(amountIn >= 0n && slippageBps >= 0 && slippageBps < 10000);
  const down = tokenIn === 0;
  let price = source.price, tick = source.tick, liquidity = source.liquidity, remaining = amountIn, output = 0n, fee = 0n;
  const limit = down ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  for (let count = 0; remaining > 0n && price !== limit; count++) {
    assert(count < 20000, "Swap quote exceeded step bound");
    let compressed = Math.floor(tick / source.spacing); if (!down) compressed++;
    const wordBoundary = down ? Math.floor(compressed / 256) * 256 : Math.floor(compressed / 256) * 256 + 255;
    const index = lowerBound(source.ticks, compressed * source.spacing + (down ? 1 : 0));
    const candidate = source.ticks[down ? index - 1 : index];
    const initialized = candidate !== undefined && (down ? candidate >= wordBoundary * source.spacing : candidate <= wordBoundary * source.spacing);
    const nextTick = Math.max(MIN_TICK, Math.min(MAX_TICK, initialized ? candidate! : wordBoundary * source.spacing));
    const boundary = sqrtRatioAtTick(nextTick), target = down ? (boundary < limit ? limit : boundary) : (boundary > limit ? limit : boundary);
    const step = swapStep(price, target, liquidity, remaining, source.fee);
    remaining -= step.amountIn + step.fee; output += step.amountOut; fee += step.fee;
    if (step.price === boundary) {
      if (initialized) liquidity += (down ? -1n : 1n) * source.net(nextTick);
      tick = down ? nextTick - 1 : nextTick;
    } else if (step.price !== price) tick = tickAtPrice(step.price);
    assert(liquidity >= 0n); price = step.price;
  }
  const ideal = tokenIn === 0 ? amountIn * source.price ** 2n / (1n << 192n) : amountIn * (1n << 192n) / source.price ** 2n;
  return { amountIn, amountOut: output, feeInput: fee, sqrtPriceAfter: price, tickAfter: tick, liquidityAfter: liquidity, fullyFilled: remaining === 0n,
    passesSlippage: remaining === 0n && output * 10000n >= ideal * BigInt(10000 - slippageBps),
    idealOutput: ideal, outputShortfall: ideal > output ? ideal - output : 0n };
}

/** Modeled fee share on the unchanged historical path, clipped at our boundaries. */
export function modeledFeeGrowth(segment: FeeSegment, range: TickRange, ours: bigint, protocolDivisor: number) {
  if (ours === 0n || segment.fee === 0n || segment.liquidity === 0n) return 0n;
  assert(protocolDivisor === 0 || (protocolDivisor >= 4 && protocolDivisor <= 10));
  const lower = sqrtRatioAtTick(range.tickLower), upper = sqrtRatioAtTick(range.tickUpper);
  const lo = segment.from < segment.to ? segment.from : segment.to, hi = segment.from > segment.to ? segment.from : segment.to;
  const clippedLo = lo > lower ? lo : lower, clippedHi = hi < upper ? hi : upper;
  let fee = segment.fee - (protocolDivisor ? segment.fee / BigInt(protocolDivisor) : 0n);
  if (lo === hi) {
    if (segment.tickBefore < range.tickLower || segment.tickBefore >= range.tickUpper) return 0n;
  } else {
    if (clippedLo >= clippedHi) return 0n;
    const whole = delta(lo, hi, segment.liquidity, segment.token, true), part = delta(clippedLo, clippedHi, segment.liquidity, segment.token, false);
    if (whole === 0n) return 0n;
    if (clippedLo !== lo || clippedHi !== hi) fee = fee * part / whole;
  }
  return fee * (1n << 128n) / (segment.liquidity + ours);
}
