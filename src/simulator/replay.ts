import { createHash } from "node:crypto";
import { subtractUint256 } from "../accounting/math.js";
import { principalAmounts } from "../backtest/principal.js";
import type {
  CanonicalRangePolicyReplaySource,
  RangePolicyReplay,
  RangePolicyReplayCandidate,
  RangePolicyReplayStep,
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

interface CandidateState {
  idle0: bigint;
  idle1: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

function absolute(value: number): number {
  return value < 0 ? -value : value;
}

function validateSource(source: CanonicalRangePolicyReplaySource): void {
  if (source.checkpoints.length < 2) {
    throw new Error("Policy replay requires at least two checkpoints");
  }
  if (source.intervals.length !== source.checkpoints.length - 1) {
    throw new Error("Policy replay requires one interval between every checkpoint");
  }
  const chainId = source.checkpoints[0]!.run.chainId;
  const quoteIsToken0 = source.quoteToken.toLowerCase() ===
    source.token0.toLowerCase();
  const quoteIsToken1 = source.quoteToken.toLowerCase() ===
    source.token1.toLowerCase();
  if (quoteIsToken0 === quoteIsToken1) {
    throw new Error("Policy replay pool must contain the quote token exactly once");
  }
  for (let index = 0; index < source.checkpoints.length; index += 1) {
    const checkpoint = source.checkpoints[index]!;
    validateTickAndSqrtPrice(checkpoint.pool);
    if (checkpoint.pool.liquidity <= 0n) {
      throw new Error("Policy replay pool must have active endpoint liquidity");
    }
    if (checkpoint.run.chainId !== chainId) {
      throw new Error("Policy replay checkpoints have different chain IDs");
    }
    if (
      index > 0 &&
      source.checkpoints[index - 1]!.run.blockNumber >= checkpoint.run.blockNumber
    ) {
      throw new Error("Policy replay checkpoints must be strictly block-ordered");
    }
  }
  for (let index = 0; index < source.intervals.length; index += 1) {
    const interval = source.intervals[index]!;
    const from = source.checkpoints[index]!;
    const to = source.checkpoints[index + 1]!;
    if (
      interval.fromRunId !== from.run.runId ||
      interval.toRunId !== to.run.runId
    ) {
      throw new Error("Policy replay interval IDs do not match checkpoint order");
    }
    if (
      interval.swapCount < 0n ||
      interval.pathMinTick > interval.pathMaxTick ||
      interval.pathMinTick > from.pool.tick ||
      interval.pathMinTick > to.pool.tick ||
      interval.pathMaxTick < from.pool.tick ||
      interval.pathMaxTick < to.pool.tick
    ) {
      throw new Error("Policy replay tick path does not include both endpoints");
    }
  }
}

function addQuoteIdle(input: {
  amount: bigint;
  quoteToken: string;
  state: CandidateState;
  token0: string;
}): void {
  if (input.quoteToken.toLowerCase() === input.token0.toLowerCase()) {
    input.state.idle0 += input.amount;
  } else {
    input.state.idle1 += input.amount;
  }
}

function holdings(input: {
  readonly sqrtPriceX96: bigint;
  readonly state: CandidateState;
}): { readonly amount0: bigint; readonly amount1: bigint } {
  const principal = principalAmounts({
    liquidity: input.state.liquidity,
    sqrtPriceX96: input.sqrtPriceX96,
    tickLower: input.state.tickLower,
    tickUpper: input.state.tickUpper,
  });
  return {
    amount0: principal.amount0 + input.state.idle0,
    amount1: principal.amount1 + input.state.idle1,
  };
}

function maxDrawdownPpm(peak: bigint, value: bigint): bigint {
  if (peak <= 0n || value >= peak) return 0n;
  return (peak - value) * ONE_MILLION / peak;
}

function policyHash(input: {
  readonly budgetQuote: bigint;
  readonly entryCostQuote: bigint;
  readonly halfWidths: readonly number[];
  readonly rebalanceCostQuote: bigint;
  readonly triggerPercent: number;
}): string {
  const canonical = JSON.stringify({
    budgetQuote: input.budgetQuote.toString(),
    entryCostQuote: input.entryCostQuote.toString(),
    halfWidths: input.halfWidths,
    rebalanceCostQuote: input.rebalanceCostQuote.toString(),
    triggerPercent: input.triggerPercent,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function replayRangePolicies(input: {
  readonly budgetQuote: bigint;
  readonly entryCostQuote: bigint;
  readonly halfWidths: readonly number[];
  readonly rebalanceCostQuote: bigint;
  readonly source: CanonicalRangePolicyReplaySource;
  readonly triggerPercent: number;
}): RangePolicyReplay {
  validateSource(input.source);
  if (input.budgetQuote <= 0n) throw new Error("Policy replay budget must be positive");
  if (input.entryCostQuote < 0n || input.entryCostQuote >= input.budgetQuote) {
    throw new Error("Policy replay entry cost must be nonnegative and below budget");
  }
  if (input.rebalanceCostQuote < 0n) {
    throw new Error("Policy replay rebalance cost must be nonnegative");
  }
  if (
    !Number.isSafeInteger(input.triggerPercent) ||
    input.triggerPercent < 1 || input.triggerPercent > 100
  ) {
    throw new Error("Policy replay trigger percent must be an integer from 1 to 100");
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
  const first = input.source.checkpoints[0]!;
  const last = input.source.checkpoints.at(-1)!;
  const quoteIsToken0 = input.source.quoteToken.toLowerCase() ===
    input.source.token0.toLowerCase();
  const startingCapital = input.budgetQuote - input.entryCostQuote;

  const candidates: RangePolicyReplayCandidate[] = halfWidths.map((halfWidth) => {
    const initialRange = centeredRange({
      currentTick: first.pool.tick,
      halfWidthSpacings: halfWidth,
      tickSpacing,
    });
    const initial = sizeLiquidityForQuoteBudget({
      budgetQuote: startingCapital,
      quoteToken: input.source.quoteToken,
      sqrtPriceX96: first.pool.sqrtPriceX96,
      ...initialRange,
      token0: input.source.token0,
      token1: input.source.token1,
    });
    if (initial.liquidity === 0n) {
      return {
        absolutePnlQuote: null,
        completedIntervals: 0,
        failureReason: "budget_too_small_for_nonzero_liquidity",
        failureRunId: first.run.runId,
        feeValueQuote: "0",
        finalLiquidity: null,
        finalNavQuote: null,
        finalTickLower: null,
        finalTickUpper: null,
        halfWidthSpacings: halfWidth,
        hodlEndValueQuote: null,
        lpAlphaQuote: null,
        maxDrawdownPpm: "0",
        rank: null,
        rebalances: 0,
        status: "excluded" as const,
        steps: [],
        totalCostQuote: input.entryCostQuote.toString(),
      };
    }
    const state: CandidateState = {
      idle0: quoteIsToken0 ? initial.idleQuote : 0n,
      idle1: quoteIsToken0 ? 0n : initial.idleQuote,
      liquidity: initial.liquidity,
      ...initialRange,
    };
    const hodl0 = initial.amount0 + state.idle0;
    const hodl1 = initial.amount1 + state.idle1;
    const steps: RangePolicyReplayStep[] = [];
    let completedIntervals = 0;
    let cumulativeFeeValue = 0n;
    let failureReason: string | null = null;
    let failureRunId: string | null = null;
    let maxDrawdown = 0n;
    let peakNav = startingCapital;
    let rebalances = 0;
    let totalCost = input.entryCostQuote;

    for (let index = 0; index < input.source.intervals.length; index += 1) {
      const interval = input.source.intervals[index]!;
      const from = input.source.checkpoints[index]!;
      const to = input.source.checkpoints[index + 1]!;
      const intervalTickLower = state.tickLower;
      const intervalTickUpper = state.tickUpper;
      if (
        interval.pathMinTick < intervalTickLower ||
        interval.pathMaxTick >= intervalTickUpper
      ) {
        failureReason = "observed_tick_path_crossed_range";
        failureRunId = to.run.runId;
        break;
      }
      const fee0 = subtractUint256(
        to.pool.feeGrowthGlobal0X128,
        from.pool.feeGrowthGlobal0X128,
      ) * state.liquidity / Q128;
      const fee1 = subtractUint256(
        to.pool.feeGrowthGlobal1X128,
        from.pool.feeGrowthGlobal1X128,
      ) * state.liquidity / Q128;
      state.idle0 += fee0;
      state.idle1 += fee1;
      const feeValue = quoteValue({
        amount0: fee0,
        amount1: fee1,
        quoteToken: input.source.quoteToken,
        sqrtPriceX96: to.pool.sqrtPriceX96,
        token0: input.source.token0,
        token1: input.source.token1,
      });
      cumulativeFeeValue += feeValue;
      const beforeAction = holdings({
        sqrtPriceX96: to.pool.sqrtPriceX96,
        state,
      });
      let nav = quoteValue({
        ...beforeAction,
        quoteToken: input.source.quoteToken,
        sqrtPriceX96: to.pool.sqrtPriceX96,
        token0: input.source.token0,
        token1: input.source.token1,
      });
      const centerTick = intervalTickLower +
        Math.floor((intervalTickUpper - intervalTickLower) / 2);
      const triggerSpacings = Math.max(
        1,
        Math.floor(halfWidth * input.triggerPercent / 100),
      );
      const shouldRebalance = absolute(to.pool.tick - centerTick) >=
        triggerSpacings * tickSpacing;
      let actionCost = 0n;
      let rebalanced = false;
      if (shouldRebalance) {
        if (nav <= input.rebalanceCostQuote) {
          failureReason = "rebalance_cost_exhausted_capital";
          failureRunId = to.run.runId;
        } else {
          const proposedCost = input.rebalanceCostQuote;
          const afterCost = nav - proposedCost;
          const nextRange = centeredRange({
            currentTick: to.pool.tick,
            halfWidthSpacings: halfWidth,
            tickSpacing,
          });
          const next = sizeLiquidityForQuoteBudget({
            budgetQuote: afterCost,
            quoteToken: input.source.quoteToken,
            sqrtPriceX96: to.pool.sqrtPriceX96,
            ...nextRange,
            token0: input.source.token0,
            token1: input.source.token1,
          });
          if (next.liquidity === 0n) {
            failureReason = "rebalance_budget_too_small_for_nonzero_liquidity";
            failureRunId = to.run.runId;
          } else {
            state.liquidity = next.liquidity;
            state.tickLower = nextRange.tickLower;
            state.tickUpper = nextRange.tickUpper;
            state.idle0 = 0n;
            state.idle1 = 0n;
            addQuoteIdle({
              amount: next.idleQuote,
              quoteToken: input.source.quoteToken,
              state,
              token0: input.source.token0,
            });
            nav = afterCost;
            actionCost = proposedCost;
            rebalanced = true;
            rebalances += 1;
            totalCost += actionCost;
          }
        }
      }
      const hodlValue = quoteValue({
        amount0: hodl0,
        amount1: hodl1,
        quoteToken: input.source.quoteToken,
        sqrtPriceX96: to.pool.sqrtPriceX96,
        token0: input.source.token0,
        token1: input.source.token1,
      });
      if (nav > peakNav) peakNav = nav;
      const drawdown = maxDrawdownPpm(peakNav, nav);
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      steps.push({
        actionCostQuote: actionCost.toString(),
        fee0: fee0.toString(),
        fee1: fee1.toString(),
        feeValueQuote: feeValue.toString(),
        fromRunId: from.run.runId,
        hodlValueQuote: hodlValue.toString(),
        index,
        lpAlphaQuote: (nav - hodlValue).toString(),
        navQuote: nav.toString(),
        pathMaxTick: interval.pathMaxTick,
        pathMinTick: interval.pathMinTick,
        rebalanced,
        tickLower: intervalTickLower,
        tickUpper: intervalTickUpper,
        toRunId: to.run.runId,
      });
      completedIntervals += 1;
      if (failureReason !== null) break;
    }

    if (failureReason !== null) {
      return {
        absolutePnlQuote: null,
        completedIntervals,
        failureReason,
        failureRunId,
        feeValueQuote: cumulativeFeeValue.toString(),
        finalLiquidity: null,
        finalNavQuote: null,
        finalTickLower: null,
        finalTickUpper: null,
        halfWidthSpacings: halfWidth,
        hodlEndValueQuote: null,
        lpAlphaQuote: null,
        maxDrawdownPpm: maxDrawdown.toString(),
        rank: null,
        rebalances,
        status: "excluded" as const,
        steps,
        totalCostQuote: totalCost.toString(),
      };
    }
    const finalStep = steps.at(-1)!;
    const finalNav = BigInt(finalStep.navQuote);
    const hodlEndValue = BigInt(finalStep.hodlValueQuote);
    return {
      absolutePnlQuote: (finalNav - input.budgetQuote).toString(),
      completedIntervals,
      failureReason: null,
      failureRunId: null,
      feeValueQuote: cumulativeFeeValue.toString(),
      finalLiquidity: state.liquidity.toString(),
      finalNavQuote: finalNav.toString(),
      finalTickLower: state.tickLower,
      finalTickUpper: state.tickUpper,
      halfWidthSpacings: halfWidth,
      hodlEndValueQuote: hodlEndValue.toString(),
      lpAlphaQuote: (finalNav - hodlEndValue).toString(),
      maxDrawdownPpm: maxDrawdown.toString(),
      rank: null,
      rebalances,
      status: "complete" as const,
      steps,
      totalCostQuote: totalCost.toString(),
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
  const rankedCandidates = candidates.map((candidate) => ({
    ...candidate,
    rank: ranks.get(candidate.halfWidthSpacings) ?? null,
  }));
  return {
    assumptions: [
      "pool spot, not oracle mark",
      "observed price path is unchanged",
      "zero impact and no self-dilution",
      "ideal spot recomposition at triggers",
      "operator-supplied costs are illustrative",
      "same post-entry inventory hold benchmark",
      "fees remain idle until a rebalance",
      "crossed intervals stop without fee invention",
      "trigger checks occur only at checkpoints",
    ],
    budgetQuote: input.budgetQuote.toString(),
    candidates: rankedCandidates,
    checkpointCount: input.source.checkpoints.length,
    completedCandidates: ranked.length,
    computedAt: new Date().toISOString(),
    entryCostQuote: input.entryCostQuote.toString(),
    excludedCandidates: rankedCandidates.length - ranked.length,
    executionEligible: false,
    fee: input.source.fee,
    first: first.run,
    intervalCount: input.source.intervals.length,
    last: last.run,
    methodology: "stateful_certified_interval_replay_v1",
    policySetHash: policyHash({
      budgetQuote: input.budgetQuote,
      entryCostQuote: input.entryCostQuote,
      halfWidths,
      rebalanceCostQuote: input.rebalanceCostQuote,
      triggerPercent: input.triggerPercent,
    }),
    poolAddress: input.source.poolAddress,
    quoteDecimals: 6,
    quoteToken: input.source.quoteToken,
    rebalanceCostQuote: input.rebalanceCostQuote.toString(),
    rwaSymbol: input.source.rwaSymbol,
    schemaVersion: 1,
    streamKey: input.source.streamKey,
    tickSpacing,
    token0: input.source.token0,
    token1: input.source.token1,
    triggerPercent: input.triggerPercent,
  };
}
