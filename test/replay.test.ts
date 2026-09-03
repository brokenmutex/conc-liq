import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hash } from "viem";
import type { ReplayPoolState, StoredReplayEvent } from "../src/replay/domain.js";
import { V3ReplayState } from "../src/replay/state.js";

const poolAddress = "0x1111111111111111111111111111111111111111";
const ownerAddress = "0x2222222222222222222222222222222222222222";
const hash = `0x${"11".repeat(32)}` as Hash;

function pool(): ReplayPoolState {
  return {
    burnCount: 0n,
    chainId: 4663,
    collectCount: 0n,
    eventCount: 0n,
    fee: 500,
    feeProtocol0: 0,
    feeProtocol1: 0,
    flashCount: 0n,
    initialized: false,
    lastEventBlock: null,
    lastEventLogIndex: null,
    lastEventTransactionIndex: null,
    liquidity: 0n,
    mintCount: 0n,
    observationCardinalityNext: null,
    poolAddress,
    rwaSymbol: "TEST",
    sqrtPriceX96: null,
    swapCount: 0n,
    tick: null,
  };
}

let logIndex = 0;
function event(eventName: string, args: unknown): StoredReplayEvent {
  const index = logIndex++;
  return {
    args,
    blockHash: hash,
    blockNumber: 100n,
    eventName,
    logIndex: index,
    poolAddress,
    transactionHash: hash,
    transactionIndex: 0,
  };
}

describe("v3 replay reducer", () => {
  it("reconstructs positions, ticks, and active liquidity across crossings", () => {
    const state = new V3ReplayState({ pools: [pool()] });
    state.apply(event("Initialize", { sqrtPriceX96: "79228162514264337593543950336", tick: 0 }));
    state.apply(event("Mint", {
      amount: "100",
      amount0: "10",
      amount1: "20",
      owner: ownerAddress,
      tickLower: -10,
      tickUpper: 10,
    }));
    state.apply(event("Mint", {
      amount: "50",
      amount0: "5",
      amount1: "6",
      owner: ownerAddress,
      tickLower: 10,
      tickUpper: 20,
    }));

    assert.equal(state.poolStates()[0]!.liquidity, 100n);
    state.apply(event("Swap", {
      liquidity: "50",
      sqrtPriceX96: "79240000000000000000000000000",
      tick: 10,
    }));
    state.apply(event("Swap", {
      liquidity: "100",
      sqrtPriceX96: "79230000000000000000000000000",
      tick: 9,
    }));
    state.apply(event("Burn", {
      amount: "40",
      amount0: "3",
      amount1: "4",
      owner: ownerAddress,
      tickLower: -10,
      tickUpper: 10,
    }));
    state.apply(event("Collect", {
      amount0: "7",
      amount1: "8",
      owner: ownerAddress,
      tickLower: -10,
      tickUpper: 10,
    }));

    assert.equal(state.poolStates()[0]!.liquidity, 60n);
    const ticks = new Map(state.tickStates().map((tick) => [tick.tick, tick]));
    assert.deepEqual(
      [...ticks].map(([tick, value]) => [tick, value.liquidityGross, value.liquidityNet]),
      [[-10, 60n, 60n], [10, 110n, -10n], [20, 50n, -50n]],
    );
    const positions = state.positionStates();
    assert.equal(positions[0]!.liquidity, 60n);
    assert.equal(positions[0]!.collectedAmount0, 7n);
    assert.equal(positions[1]!.liquidity, 50n);
  });

  it("fails on event liquidity that disagrees with crossed tick deltas", () => {
    const state = new V3ReplayState({ pools: [pool()] });
    state.apply(event("Initialize", { sqrtPriceX96: "1", tick: 0 }));
    state.apply(event("Mint", {
      amount: "100",
      amount0: "0",
      amount1: "0",
      owner: ownerAddress,
      tickLower: -10,
      tickUpper: 10,
    }));
    assert.throws(
      () => state.apply(event("Swap", {
        liquidity: "99",
        sqrtPriceX96: "2",
        tick: 1,
      })),
      /liquidity mismatch/,
    );
  });

  it("validates protocol and observation old values", () => {
    const state = new V3ReplayState({ pools: [pool()] });
    state.apply(event("Initialize", { sqrtPriceX96: "1", tick: 0 }));
    state.apply(event("SetFeeProtocol", {
      feeProtocol0New: 4,
      feeProtocol0Old: 0,
      feeProtocol1New: 5,
      feeProtocol1Old: 0,
    }));
    state.apply(event("IncreaseObservationCardinalityNext", {
      observationCardinalityNextNew: 16,
      observationCardinalityNextOld: 1,
    }));
    assert.equal(state.poolStates()[0]!.feeProtocol0, 4);
    assert.equal(state.poolStates()[0]!.feeProtocol1, 5);
    assert.equal(state.poolStates()[0]!.observationCardinalityNext, 16);
    assert.throws(
      () => state.apply(event("SetFeeProtocol", {
        feeProtocol0New: 6,
        feeProtocol0Old: 0,
        feeProtocol1New: 6,
        feeProtocol1Old: 0,
      })),
      /mismatch/,
    );
  });

  it("accepts a zero-value Collect against an absent core position as a no-op", () => {
    const state = new V3ReplayState({ pools: [pool()] });
    state.apply(event("Initialize", { sqrtPriceX96: "1", tick: 0 }));
    state.apply(event("Collect", {
      amount0: "0",
      amount1: "0",
      owner: ownerAddress,
      tickLower: 0,
      tickUpper: 0,
    }));
    assert.equal(state.positionStates().length, 0);
    assert.equal(state.poolStates()[0]!.collectCount, 1n);
  });
});
