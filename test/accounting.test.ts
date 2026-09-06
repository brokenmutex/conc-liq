import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectFeeAccountingSnapshot } from "../src/accounting/collector.js";
import type { AccountingSourceSnapshot } from "../src/accounting/domain.js";
import type { RobinhoodClient } from "../src/client.js";
import {
  calculatePositionFees,
  feeGrowthInside,
  subtractUint256,
} from "../src/accounting/math.js";

const Q128 = 1n << 128n;
const Q256 = 1n << 256n;

describe("fee accounting request controls", () => {
  it("skips disabled scheduled snapshots before opening a database or RPC connection", async () => {
    for (const flag of [undefined, "false"]) {
      const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "invalid", RH_RPC_URL: "invalid" };
      delete environment.ACCOUNTING_FULL_SNAPSHOT_ENABLED;
      if (flag !== undefined) environment.ACCOUNTING_FULL_SNAPSHOT_ENABLED = flag;
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/accounting.ts", "--if-new-source"], { env: environment });
      assert.equal(JSON.parse(stdout.trim()).reason, "full_snapshot_disabled");
    }
  });

  it("rejects an over-budget snapshot before any provider request", async () => {
    let calls = 0;
    const client = new Proxy({}, { get() { return async () => { calls += 1; throw new Error("Unexpected request"); }; } }) as RobinhoodClient;
    const source = { pools: [{}], ticks: [{}], positions: [{}] } as unknown as AccountingSourceSnapshot;
    await assert.rejects(collectFeeAccountingSnapshot({ client, source, concurrency: 4, maxStateReads: 7 }), /needs 8 planned state reads, exceeding limit 7/);
    assert.equal(calls, 0);
  });
});

describe("Uniswap v3 fee accounting", () => {
  it("uses uint256 wraparound subtraction", () => {
    assert.equal(subtractUint256(5n, 7n), Q256 - 2n);
  });

  it("reconstructs inside growth below, within, and above a range", () => {
    assert.equal(feeGrowthInside({
      currentTick: 0,
      feeGrowthGlobalX128: 1_000n,
      lowerFeeGrowthOutsideX128: 100n,
      tickLower: -10,
      tickUpper: 10,
      upperFeeGrowthOutsideX128: 200n,
    }), 700n);
    assert.equal(feeGrowthInside({
      currentTick: -20,
      feeGrowthGlobalX128: 1_000n,
      lowerFeeGrowthOutsideX128: 900n,
      tickLower: -10,
      tickUpper: 10,
      upperFeeGrowthOutsideX128: 850n,
    }), 50n);
    assert.equal(feeGrowthInside({
      currentTick: 20,
      feeGrowthGlobalX128: 1_000n,
      lowerFeeGrowthOutsideX128: 100n,
      tickLower: -10,
      tickUpper: 10,
      upperFeeGrowthOutsideX128: 900n,
    }), 800n);
  });

  it("floors Q128 growth and adds already-realized tokens owed", () => {
    const fees = calculatePositionFees({
      feeGrowthInside0LastX128: 2n * Q128,
      feeGrowthInside0X128: 5n * Q128 + Q128 / 2n,
      feeGrowthInside1LastX128: 7n * Q128,
      feeGrowthInside1X128: 9n * Q128,
      liquidity: 10n,
      tokensOwed0: 7n,
      tokensOwed1: 3n,
    });

    assert.deepEqual(fees, {
      claimable0: 42n,
      claimable1: 23n,
      pending0: 35n,
      pending1: 20n,
    });
  });

  it("matches Solidity wraparound when fee growth crosses uint256", () => {
    const fees = calculatePositionFees({
      feeGrowthInside0LastX128: Q256 - 2n * Q128,
      feeGrowthInside0X128: Q128,
      feeGrowthInside1LastX128: 0n,
      feeGrowthInside1X128: 0n,
      liquidity: 10n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    });

    assert.equal(fees.pending0, 30n);
  });

  it("fails rather than silently reproducing a uint128 fee overflow", () => {
    assert.throws(
      () => calculatePositionFees({
        feeGrowthInside0LastX128: 0n,
        feeGrowthInside0X128: Q128,
        feeGrowthInside1LastX128: 0n,
        feeGrowthInside1X128: 0n,
        liquidity: Q128 - 1n,
        tokensOwed0: 1n,
        tokensOwed1: 0n,
      }),
      /uint128 bounds/,
    );
  });
});
