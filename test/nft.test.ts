import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import type { AccountingRunReference } from "../src/backtest/domain.js";
import { Q96 } from "../src/backtest/principal.js";
import {
  NONFUNGIBLE_POSITION_MANAGER,
  USDG,
} from "../src/constants.js";
import type {
  NftPoolSource,
  NftPositionState,
  NftTickSource,
} from "../src/nft/domain.js";
import { evaluateNftPosition } from "../src/nft/evaluate.js";

const Q128 = 1n << 128n;
const rwa = getAddress("0x1111111111111111111111111111111111111111");
const poolAddress = getAddress("0x2222222222222222222222222222222222222222");
const run: AccountingRunReference = {
  blockHash: `0x${"33".repeat(32)}`,
  blockNumber: 100n,
  blockTimestamp: "2026-09-04T00:00:00.000Z",
  chainId: 4663,
  observedAt: "2026-09-04T00:00:01.000Z",
  runId: "1",
};
const pool: NftPoolSource = {
  fee: 500,
  feeGrowthGlobal0X128: 10n * Q128,
  feeGrowthGlobal1X128: 8n * Q128,
  poolAddress,
  rwaSymbol: "TEST",
  sqrtPriceX96: Q96,
  tick: 0,
  token0: USDG,
  token1: rwa,
};
const ticks: NftTickSource[] = [
  {
    feeGrowthOutside0X128: Q128,
    feeGrowthOutside1X128: Q128,
    poolAddress,
    tick: -100,
  },
  {
    feeGrowthOutside0X128: 2n * Q128,
    feeGrowthOutside1X128: Q128,
    poolAddress,
    tick: 100,
  },
];

function position(overrides: Partial<NftPositionState> = {}): NftPositionState {
  return {
    fee: 500,
    feeGrowthInside0LastX128: 5n * Q128,
    feeGrowthInside1LastX128: 5n * Q128,
    liquidity: 1_000_000n,
    nonce: 0n,
    operator: getAddress("0x0000000000000000000000000000000000000000"),
    ownerAddress: getAddress("0x4444444444444444444444444444444444444444"),
    tickLower: -100,
    tickUpper: 100,
    token0: USDG,
    token1: rwa,
    tokenId: 7n,
    tokensOwed0: 3n,
    tokensOwed1: 4n,
    ...overrides,
  };
}

function evaluate(positionState: NftPositionState) {
  return evaluateNftPosition({
    pools: [pool],
    position: positionState,
    positionManager: NONFUNGIBLE_POSITION_MANAGER,
    run,
    streamKey: "test",
    ticks,
    token0Decimals: 6,
    token1Decimals: 18,
  });
}

describe("per-NFT position accounting", () => {
  it("combines exact NFT checkpoints with pool fee growth and principal", () => {
    const snapshot = evaluate(position());
    assert.equal(snapshot.feeGrowthInside0X128, (7n * Q128).toString());
    assert.equal(snapshot.feeGrowthInside1X128, (6n * Q128).toString());
    assert.equal(snapshot.pending0, "2000000");
    assert.equal(snapshot.pending1, "1000000");
    assert.equal(snapshot.claimable0, "2000003");
    assert.equal(snapshot.claimable1, "1000004");
    assert.equal(snapshot.region, "in_range");
    assert(BigInt(snapshot.principal0) > 0n);
    assert(BigInt(snapshot.principal1) > 0n);
    assert.equal(snapshot.executionEligible, false);
  });

  it("preserves stored fees and zero principal for an empty NFT", () => {
    const snapshot = evaluate(position({ liquidity: 0n }));
    assert.equal(snapshot.region, "empty");
    assert.equal(snapshot.principal0, "0");
    assert.equal(snapshot.principal1, "0");
    assert.equal(snapshot.pending0, "0");
    assert.equal(snapshot.claimable0, "3");
    assert.equal(snapshot.feeGrowthInside0X128, null);
  });

  it("rejects NFTs outside the monitored pool universe", () => {
    assert.throws(
      () => evaluate(position({ fee: 3_000 })),
      /exactly one monitored pool/,
    );
  });

  it("fails closed when an active boundary tick is missing", () => {
    assert.throws(() => evaluateNftPosition({
      pools: [pool],
      position: position(),
      positionManager: NONFUNGIBLE_POSITION_MANAGER,
      run,
      streamKey: "test",
      ticks: ticks.slice(0, 1),
      token0Decimals: 6,
      token1Decimals: 18,
    }), /incomplete boundary/);
  });
});
