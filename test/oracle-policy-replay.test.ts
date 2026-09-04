import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sqrtRatioAtTick } from "../src/backtest/principal.js";
import { USDG } from "../src/constants.js";
import { poolQuotePerRwaX18 } from "../src/oracle/math.js";
import type {
  OraclePolicyCheckpoint,
  OraclePolicyReplaySource,
} from "../src/oracle-policy/domain.js";
import { oracleMarkedQuoteValue } from "../src/oracle-policy/math.js";
import { replayOracleMarkedPolicies } from "../src/oracle-policy/replay.js";

const Q128 = 1n << 128n;
const X18 = 1_000_000_000_000_000_000n;
const rwa = "0x1111111111111111111111111111111111111111";
const poolAddress = "0x2222222222222222222222222222222222222222";

function checkpoint(input: {
  readonly blockNumber: bigint;
  readonly feeGrowth0: bigint;
  readonly feeGrowth1: bigint;
  readonly id: string;
  readonly oraclePriceX18: bigint;
  readonly tick: number;
}): OraclePolicyCheckpoint {
  const timestamp = new Date(Number(input.blockNumber) * 1_000).toISOString();
  const sqrtPriceX96 = sqrtRatioAtTick(input.tick);
  return {
    oraclePriceX18: input.oraclePriceX18,
    pool: {
      feeGrowthGlobal0X128: input.feeGrowth0,
      feeGrowthGlobal1X128: input.feeGrowth1,
      liquidity: 100_000_000n,
      sqrtPriceX96,
      tick: input.tick,
    },
    poolPriceX18: poolQuotePerRwaX18({
      quoteDecimals: 6,
      quoteToken: USDG,
      rwaDecimals: 6,
      sqrtPriceX96,
      token0: USDG,
      token1: rwa,
    }),
    reasons: [],
    run: {
      blockHash: `0x${input.id.padStart(64, "0")}`,
      blockNumber: input.blockNumber,
      blockTimestamp: timestamp,
      capturedAt: new Date(Number(input.blockNumber) * 1_000 + 500).toISOString(),
      chainId: 4663,
      checkpointRunId: input.id,
      riskRunId: String(Number(input.id) + 100),
    },
    status: "valid",
    tokenDecimals: 6,
  };
}

function source(): OraclePolicyReplaySource {
  return {
    checkpoints: [
      checkpoint({
        blockNumber: 100n,
        feeGrowth0: 10n * Q128,
        feeGrowth1: 20n * Q128,
        id: "1",
        oraclePriceX18: X18,
        tick: 0,
      }),
      checkpoint({
        blockNumber: 200n,
        feeGrowth0: 10n * Q128 + Q128 / 1_000_000n,
        feeGrowth1: 20n * Q128 + Q128 / 2_000_000n,
        id: "2",
        oraclePriceX18: 2n * X18,
        tick: 0,
      }),
      checkpoint({
        blockNumber: 300n,
        feeGrowth0: 10n * Q128 + Q128 / 500_000n,
        feeGrowth1: 20n * Q128 + Q128 / 1_000_000n,
        id: "3",
        oraclePriceX18: 3n * X18,
        tick: 15,
      }),
    ],
    fee: 500,
    indexedThroughBlock: 350n,
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
    rwaAddress: rwa,
    rwaDecimals: 6,
    rwaSymbol: "TEST",
    streamKey: "test",
    targetSetHash: `0x${"aa".repeat(32)}`,
    token0: USDG,
    token1: rwa,
  };
}

