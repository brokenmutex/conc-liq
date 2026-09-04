import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStableFeeBaseline } from "../src/backtest/baseline.js";
import type {
  AccountingRunReference,
  PositionIntervalInput,
} from "../src/backtest/domain.js";

const from: AccountingRunReference = {
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: 100n,
  blockTimestamp: "2026-09-04T00:00:00.000Z",
  chainId: 4663,
  observedAt: "2026-09-04T00:00:01.000Z",
  runId: "1",
};
const to: AccountingRunReference = {
  blockHash: `0x${"22".repeat(32)}`,
  blockNumber: 160n,
  blockTimestamp: "2026-09-04T00:01:00.000Z",
  chainId: 4663,
  observedAt: "2026-09-04T00:01:01.000Z",
  runId: "2",
};

function position(
  overrides: Partial<PositionIntervalInput> = {},
): PositionIntervalInput {
  return {
    feeGrowthInside0LastFromX128: 10n,
    feeGrowthInside0LastToX128: 10n,
    feeGrowthInside1LastFromX128: 20n,
    feeGrowthInside1LastToX128: 20n,
    liquidityFrom: 1_000n,
    liquidityTo: 1_000n,
    ownerAddress: "0x2222222222222222222222222222222222222222",
    pending0From: 5n,
    pending0To: 12n,
    pending1From: 8n,
    pending1To: 19n,
    poolAddress: "0x1111111111111111111111111111111111111111",
    tickLower: -10,
    tickUpper: 10,
    touched: false,
    ...overrides,
  };
}

function build(positions: readonly PositionIntervalInput[]) {
  return buildStableFeeBaseline({
    from,
    pools: [{
      activePositionsFrom: 3,
      activePositionsTo: 4,
      fee: 500,
      poolAddress: "0x1111111111111111111111111111111111111111",
      rwaSymbol: "TEST",
      token0: "0x3333333333333333333333333333333333333333",
      token1: "0x4444444444444444444444444444444444444444",
    }],
    positions,
    streamKey: "test",
    to,
  });
}

describe("stable-position fee baseline", () => {
  it("sums exact pending deltas and reports endpoint coverage", () => {
    const result = build([
      position(),
      position({
        ownerAddress: "0x5555555555555555555555555555555555555555",
        pending0From: 2n,
        pending0To: 5n,
        pending1From: 1n,
        pending1To: 3n,
      }),
      position({
        ownerAddress: "0x6666666666666666666666666666666666666666",
        touched: true,
      }),
    ]);

    assert.equal(result.blockDelta, "60");
    assert.equal(result.elapsedSeconds, 60);
    assert.deepEqual(result.totals, {
      enteredPositions: 1,
      exitedPositions: 0,
      pairedActivePositions: 3,
      stablePositions: 2,
      touchedPositions: 1,
    });
    assert.equal(result.pools[0]!.accrued0, "10");
    assert.equal(result.pools[0]!.accrued1, "13");
    assert.equal(result.executionEligible, false);
  });

  it("fails if an untouched position changed liquidity", () => {
    assert.throws(
      () => build([position({ liquidityTo: 999n })]),
      /liquidity changed/,
    );
  });

  it("fails if an untouched position checkpoint changed", () => {
    assert.throws(
      () => build([position({ feeGrowthInside0LastToX128: 11n })]),
      /checkpoint changed/,
    );
  });

  it("fails if untouched pending fees decrease", () => {
    assert.throws(
      () => build([position({ pending0To: 4n })]),
      /pending fees decreased/,
    );
  });
});
