import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountingRunReference } from "../src/backtest/domain.js";
import { sqrtRatioAtTick } from "../src/backtest/principal.js";
import { USDG } from "../src/constants.js";
import type { CanonicalRangePolicyReplaySource } from "../src/simulator/domain.js";
import { replayRangePolicies } from "../src/simulator/replay.js";

const Q128 = 1n << 128n;
const rwa = "0x1111111111111111111111111111111111111111";
const poolAddress = "0x2222222222222222222222222222222222222222";

function run(id: string, blockNumber: bigint): AccountingRunReference {
  return {
    blockHash: `0x${id.padStart(64, "0")}`,
    blockNumber,
    blockTimestamp: new Date(Number(blockNumber) * 1_000).toISOString(),
    chainId: 4663,
    observedAt: new Date(Number(blockNumber) * 1_000 + 500).toISOString(),
    runId: id,
  };
}

function source(): CanonicalRangePolicyReplaySource {
  return {
    checkpoints: [
      {
        pool: {
          feeGrowthGlobal0X128: 10n * Q128,
          feeGrowthGlobal1X128: 20n * Q128,
          liquidity: 100_000_000n,
          sqrtPriceX96: sqrtRatioAtTick(0),
          tick: 0,
        },
        run: run("1", 100n),
      },
      {
        pool: {
          feeGrowthGlobal0X128: 10n * Q128 + Q128 / 1_000_000n,
          feeGrowthGlobal1X128: 20n * Q128 + Q128 / 2_000_000n,
          liquidity: 101_000_000n,
          sqrtPriceX96: sqrtRatioAtTick(0),
          tick: 0,
        },
        run: run("2", 200n),
      },
      {
        pool: {
          feeGrowthGlobal0X128: 10n * Q128 + Q128 / 500_000n,
          feeGrowthGlobal1X128: 20n * Q128 + Q128 / 1_000_000n,
          liquidity: 102_000_000n,
          sqrtPriceX96: sqrtRatioAtTick(15),
          tick: 15,
        },
        run: run("3", 300n),
      },
    ],
    fee: 500,
    intervals: [
      {
        fromRunId: "1",
        pathMaxTick: 5,
        pathMinTick: -5,
        swapCount: 2n,
        toRunId: "2",
      },
      {
        fromRunId: "2",
        pathMaxTick: 15,
        pathMinTick: 0,
        swapCount: 3n,
        toRunId: "3",
      },
    ],
    poolAddress,
    quoteToken: USDG,
    rwaSymbol: "TEST",
    streamKey: "test",
    token0: USDG,
    token1: rwa,
  };
}

describe("stateful range-policy replay", () => {
  it("carries state, compounds on recenter, and excludes crossed paths", () => {
    const replay = replayRangePolicies({
      budgetQuote: 1_000_000_000n,
      entryCostQuote: 1_000_000n,
      halfWidths: [5, 1, 2],
      rebalanceCostQuote: 1_000_000n,
      source: source(),
      triggerPercent: 50,
    });
    assert.equal(replay.checkpointCount, 3);
    assert.equal(replay.intervalCount, 2);
    assert.equal(replay.completedCandidates, 2);
    assert.equal(replay.excludedCandidates, 1);
    assert.deepEqual(
      replay.candidates.map((candidate) => candidate.halfWidthSpacings),
      [1, 2, 5],
    );

    const [narrow, triggered, passive] = replay.candidates;
    assert.equal(narrow?.status, "excluded");
    assert.equal(narrow?.failureReason, "observed_tick_path_crossed_range");
    assert.equal(narrow?.failureRunId, "3");
    assert.equal(narrow?.completedIntervals, 1);
    assert.equal(narrow?.steps.length, 1);

    assert.equal(triggered?.status, "complete");
    assert.equal(triggered?.completedIntervals, 2);
    assert.equal(triggered?.rebalances, 1);
    assert.equal(triggered?.totalCostQuote, "2000000");
    assert.equal(triggered?.steps[1]?.rebalanced, true);
    assert.equal(triggered?.finalTickLower, -10);
    assert.equal(triggered?.finalTickUpper, 30);
    assert.equal(
      BigInt(triggered!.absolutePnlQuote!),
      BigInt(triggered!.finalNavQuote!) - 1_000_000_000n,
    );
    assert.equal(
      BigInt(triggered!.lpAlphaQuote!),
      BigInt(triggered!.finalNavQuote!) - BigInt(triggered!.hodlEndValueQuote!),
    );

    assert.equal(passive?.status, "complete");
    assert.equal(passive?.rebalances, 0);
    assert.equal(passive?.totalCostQuote, "1000000");
    assert.equal(replay.executionEligible, false);
  });

  it("hashes sorted policies and costs deterministically", () => {
    const common = {
      budgetQuote: 1_000_000_000n,
      entryCostQuote: 1_000_000n,
      rebalanceCostQuote: 2_000_000n,
      source: source(),
      triggerPercent: 75,
    } as const;
    const first = replayRangePolicies({ ...common, halfWidths: [5, 2] });
    const second = replayRangePolicies({ ...common, halfWidths: [2, 5] });
    assert.equal(first.policySetHash, second.policySetHash);
  });

  it("rejects invalid checkpoint structure and policy parameters", () => {
    assert.throws(() => replayRangePolicies({
      budgetQuote: 1_000_000n,
      entryCostQuote: 1_000_000n,
      halfWidths: [2],
      rebalanceCostQuote: 0n,
      source: source(),
      triggerPercent: 50,
    }), /entry cost/);
    assert.throws(() => replayRangePolicies({
      budgetQuote: 1_000_000n,
      entryCostQuote: 0n,
      halfWidths: [2],
      rebalanceCostQuote: 0n,
      source: source(),
      triggerPercent: 101,
    }), /1 to 100/);
    assert.throws(() => replayRangePolicies({
      budgetQuote: 1_000_000n,
      entryCostQuote: 0n,
      halfWidths: [2],
      rebalanceCostQuote: 0n,
      source: { ...source(), intervals: [] },
      triggerPercent: 50,
    }), /one interval/);
  });
});
