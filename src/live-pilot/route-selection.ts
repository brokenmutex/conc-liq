import assert from "node:assert/strict";

/** A quote for one candidate fee tier at the decision block. `gas` is the
 * quoter's own gas estimate for the swap; `amountOut` is in the output token. */
export interface RouteQuote {
  readonly fee: number;
  readonly amountOut: bigint;
  readonly gas: bigint;
}

export interface RoutePricing {
  /** Effective gas price in wei. */
  readonly gasPriceWei: bigint;
  /** Value of 1e18 wei of native gas, in output-token units scaled by 1e18. */
  readonly nativePerGasTokenX18: bigint;
  /** A candidate must beat the baseline by at least this much, in output-token
   * units, after its own extra gas. Covers quoter-to-fill drift. */
  readonly minimumGainOut: bigint;
}

export interface RouteSelection {
  readonly fee: number;
  readonly amountOut: bigint;
  readonly gas: bigint;
  readonly baselineFee: number;
  readonly gainOut: bigint;
  readonly reason: "baseline" | "better_net_of_gas";
}

const gasCostOut = (gas: bigint, pricing: RoutePricing) =>
  gas * pricing.gasPriceWei * pricing.nativePerGasTokenX18 / 10n ** 18n;

/** Pick the best fee tier net of its own gas, defaulting to the baseline.
 *
 * The 250-USDG pilot re-quoted all 58 of its swaps through QuoterV2 at their
 * source blocks: the 3000 pool beat the 500 pool on 19 of them, median +4.2
 * bps, +0.64 USDG in total, but across all 58 it was a median 7.7 bps worse.
 * The choice is therefore per trade and cannot be made once. The 100 pool was
 * unusable (-2,800 bps median) and the 10000 pool had no liquidity, so a
 * candidate that fails to quote is simply absent rather than disqualifying.
 *
 * Selection is on output net of the route's *own* gas, not gross output. At
 * the pilot's typical 115-USDG swap an aggregator's extra 310k gas cost more
 * than its 6 bps of extra output; the same arithmetic applies to any tier
 * whose quote costs more gas than the baseline's.
 *
 * This decides which quote to build calldata from. It does not accept the
 * route: `acceptSimulatedRoute` does that, after the calldata is simulated. */
export function selectSwapRoute(
  quotes: readonly RouteQuote[],
  baselineFee: number,
  pricing: RoutePricing,
): RouteSelection {
  assert(Number.isInteger(baselineFee) && baselineFee > 0, "Baseline fee tier is not a V3 tier");
  assert(pricing.gasPriceWei >= 0n && pricing.nativePerGasTokenX18 >= 0n && pricing.minimumGainOut >= 0n);
  const baseline = quotes.find(q => q.fee === baselineFee);
  assert(baseline, "The baseline pool must be quoted; a missing baseline is not a routing decision");
  assert(baseline.amountOut > 0n, "Baseline quote returned no output");
  const net = (q: RouteQuote) => q.amountOut - gasCostOut(q.gas, pricing);
  const baselineNet = net(baseline);
  let best = baseline, bestNet = baselineNet;
  for (const q of quotes) {
    if (q.fee === baselineFee || q.amountOut <= 0n) continue;
    assert(Number.isInteger(q.fee) && q.fee > 0 && q.gas >= 0n, "Malformed candidate quote");
    const candidateNet = net(q);
    if (candidateNet > bestNet) { best = q; bestNet = candidateNet; }
  }
  const gainOut = bestNet - baselineNet;
  if (best.fee === baselineFee || gainOut < pricing.minimumGainOut) {
    return { fee: baseline.fee, amountOut: baseline.amountOut, gas: baseline.gas,
      baselineFee, gainOut: 0n, reason: "baseline" };
  }
  return { fee: best.fee, amountOut: best.amountOut, gas: best.gas, baselineFee, gainOut,
    reason: "better_net_of_gas" };
}

/** Accept a selected route only after its exact calldata has been simulated
 * from the operator account at the source block.
 *
 * Two independent conditions, both required. The simulated output must still
 * beat the baseline quote net of the route's own gas by the minimum margin --
 * a route that only wins on the quoter's optimism is not a win. And the
 * simulation must not come in more than `slippageBps` below its own quote;
 * the Kyber probes returned 2.0-3.3 bps under quote when simulated, so this
 * bound is measuring a real effect, not a formality. */
export function acceptSimulatedRoute(input: {
  readonly selection: RouteSelection;
  readonly baselineQuoteOut: bigint;
  readonly baselineGas: bigint;
  readonly simulatedOut: bigint;
  readonly pricing: RoutePricing;
  readonly slippageBps: number;
}): { accepted: boolean; reason: string } {
  const { selection, simulatedOut, pricing, slippageBps } = input;
  assert(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 10_000);
  if (selection.reason === "baseline") return { accepted: true, reason: "baseline" };
  if (simulatedOut <= 0n) return { accepted: false, reason: "route_simulation_empty" };
  if (simulatedOut * 10_000n < selection.amountOut * BigInt(10_000 - slippageBps)) {
    return { accepted: false, reason: "route_simulation_below_quote" };
  }
  const simulatedNet = simulatedOut - gasCostOut(selection.gas, pricing);
  const baselineNet = input.baselineQuoteOut - gasCostOut(input.baselineGas, pricing);
  if (simulatedNet - baselineNet < pricing.minimumGainOut) {
    return { accepted: false, reason: "route_gain_below_minimum" };
  }
  return { accepted: true, reason: "better_net_of_gas" };
}
