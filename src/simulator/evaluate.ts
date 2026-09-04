import { createHash } from "node:crypto";
import { subtractUint256 } from "../accounting/math.js";
import { principalAmounts } from "../backtest/principal.js";
import type {
  CanonicalRangeSimulationSource,
  RangePolicyCandidate,
  RangePolicySimulation,
} from "./domain.js";
import {
  centeredRange,
  quoteValue,
  sizeLiquidityForQuoteBudget,
  tickSpacingForFee,
  validateTickAndSqrtPrice,
} from "./math.js";

const Q128 = 1n << 128n;
const ONE_MILLION = 1_000_000n;

function validateSource(source: CanonicalRangeSimulationSource): void {
  if (source.from.blockNumber >= source.to.blockNumber) {
    throw new Error("Simulation checkpoints must be strictly block-ordered");
  }
  if (source.from.chainId !== source.to.chainId) {
    throw new Error("Simulation checkpoints have different chain IDs");
  }
  if (source.fromPool.liquidity <= 0n || source.toPool.liquidity <= 0n) {
    throw new Error("Simulation pool must have active liquidity at both endpoints");
  }
  validateTickAndSqrtPrice(source.fromPool);
  validateTickAndSqrtPrice(source.toPool);
  if (
    source.pathMinTick > source.pathMaxTick ||
    source.pathMinTick > source.fromPool.tick ||
    source.pathMinTick > source.toPool.tick ||
    source.pathMaxTick < source.fromPool.tick ||
    source.pathMaxTick < source.toPool.tick
  ) {
    throw new Error("Observed tick path does not include both endpoints");
  }
}

