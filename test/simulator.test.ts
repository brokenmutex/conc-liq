import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountingRunReference } from "../src/backtest/domain.js";
import { Q96 } from "../src/backtest/principal.js";
import { USDG } from "../src/constants.js";
import type { CanonicalRangeSimulationSource } from "../src/simulator/domain.js";
import { simulateStaticCenteredRanges } from "../src/simulator/evaluate.js";
import {
  centeredRange,
  quoteValue,
  sizeLiquidityForQuoteBudget,
} from "../src/simulator/math.js";

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

function source(): CanonicalRangeSimulationSource {
  return {
    fee: 500,
    from: run("1", 100n),
    fromPool: {
      feeGrowthGlobal0X128: 10n * Q128,
      feeGrowthGlobal1X128: 20n * Q128,
      liquidity: 100_000_000n,
      sqrtPriceX96: Q96,
      tick: 0,
    },
    pathMaxTick: 10,
    pathMinTick: -5,
    poolAddress,
    quoteToken: USDG,
    rwaSymbol: "TEST",
    streamKey: "test",
    swapCount: 7n,
    to: run("2", 200n),
    toPool: {
      feeGrowthGlobal0X128: 10n * Q128 + Q128 / 1_000_000n,
      feeGrowthGlobal1X128: 20n * Q128 + Q128 / 2_000_000n,
      liquidity: 101_000_000n,
      sqrtPriceX96: Q96,
      tick: 0,
    },
    token0: USDG,
    token1: rwa,
  };
}

describe("range-policy simulator", () => {
  it("ranks certified ranges and excludes paths that cross a boundary", () => {
    const simulation = simulateStaticCenteredRanges({
      budgetQuote: 1_000_000_000n,
      costQuote: 1_000_000n,
      halfWidths: [2, 1],
      source: source(),
    });
    assert.equal(simulation.completedCandidates, 1);
    assert.equal(simulation.excludedCandidates, 1);
    assert.deepEqual(
      simulation.candidates.map((candidate) => candidate.halfWidthSpacings),
      [1, 2],
    );
    const [excluded, complete] = simulation.candidates;
    assert.equal(excluded?.status, "excluded");
    assert.equal(excluded?.exclusionReason, "observed_tick_path_crossed_range");
    assert.equal(complete?.status, "complete");
    assert.equal(complete?.rank, 1);
    assert.equal(
      BigInt(complete!.lpAlphaQuote!),
      BigInt(complete!.divergenceQuote!) +
        BigInt(complete!.feeValueQuote!) - 1_000_000n,
    );
    assert.equal(complete?.absolutePnlQuote, complete?.lpAlphaQuote);
    assert.equal(simulation.executionEligible, false);
  });

  it("hashes a policy set independently of supplied width order", () => {
    const first = simulateStaticCenteredRanges({
      budgetQuote: 1_000_000_000n,
      costQuote: 0n,
      halfWidths: [5, 2],
      source: source(),
    });
    const second = simulateStaticCenteredRanges({
      budgetQuote: 1_000_000_000n,
      costQuote: 0n,
      halfWidths: [2, 5],
      source: source(),
    });
    assert.equal(first.policySetHash, second.policySetHash);
  });

  it("values either token ordering in exact raw quote units", () => {
    const sqrtPriceX96 = 2n * Q96;
    assert.equal(quoteValue({
      amount0: 10n,
      amount1: 20n,
      quoteToken: USDG,
      sqrtPriceX96,
      token0: USDG,
      token1: rwa,
    }), 15n);
    assert.equal(quoteValue({
      amount0: 10n,
      amount1: 20n,
      quoteToken: USDG,
      sqrtPriceX96,
      token0: rwa,
      token1: USDG,
    }), 60n);
  });

  it("sizes liquidity without exceeding the common quote budget", () => {
    const range = centeredRange({
      currentTick: 0,
      halfWidthSpacings: 5,
      tickSpacing: 10,
    });
    const sized = sizeLiquidityForQuoteBudget({
      budgetQuote: 1_000_000n,
      quoteToken: USDG,
      sqrtPriceX96: Q96,
      ...range,
      token0: USDG,
      token1: rwa,
    });
    assert(sized.liquidity > 0n);
    assert.equal(
      quoteValue({
        amount0: sized.amount0,
        amount1: sized.amount1,
        quoteToken: USDG,
        sqrtPriceX96: Q96,
        token0: USDG,
        token1: rwa,
      }) + sized.idleQuote,
      1_000_000n,
    );
  });

  it("rejects duplicate widths and costs above capital", () => {
    assert.throws(() => simulateStaticCenteredRanges({
      budgetQuote: 1_000n,
      costQuote: 0n,
      halfWidths: [2, 2],
      source: source(),
    }), /unique positive/);
    assert.throws(() => simulateStaticCenteredRanges({
      budgetQuote: 1_000n,
      costQuote: 1_001n,
      halfWidths: [2],
      source: source(),
    }), /between zero and the budget/);
  });
});
