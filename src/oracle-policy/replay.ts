import { createHash } from "node:crypto";
import { subtractUint256 } from "../accounting/math.js";
import { principalAmounts } from "../backtest/principal.js";
import { poolQuotePerRwaX18 } from "../oracle/math.js";
import {
  centeredRange,
  quoteValue,
  sizeLiquidityForQuoteBudget,
  tickSpacingForFee,
  validateTickAndSqrtPrice,
} from "../simulator/math.js";
import type {
  OraclePolicyCheckpoint,
  OraclePolicyReplay,
  OraclePolicyReplayCandidate,
  OraclePolicyReplaySource,
  OraclePolicyReplayStep,
} from "./domain.js";
import { oracleMarkedQuoteValue } from "./math.js";

const Q128 = 1n << 128n;
const ONE_MILLION = 1_000_000n;
const QUOTE_DECIMALS = 6;

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

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function invalidMarkReason(checkpoint: OraclePolicyCheckpoint): string {
  return `invalid_oracle_mark:${checkpoint.reasons.join(",")}`;
}

function validateSource(source: OraclePolicyReplaySource): void {
  if (source.checkpoints.length < 2) {
    throw new Error("Oracle policy replay requires at least two checkpoints");
  }
  if (source.intervals.length !== source.checkpoints.length - 1) {
    throw new Error("Oracle policy replay requires one interval between every checkpoint");
  }
  if (
    !Number.isSafeInteger(source.rwaDecimals) ||
    source.rwaDecimals < 0 || source.rwaDecimals > 255
  ) {
    throw new Error("Oracle policy replay RWA decimals are invalid");
  }
  const quoteIsToken0 = sameAddress(source.quoteToken, source.token0);
  const quoteIsToken1 = sameAddress(source.quoteToken, source.token1);
  if (quoteIsToken0 === quoteIsToken1) {
    throw new Error("Oracle policy replay pool must contain the quote token exactly once");
  }
  const rwaToken = quoteIsToken0 ? source.token1 : source.token0;
  if (!sameAddress(rwaToken, source.rwaAddress)) {
    throw new Error("Oracle policy replay RWA token does not match pool identity");
  }
  const chainId = source.checkpoints[0]!.run.chainId;
  for (let index = 0; index < source.checkpoints.length; index += 1) {
    const checkpoint = source.checkpoints[index]!;
    validateTickAndSqrtPrice(checkpoint.pool);
    if (checkpoint.pool.liquidity < 0n) {
      throw new Error("Oracle policy replay pool liquidity cannot be negative");
    }
    if (checkpoint.poolPriceX18 <= 0n) {
      throw new Error("Oracle policy replay pool price must be positive");
    }
    const expectedPoolPrice = poolQuotePerRwaX18({
      quoteDecimals: QUOTE_DECIMALS,
      quoteToken: source.quoteToken,
      rwaDecimals: source.rwaDecimals,
      sqrtPriceX96: checkpoint.pool.sqrtPriceX96,
      token0: source.token0,
      token1: source.token1,
    });
    if (checkpoint.poolPriceX18 !== expectedPoolPrice) {
      throw new Error("Oracle policy replay stored pool price is inconsistent");
    }
    if (checkpoint.tokenDecimals !== source.rwaDecimals) {
      throw new Error("Oracle policy replay token decimals changed across checkpoints");
    }
    if (checkpoint.run.chainId !== chainId) {
      throw new Error("Oracle policy replay checkpoints have different chain IDs");
    }
    if (
      index > 0 &&
      source.checkpoints[index - 1]!.run.blockNumber >= checkpoint.run.blockNumber
    ) {
      throw new Error("Oracle policy replay checkpoints must be strictly block-ordered");
    }
    if (checkpoint.status === "valid") {
      if (checkpoint.reasons.length !== 0 || checkpoint.oraclePriceX18 === null) {
        throw new Error("A valid oracle policy checkpoint has an invalid mark");
      }
      if (checkpoint.oraclePriceX18 <= 0n) {
        throw new Error("Oracle policy replay oracle price must be positive");
      }
      if (checkpoint.pool.liquidity === 0n) {
        throw new Error("A valid oracle policy checkpoint has zero pool liquidity");
      }
    } else if (checkpoint.reasons.length === 0) {
      throw new Error("An excluded oracle policy checkpoint has no reasons");
    }
  }
  const last = source.checkpoints.at(-1)!;
  if (source.indexedThroughBlock < last.run.blockNumber) {
    throw new Error("Indexed event coverage does not reach the final checkpoint");
  }
  for (let index = 0; index < source.intervals.length; index += 1) {
    const interval = source.intervals[index]!;
    const from = source.checkpoints[index]!;
    const to = source.checkpoints[index + 1]!;
    if (
      interval.fromRunId !== from.run.checkpointRunId ||
      interval.toRunId !== to.run.checkpointRunId
    ) {
      throw new Error("Oracle policy interval IDs do not match checkpoint order");
    }
    if (
      interval.swapCount < 0n ||
      interval.pathMinTick > interval.pathMaxTick ||
      interval.pathMinTick > from.pool.tick ||
      interval.pathMinTick > to.pool.tick ||
      interval.pathMaxTick < from.pool.tick ||
      interval.pathMaxTick < to.pool.tick
    ) {
      throw new Error("Oracle policy tick path does not include both endpoints");
    }
  }
}

