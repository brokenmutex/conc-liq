import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountingRunReference } from "../src/backtest/domain.js";
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  amountsForLiquidity,
  principalAmounts,
  Q96,
  reconstructPrincipalSnapshot,
  sqrtRatioAtTick,
} from "../src/backtest/principal.js";

const run: AccountingRunReference = {
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: 100n,
  blockTimestamp: "2026-09-04T00:00:00.000Z",
  chainId: 4663,
  observedAt: "2026-09-04T00:00:01.000Z",
  runId: "1",
};

describe("canonical principal math", () => {
  it("matches canonical TickMath boundary and adjacent-tick vectors", () => {
    assert.equal(sqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO);
    assert.equal(sqrtRatioAtTick(-1), 79_224_201_403_219_477_170_569_942_574n);
    assert.equal(sqrtRatioAtTick(0), Q96);
    assert.equal(sqrtRatioAtTick(1), 79_232_123_823_359_799_118_286_999_568n);
    assert.equal(sqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO);
  });

  it("floors below-range, in-range, and above-range amounts exactly", () => {
    const below = principalAmounts({
      liquidity: 100n,
      sqrtPriceX96: Q96,
      tickLower: 0,
      tickUpper: 13_863,
    });
    assert.equal(below.region, "below_range");
    assert.equal(below.amount1, 0n);

    const inRange = principalAmounts({
      liquidity: 1_000_000n,
      sqrtPriceX96: sqrtRatioAtTick(0),
      tickLower: -100,
      tickUpper: 100,
    });
    assert.equal(inRange.region, "in_range");
    assert(inRange.amount0 > 0n);
    assert(inRange.amount1 > 0n);

    const above = principalAmounts({
      liquidity: 100n,
      sqrtPriceX96: 2n * Q96,
      tickLower: -13_864,
      tickUpper: 0,
    });
    assert.equal(above.region, "above_range");
    assert.equal(above.amount0, 0n);
  });

  it("uses the same two-step floor as LiquidityAmounts amount0", () => {
    const result = amountsForLiquidity({
      liquidity: 100n,
      sqrtPriceX96: (3n * Q96) / 2n,
      sqrtRatioAX96: Q96,
      sqrtRatioBX96: 2n * Q96,
    });
    assert.equal(result.region, "in_range");
    assert.equal(result.amount0, 16n);
    assert.equal(result.amount1, 50n);
  });

  it("rejects invalid ticks, prices, and uint128 liquidity", () => {
    assert.throws(() => sqrtRatioAtTick(MAX_TICK + 1), /outside/);
    assert.throws(() => principalAmounts({
      liquidity: 1n << 128n,
      sqrtPriceX96: Q96,
      tickLower: -1,
      tickUpper: 1,
    }), /uint128/);
    assert.throws(() => principalAmounts({
      liquidity: 1n,
      sqrtPriceX96: MAX_SQRT_RATIO,
      tickLower: -1,
      tickUpper: 1,
    }), /sqrt ratio/);
  });
});

describe("principal snapshot reconstruction", () => {
  it("aggregates exact position amounts and range coverage", () => {
    const snapshot = reconstructPrincipalSnapshot({
      pools: [{
        activePositions: 3,
        fee: 500,
        poolAddress: "0x1111111111111111111111111111111111111111",
        positions: [
          {
            liquidity: 100n,
            ownerAddress: "0x2222222222222222222222222222222222222222",
            tickLower: 0,
            tickUpper: 100,
          },
          {
            liquidity: 100n,
            ownerAddress: "0x3333333333333333333333333333333333333333",
            tickLower: -100,
            tickUpper: 100,
          },
          {
            liquidity: 100n,
            ownerAddress: "0x4444444444444444444444444444444444444444",
            tickLower: -100,
            tickUpper: 0,
          },
        ],
        rwaSymbol: "TEST",
        sqrtPriceX96: Q96,
        tick: 0,
        token0: "0x5555555555555555555555555555555555555555",
        token1: "0x6666666666666666666666666666666666666666",
      }],
      run,
      streamKey: "test",
    });
    assert.deepEqual(snapshot.totals, {
      aboveRangePositions: 1,
      belowRangePositions: 1,
      inRangePositions: 1,
      positionCount: 3,
    });
    assert.equal(snapshot.positions.length, 3);
    assert.equal(snapshot.executionEligible, false);
    assert.equal(
      snapshot.pools[0]!.amount0,
      snapshot.positions.reduce(
        (sum, position) => sum + BigInt(position.amount0),
        0n,
      ).toString(),
    );
  });

  it("fails when the accounting active-position count disagrees", () => {
    assert.throws(() => reconstructPrincipalSnapshot({
      pools: [{
        activePositions: 1,
        fee: 500,
        poolAddress: "0x1111111111111111111111111111111111111111",
        positions: [],
        rwaSymbol: "TEST",
        sqrtPriceX96: Q96,
        tick: 0,
        token0: "0x5555555555555555555555555555555555555555",
        token1: "0x6666666666666666666666666666666666666666",
      }],
      run,
      streamKey: "test",
    }), /count disagrees/);
  });
});