function policyHash(input: {
  readonly budgetQuote: bigint;
  readonly costQuote: bigint;
  readonly halfWidths: readonly number[];
}): string {
  const canonical = JSON.stringify({
    budgetQuote: input.budgetQuote.toString(),
    costQuote: input.costQuote.toString(),
    halfWidths: input.halfWidths,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function simulateStaticCenteredRanges(input: {
  readonly budgetQuote: bigint;
  readonly costQuote: bigint;
  readonly halfWidths: readonly number[];
  readonly source: CanonicalRangeSimulationSource;
}): RangePolicySimulation {
  validateSource(input.source);
  if (input.budgetQuote <= 0n) throw new Error("Simulation budget must be positive");
  if (input.costQuote < 0n || input.costQuote > input.budgetQuote) {
    throw new Error("Simulation cost must be between zero and the budget");
  }
  const halfWidths = [...input.halfWidths].sort((left, right) => left - right);
  if (
    halfWidths.length === 0 ||
    new Set(halfWidths).size !== halfWidths.length ||
    halfWidths.some((width) => !Number.isSafeInteger(width) || width <= 0)
  ) {
    throw new Error("Half-widths must be unique positive safe integers");
  }
  const tickSpacing = tickSpacingForFee(input.source.fee);
  const quoteIsToken0 = input.source.quoteToken.toLowerCase() ===
    input.source.token0.toLowerCase();
  const quoteIsToken1 = input.source.quoteToken.toLowerCase() ===
    input.source.token1.toLowerCase();
  if (quoteIsToken0 === quoteIsToken1) {
    throw new Error("Simulation pool must contain the quote token exactly once");
  }
  const feeGrowth0 = subtractUint256(
    input.source.toPool.feeGrowthGlobal0X128,
    input.source.fromPool.feeGrowthGlobal0X128,
  );
  const feeGrowth1 = subtractUint256(
    input.source.toPool.feeGrowthGlobal1X128,
    input.source.fromPool.feeGrowthGlobal1X128,
  );
  const candidates: RangePolicyCandidate[] = halfWidths.map((halfWidth) => {
    const { tickLower, tickUpper } = centeredRange({
      currentTick: input.source.fromPool.tick,
      halfWidthSpacings: halfWidth,
      tickSpacing,
    });
    const start = sizeLiquidityForQuoteBudget({
      budgetQuote: input.budgetQuote,
      quoteToken: input.source.quoteToken,
      sqrtPriceX96: input.source.fromPool.sqrtPriceX96,
      tickLower,
      tickUpper,
      token0: input.source.token0,
      token1: input.source.token1,
    });
    const base = {
      halfWidthSpacings: halfWidth,
      idleQuote: start.idleQuote.toString(),
      liquidity: start.liquidity.toString(),
      liquiditySharePpm: (
        start.liquidity * ONE_MILLION / input.source.fromPool.liquidity
      ).toString(),
      startAmount0: start.amount0.toString(),
      startAmount1: start.amount1.toString(),
      tickLower,
      tickUpper,
    };
    const pathCertified =
      input.source.pathMinTick >= tickLower &&
      input.source.pathMaxTick < tickUpper;
    if (start.liquidity === 0n || !pathCertified) {
      return {
        ...base,
        absolutePnlQuote: null,
        divergenceQuote: null,
        endAmount0: null,
        endAmount1: null,
        endPrincipalValueQuote: null,
        exclusionReason: start.liquidity === 0n
          ? "budget_too_small_for_nonzero_liquidity"
          : "observed_tick_path_crossed_range",
        fee0: null,
        fee1: null,
        feeValueQuote: null,
        grossEndValueQuote: null,
        hodlEndValueQuote: null,
        lpAlphaQuote: null,
        netEndValueQuote: null,
        rank: null,
        status: "excluded" as const,
      };
    }
    const fee0 = feeGrowth0 * start.liquidity / Q128;
    const fee1 = feeGrowth1 * start.liquidity / Q128;
    const end = principalAmounts({
      liquidity: start.liquidity,
      sqrtPriceX96: input.source.toPool.sqrtPriceX96,
      tickLower,
      tickUpper,
    });
    const endPrincipalValue = quoteValue({
      amount0: end.amount0,
      amount1: end.amount1,
      quoteToken: input.source.quoteToken,
      sqrtPriceX96: input.source.toPool.sqrtPriceX96,
      token0: input.source.token0,
      token1: input.source.token1,
    });
    const feeValue = quoteValue({
      amount0: fee0,
      amount1: fee1,
      quoteToken: input.source.quoteToken,
      sqrtPriceX96: input.source.toPool.sqrtPriceX96,
      token0: input.source.token0,
      token1: input.source.token1,
    });
    const grossEndValue = endPrincipalValue + feeValue + start.idleQuote;
    const netEndValue = grossEndValue - input.costQuote;
    const hodlEndValue = quoteValue({
      amount0: start.amount0 + (quoteIsToken0 ? start.idleQuote : 0n),
      amount1: start.amount1 + (quoteIsToken1 ? start.idleQuote : 0n),
      quoteToken: input.source.quoteToken,
      sqrtPriceX96: input.source.toPool.sqrtPriceX96,
      token0: input.source.token0,
      token1: input.source.token1,
    });
    const divergenceQuote = endPrincipalValue + start.idleQuote - hodlEndValue;
    return {
      ...base,
      absolutePnlQuote: (netEndValue - input.budgetQuote).toString(),
      divergenceQuote: divergenceQuote.toString(),
      endAmount0: end.amount0.toString(),
      endAmount1: end.amount1.toString(),
      endPrincipalValueQuote: endPrincipalValue.toString(),
      exclusionReason: null,
      fee0: fee0.toString(),
      fee1: fee1.toString(),
      feeValueQuote: feeValue.toString(),
      grossEndValueQuote: grossEndValue.toString(),
      hodlEndValueQuote: hodlEndValue.toString(),
      lpAlphaQuote: (netEndValue - hodlEndValue).toString(),
      netEndValueQuote: netEndValue.toString(),
      rank: null,
      status: "complete" as const,
    };
  });
  const ranked = candidates
    .filter((candidate) => candidate.status === "complete")
    .sort((left, right) => {
      const leftAlpha = BigInt(left.lpAlphaQuote!);
      const rightAlpha = BigInt(right.lpAlphaQuote!);
      if (leftAlpha === rightAlpha) {
        return left.halfWidthSpacings - right.halfWidthSpacings;
      }
      return leftAlpha > rightAlpha ? -1 : 1;
    });
  const ranks = new Map(ranked.map((candidate, index) => [
    candidate.halfWidthSpacings,
    index + 1,
  ]));
  const rankedCandidates = candidates.map((candidate) => candidate.status === "complete"
    ? { ...candidate, rank: ranks.get(candidate.halfWidthSpacings)! }
    : candidate
  );
  return {
    assumptions: [
      "pool_spot_mark_to_market_not_oracle",
      "observed_price_path_assumed_unchanged",
      "observed_fee_growth_zero_impact_no_self_dilution",
      "same_post_entry_inventory_hodl_benchmark",
      "configured_cost_applied_once_to_each_candidate",
      "no_fee_compounding",
      "single_interval_static_ranges_no_rebalancing",
      "crossed_range_paths_excluded",
    ],
    budgetQuote: input.budgetQuote.toString(),
    candidates: rankedCandidates,
    completedCandidates: rankedCandidates.filter((candidate) =>
      candidate.status === "complete"
    ).length,
    computedAt: new Date().toISOString(),
    costQuote: input.costQuote.toString(),
    excludedCandidates: rankedCandidates.filter((candidate) =>
      candidate.status === "excluded"
    ).length,
    executionEligible: false,
    fee: input.source.fee,
    from: input.source.from,
    methodology: "static_centered_observed_fee_growth_v1",
    pathMaxTick: input.source.pathMaxTick,
    pathMinTick: input.source.pathMinTick,
    policySetHash: policyHash({
      budgetQuote: input.budgetQuote,
      costQuote: input.costQuote,
      halfWidths,
    }),
    poolAddress: input.source.poolAddress,
    quoteDecimals: 6,
    quoteToken: input.source.quoteToken,
    rwaSymbol: input.source.rwaSymbol,
    schemaVersion: 1,
    streamKey: input.source.streamKey,
    swapCount: input.source.swapCount.toString(),
    tickSpacing,
    to: input.source.to,
    token0: input.source.token0,
    token1: input.source.token1,
  };
}