function addQuoteIdle(input: {
  readonly amount: bigint;
  readonly quoteToken: string;
  readonly state: CandidateState;
  readonly token0: string;
}): void {
  if (sameAddress(input.quoteToken, input.token0)) {
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

function markedValue(input: {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly checkpoint: OraclePolicyCheckpoint;
  readonly source: OraclePolicyReplaySource;
}): bigint {
  if (input.checkpoint.status !== "valid" || input.checkpoint.oraclePriceX18 === null) {
    throw new Error("Cannot value inventory with an invalid oracle mark");
  }
  return oracleMarkedQuoteValue({
    amount0: input.amount0,
    amount1: input.amount1,
    oraclePriceX18: input.checkpoint.oraclePriceX18,
    quoteDecimals: QUOTE_DECIMALS,
    quoteToken: input.source.quoteToken,
    rwaDecimals: input.source.rwaDecimals,
    token0: input.source.token0,
    token1: input.source.token1,
  });
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
    methodology: "oracle_marked_stateful_certified_replay_v1",
    rebalanceCostQuote: input.rebalanceCostQuote.toString(),
    triggerPercent: input.triggerPercent,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function excludedCandidate(input: {
  readonly completedIntervals: number;
  readonly failureCheckpointRunId: string;
  readonly failureReason: string;
  readonly halfWidthSpacings: number;
  readonly initialAmount0: bigint | null;
  readonly initialAmount1: bigint | null;
  readonly initialNav: bigint | null;
  readonly markedFeeValue: bigint;
  readonly maxDrawdown: bigint;
  readonly rebalances: number;
  readonly steps: readonly OraclePolicyReplayStep[];
  readonly totalCost: bigint;
}): OraclePolicyReplayCandidate {
  return {
    absolutePnlQuote: null,
    completedIntervals: input.completedIntervals,
    failureCheckpointRunId: input.failureCheckpointRunId,
    failureReason: input.failureReason,
    finalAmount0: null,
    finalAmount1: null,
    finalLiquidity: null,
    finalNavQuote: null,
    finalTickLower: null,
    finalTickUpper: null,
    halfWidthSpacings: input.halfWidthSpacings,
    hodlEndValueQuote: null,
    initialAmount0: input.initialAmount0?.toString() ?? null,
    initialAmount1: input.initialAmount1?.toString() ?? null,
    initialNavQuote: input.initialNav?.toString() ?? null,
    lpAlphaQuote: null,
    markedFeeValueQuote: input.markedFeeValue.toString(),
    maxDrawdownPpm: input.maxDrawdown.toString(),
    rank: null,
    rebalances: input.rebalances,
    status: "excluded",
    steps: input.steps,
    totalCostQuote: input.totalCost.toString(),
  };
}

export function replayOracleMarkedPolicies(input: {
  readonly budgetQuote: bigint;
  readonly entryCostQuote: bigint;
  readonly halfWidths: readonly number[];
  readonly rebalanceCostQuote: bigint;
  readonly source: OraclePolicyReplaySource;
  readonly triggerPercent: number;
}): OraclePolicyReplay {
  validateSource(input.source);
  if (input.budgetQuote <= 0n) {
    throw new Error("Oracle policy replay budget must be positive");
  }
  if (input.entryCostQuote < 0n || input.entryCostQuote >= input.budgetQuote) {
    throw new Error("Oracle policy replay entry cost must be nonnegative and below budget");
  }
  if (input.rebalanceCostQuote < 0n) {
    throw new Error("Oracle policy replay rebalance cost must be nonnegative");
  }
  if (
    !Number.isSafeInteger(input.triggerPercent) ||
    input.triggerPercent < 1 || input.triggerPercent > 100
  ) {
    throw new Error("Oracle policy replay trigger percent must be an integer from 1 to 100");
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
  const quoteIsToken0 = sameAddress(input.source.quoteToken, input.source.token0);
  const startingCapital = input.budgetQuote - input.entryCostQuote;

  const candidates: OraclePolicyReplayCandidate[] = halfWidths.map((halfWidth) => {
    if (first.status !== "valid") {
      return excludedCandidate({
        completedIntervals: 0,
        failureCheckpointRunId: first.run.checkpointRunId,
        failureReason: invalidMarkReason(first),
        halfWidthSpacings: halfWidth,
        initialAmount0: null,
        initialAmount1: null,
        initialNav: null,
        markedFeeValue: 0n,
        maxDrawdown: 0n,
        rebalances: 0,
        steps: [],
        totalCost: 0n,
      });
    }
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
    const initialAmount0 = initial.amount0 + (quoteIsToken0 ? initial.idleQuote : 0n);
    const initialAmount1 = initial.amount1 + (quoteIsToken0 ? 0n : initial.idleQuote);
    if (initial.liquidity === 0n) {
      return excludedCandidate({
        completedIntervals: 0,
        failureCheckpointRunId: first.run.checkpointRunId,
        failureReason: "budget_too_small_for_nonzero_liquidity",
        halfWidthSpacings: halfWidth,
        initialAmount0,
        initialAmount1,
        initialNav: markedValue({
          amount0: initialAmount0,
          amount1: initialAmount1,
          checkpoint: first,
          source: input.source,
        }),
        markedFeeValue: 0n,
        maxDrawdown: 0n,
        rebalances: 0,
        steps: [],
        totalCost: input.entryCostQuote,
      });
    }

    const state: CandidateState = {
      idle0: quoteIsToken0 ? initial.idleQuote : 0n,
      idle1: quoteIsToken0 ? 0n : initial.idleQuote,
      liquidity: initial.liquidity,
      ...initialRange,
    };
    const hodl0 = initialAmount0;
    const hodl1 = initialAmount1;
    const initialNav = markedValue({
      amount0: initialAmount0,
      amount1: initialAmount1,
      checkpoint: first,
      source: input.source,
    });
    const steps: OraclePolicyReplayStep[] = [];
    let completedIntervals = 0;
    let failureReason: string | null = null;
    let failureCheckpointRunId: string | null = null;
    let markedFeeValue = 0n;
    let maxDrawdown = 0n;
    let peakNav = initialNav;
    let rebalances = 0;
    let totalCost = input.entryCostQuote;

    for (let index = 0; index < input.source.intervals.length; index += 1) {
      const interval = input.source.intervals[index]!;
      const from = input.source.checkpoints[index]!;
      const to = input.source.checkpoints[index + 1]!;
      if (to.status !== "valid") {
        failureReason = invalidMarkReason(to);
        failureCheckpointRunId = to.run.checkpointRunId;
        break;
      }
      const activeTickLower = state.tickLower;
      const activeTickUpper = state.tickUpper;
      if (
        interval.pathMinTick < activeTickLower ||
        interval.pathMaxTick >= activeTickUpper
      ) {
        failureReason = "observed_tick_path_crossed_range";
        failureCheckpointRunId = to.run.checkpointRunId;
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
      const feeValue = markedValue({
        amount0: fee0,
        amount1: fee1,
        checkpoint: to,
        source: input.source,
      });
      markedFeeValue += feeValue;
      const beforeAction = holdings({
        sqrtPriceX96: to.pool.sqrtPriceX96,
        state,
      });
      const poolSpotNavBeforeAction = quoteValue({
        ...beforeAction,
        quoteToken: input.source.quoteToken,
        sqrtPriceX96: to.pool.sqrtPriceX96,
        token0: input.source.token0,
        token1: input.source.token1,
      });
      const centerTick = activeTickLower +
        Math.floor((activeTickUpper - activeTickLower) / 2);
      const triggerSpacings = Math.max(
        1,
        Math.floor(halfWidth * input.triggerPercent / 100),
      );
      const shouldRebalance = absolute(to.pool.tick - centerTick) >=
        triggerSpacings * tickSpacing;
      let actionCost = 0n;
      let rebalanced = false;
      if (shouldRebalance) {
        if (poolSpotNavBeforeAction <= input.rebalanceCostQuote) {
          failureReason = "rebalance_cost_exhausted_pool_spot_capital";
          failureCheckpointRunId = to.run.checkpointRunId;
        } else {
          const nextRange = centeredRange({
            currentTick: to.pool.tick,
            halfWidthSpacings: halfWidth,
            tickSpacing,
          });
          const next = sizeLiquidityForQuoteBudget({
            budgetQuote: poolSpotNavBeforeAction - input.rebalanceCostQuote,
            quoteToken: input.source.quoteToken,
            sqrtPriceX96: to.pool.sqrtPriceX96,
            ...nextRange,
            token0: input.source.token0,
            token1: input.source.token1,
          });
          if (next.liquidity === 0n) {
            failureReason = "rebalance_budget_too_small_for_nonzero_liquidity";
            failureCheckpointRunId = to.run.checkpointRunId;
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
            actionCost = input.rebalanceCostQuote;
            rebalanced = true;
            rebalances += 1;
            totalCost += actionCost;
          }
        }
      }

      const end = holdings({ sqrtPriceX96: to.pool.sqrtPriceX96, state });
      const nav = markedValue({
        ...end,
        checkpoint: to,
        source: input.source,
      });
      const hodlValue = markedValue({
        amount0: hodl0,
        amount1: hodl1,
        checkpoint: to,
        source: input.source,
      });
      if (nav > peakNav) peakNav = nav;
      const drawdown = maxDrawdownPpm(peakNav, nav);
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      steps.push({
        actionCostQuote: actionCost.toString(),
        activeTickLower,
        activeTickUpper,
        endAmount0: end.amount0.toString(),
        endAmount1: end.amount1.toString(),
        endingTickLower: state.tickLower,
        endingTickUpper: state.tickUpper,
        fee0: fee0.toString(),
        fee1: fee1.toString(),
        feeValueQuote: feeValue.toString(),
        fromCheckpointRunId: from.run.checkpointRunId,
        hodlValueQuote: hodlValue.toString(),
        index,
        lpAlphaQuote: (nav - hodlValue).toString(),
        navQuote: nav.toString(),
        oraclePriceX18: to.oraclePriceX18!.toString(),
        pathMaxTick: interval.pathMaxTick,
        pathMinTick: interval.pathMinTick,
        poolPriceX18: to.poolPriceX18.toString(),
        poolSpotNavBeforeActionQuote: poolSpotNavBeforeAction.toString(),
        rebalanced,
        toCheckpointRunId: to.run.checkpointRunId,
      });
      completedIntervals += 1;
      if (failureReason !== null) break;
    }

    if (failureReason !== null) {
      return excludedCandidate({
        completedIntervals,
        failureCheckpointRunId: failureCheckpointRunId!,
        failureReason,
        halfWidthSpacings: halfWidth,
        initialAmount0,
        initialAmount1,
        initialNav,
        markedFeeValue,
        maxDrawdown,
        rebalances,
        steps,
        totalCost,
      });
    }
    const finalStep = steps.at(-1)!;
    const finalNav = BigInt(finalStep.navQuote);
    const hodlEndValue = BigInt(finalStep.hodlValueQuote);
    return {
      absolutePnlQuote: (finalNav - input.budgetQuote).toString(),
      completedIntervals,
      failureCheckpointRunId: null,
      failureReason: null,
      finalAmount0: finalStep.endAmount0,
      finalAmount1: finalStep.endAmount1,
      finalLiquidity: state.liquidity.toString(),
      finalNavQuote: finalNav.toString(),
      finalTickLower: state.tickLower,
      finalTickUpper: state.tickUpper,
      halfWidthSpacings: halfWidth,
      hodlEndValueQuote: hodlEndValue.toString(),
      initialAmount0: initialAmount0.toString(),
      initialAmount1: initialAmount1.toString(),
      initialNavQuote: initialNav.toString(),
      lpAlphaQuote: (finalNav - hodlEndValue).toString(),
      markedFeeValueQuote: markedFeeValue.toString(),
      maxDrawdownPpm: maxDrawdown.toString(),
      rank: null,
      rebalances,
      status: "complete",
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
      "NAV, fees, and passive holding are valued only with valid synchronized oracle marks",
      "pool spot is used only for principal composition and ideal recenter swaps",
      "the observed indexed price path is unchanged by the candidate",
      "zero market impact and no candidate self-dilution",
      "operator-supplied costs are illustrative",
      "the passive benchmark carries the exact post-entry token inventory",
      "fees remain idle in their earned token until a recenter",
      "marked fee value is summed at interval endpoint marks and is not standalone PnL",
      "invalid marks and crossed intervals stop without interpolation",
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
    indexedThroughBlock: input.source.indexedThroughBlock.toString(),
    intervalCount: input.source.intervals.length,
    last: last.run,
    methodology: "oracle_marked_stateful_certified_replay_v1",
    policySetHash: policyHash({
      budgetQuote: input.budgetQuote,
      entryCostQuote: input.entryCostQuote,
      halfWidths,
      rebalanceCostQuote: input.rebalanceCostQuote,
      triggerPercent: input.triggerPercent,
    }),
    poolAddress: input.source.poolAddress,
    quoteDecimals: QUOTE_DECIMALS,
    quoteToken: input.source.quoteToken,
    rebalanceCostQuote: input.rebalanceCostQuote.toString(),
    rwaAddress: input.source.rwaAddress,
    rwaDecimals: input.source.rwaDecimals,
    rwaSymbol: input.source.rwaSymbol,
    schemaVersion: 1,
    streamKey: input.source.streamKey,
    targetSetHash: input.source.targetSetHash,
    tickSpacing,
    token0: input.source.token0,
    token1: input.source.token1,
    triggerPercent: input.triggerPercent,
  };
}