describe("oracle-marked policy replay", () => {
  it("values either token ordering in exact raw quote units", () => {
    assert.equal(oracleMarkedQuoteValue({
      amount0: 5_000_000n,
      amount1: 2_000_000n,
      oraclePriceX18: 3n * X18,
      quoteDecimals: 6,
      quoteToken: USDG,
      rwaDecimals: 6,
      token0: USDG,
      token1: rwa,
    }), 11_000_000n);
    assert.equal(oracleMarkedQuoteValue({
      amount0: 2_000_000n,
      amount1: 5_000_000n,
      oraclePriceX18: 3n * X18,
      quoteDecimals: 6,
      quoteToken: USDG,
      rwaDecimals: 6,
      token0: rwa,
      token1: USDG,
    }), 11_000_000n);
  });

  it("carries exact inventory, marks with oracle prices, and recomposes at pool spot", () => {
    const replay = replayOracleMarkedPolicies({
      budgetQuote: 1_000_000_000n,
      entryCostQuote: 1_000_000n,
      halfWidths: [5, 2],
      rebalanceCostQuote: 1_000_000n,
      source: source(),
      triggerPercent: 50,
    });
    assert.equal(replay.completedCandidates, 2);
    assert.equal(replay.executionEligible, false);
    const triggered = replay.candidates[0]!;
    assert.equal(triggered.halfWidthSpacings, 2);
    assert.equal(triggered.status, "complete");
    assert.equal(triggered.rebalances, 1);
    assert.equal(triggered.steps[1]?.rebalanced, true);
    assert.equal(triggered.finalTickLower, -10);
    assert.equal(triggered.finalTickUpper, 30);
    assert.equal(triggered.finalAmount0, triggered.steps[1]?.endAmount0);
    assert.equal(triggered.finalAmount1, triggered.steps[1]?.endAmount1);

    const firstStep = triggered.steps[0]!;
    assert.equal(firstStep.feeValueQuote, oracleMarkedQuoteValue({
      amount0: BigInt(firstStep.fee0),
      amount1: BigInt(firstStep.fee1),
      oraclePriceX18: 2n * X18,
      quoteDecimals: 6,
      quoteToken: USDG,
      rwaDecimals: 6,
      token0: USDG,
      token1: rwa,
    }).toString());
    const finalStep = triggered.steps[1]!;
    const expectedNav = oracleMarkedQuoteValue({
      amount0: BigInt(finalStep.endAmount0),
      amount1: BigInt(finalStep.endAmount1),
      oraclePriceX18: 3n * X18,
      quoteDecimals: 6,
      quoteToken: USDG,
      rwaDecimals: 6,
      token0: USDG,
      token1: rwa,
    });
    assert.equal(finalStep.navQuote, expectedNav.toString());
    assert.notEqual(finalStep.navQuote, finalStep.poolSpotNavBeforeActionQuote);
    assert.equal(
      BigInt(triggered.lpAlphaQuote!),
      BigInt(triggered.finalNavQuote!) - BigInt(triggered.hodlEndValueQuote!),
    );
    assert.equal(
      BigInt(triggered.absolutePnlQuote!),
      BigInt(triggered.finalNavQuote!) - 1_000_000_000n,
    );
  });

  it("fails closed before consuming an excluded oracle mark", () => {
    const base = source();
    const invalid = {
      ...base.checkpoints[1]!,
      reasons: ["rwa_oracle_price_stale"],
      status: "excluded" as const,
    };
    const replay = replayOracleMarkedPolicies({
      budgetQuote: 1_000_000_000n,
      entryCostQuote: 1_000_000n,
      halfWidths: [2],
      rebalanceCostQuote: 1_000_000n,
      source: { ...base, checkpoints: [base.checkpoints[0]!, invalid, base.checkpoints[2]!] },
      triggerPercent: 50,
    });
    const candidate = replay.candidates[0]!;
    assert.equal(candidate.status, "excluded");
    assert.equal(candidate.failureCheckpointRunId, "2");
    assert.equal(candidate.failureReason, "invalid_oracle_mark:rwa_oracle_price_stale");
    assert.equal(candidate.completedIntervals, 0);
    assert.equal(candidate.steps.length, 0);
    assert.equal(candidate.markedFeeValueQuote, "0");
  });

  it("fails closed when the indexed tick path crosses the active range", () => {
    const replay = replayOracleMarkedPolicies({
      budgetQuote: 1_000_000_000n,
      entryCostQuote: 0n,
      halfWidths: [1],
      rebalanceCostQuote: 0n,
      source: source(),
      triggerPercent: 100,
    });
    const candidate = replay.candidates[0]!;
    assert.equal(candidate.status, "excluded");
    assert.equal(candidate.failureReason, "observed_tick_path_crossed_range");
    assert.equal(candidate.failureCheckpointRunId, "3");
    assert.equal(candidate.completedIntervals, 1);
    assert.equal(candidate.steps.length, 1);
  });

  it("rejects incomplete indexer coverage", () => {
    const base = source();
    assert.throws(() => replayOracleMarkedPolicies({
      budgetQuote: 1_000_000n,
      entryCostQuote: 0n,
      halfWidths: [2],
      rebalanceCostQuote: 0n,
      source: { ...base, indexedThroughBlock: 299n },
      triggerPercent: 50,
    }), /coverage/);
  });
});
