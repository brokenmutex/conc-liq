import { encodePacked, getAddress, keccak256, type Hash } from "viem";
import type { RobinhoodClient } from "../client.js";
import { log } from "../logger.js";
import { replayPoolStateAbi, replayPositionAbi, replayTickAbi } from "./abi.js";
import type {
  ReplayPoolState,
  ReplayPositionState,
  ReplayTickState,
} from "./domain.js";
import { PostgresReplayStore } from "./store.js";

export interface ReconcileOptions {
  readonly concurrency: number;
}

export interface ReconcileResult {
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly pools: number;
  readonly positions: number;
  readonly ticks: number;
}

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
}

function positionKey(position: ReplayPositionState): Hash {
  return keccak256(encodePacked(
    ["address", "int24", "int24"],
    [getAddress(position.ownerAddress), position.tickLower, position.tickUpper],
  ));
}

async function reconcilePool(
  client: RobinhoodClient,
  pool: ReplayPoolState,
  blockNumber: bigint,
): Promise<void> {
  if (
    !pool.initialized ||
    pool.sqrtPriceX96 === null ||
    pool.tick === null ||
    pool.observationCardinalityNext === null
  ) {
    throw new Error(`Replay pool ${pool.poolAddress} is not initialized`);
  }
  const address = getAddress(pool.poolAddress);
  const [slot0, liquidity] = await Promise.all([
    client.readContract({
      abi: replayPoolStateAbi,
      address,
      args: [],
      blockNumber,
      functionName: "slot0",
    }),
    client.readContract({
      abi: replayPoolStateAbi,
      address,
      args: [],
      blockNumber,
      functionName: "liquidity",
    }),
  ]);
  const expectedFeeProtocol = pool.feeProtocol0 + (pool.feeProtocol1 << 4);
  if (
    slot0[0] !== pool.sqrtPriceX96 ||
    slot0[1] !== pool.tick ||
    slot0[4] !== pool.observationCardinalityNext ||
    slot0[5] !== expectedFeeProtocol ||
    liquidity !== pool.liquidity
  ) {
    throw new Error(
      `Pool-state reconciliation failed for ${pool.poolAddress}: ` +
      `replay price/tick/liquidity/cardinality/feeProtocol=` +
      `${pool.sqrtPriceX96}/${pool.tick}/${pool.liquidity}/` +
      `${pool.observationCardinalityNext}/${expectedFeeProtocol}, chain=` +
      `${slot0[0]}/${slot0[1]}/${liquidity}/${slot0[4]}/${slot0[5]}`,
    );
  }
}

async function reconcileTick(
  client: RobinhoodClient,
  tick: ReplayTickState,
  blockNumber: bigint,
): Promise<void> {
  const result = await client.readContract({
    abi: replayTickAbi,
    address: getAddress(tick.poolAddress),
    args: [tick.tick],
    blockNumber,
    functionName: "ticks",
  });
  if (
    result[0] !== tick.liquidityGross ||
    result[1] !== tick.liquidityNet ||
    result[7] !== true
  ) {
    throw new Error(
      `Tick reconciliation failed for ${tick.poolAddress}:${tick.tick}; ` +
      `replay gross/net=${tick.liquidityGross}/${tick.liquidityNet}, ` +
      `chain=${result[0]}/${result[1]}, initialized=${result[7]}`,
    );
  }
}

async function reconcilePosition(
  client: RobinhoodClient,
  position: ReplayPositionState,
  blockNumber: bigint,
): Promise<void> {
  const result = await client.readContract({
    abi: replayPositionAbi,
    address: getAddress(position.poolAddress),
    args: [positionKey(position)],
    blockNumber,
    functionName: "positions",
  });
  if (result[0] !== position.liquidity) {
    throw new Error(
      `Position reconciliation failed for ${position.poolAddress}:` +
      `${position.ownerAddress}:${position.tickLower}:${position.tickUpper}; ` +
      `replay liquidity=${position.liquidity}, chain=${result[0]}`,
    );
  }
}

export async function reconcileReplay(
  client: RobinhoodClient,
  store: PostgresReplayStore,
  streamKey: string,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const source = await store.getSource(streamKey);
  const cursor = await store.getCursor(streamKey);
  if (
    cursor === null ||
    cursor.completeThroughBlock === null ||
    cursor.completeThroughHash === null
  ) {
    throw new Error("Replay is not complete; run npm run replay first");
  }
  if (
    cursor.completeThroughBlock !== source.lastScannedBlock ||
    cursor.completeThroughHash.toLowerCase() !== source.lastScannedHash.toLowerCase()
  ) {
    throw new Error("Replay is behind the indexed source; run npm run replay first");
  }

  const blockNumber = cursor.completeThroughBlock;
  const blockHash = cursor.completeThroughHash;
  const block = await client.getBlock({ blockNumber });
  if (block.hash.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error("Replay completion block is no longer canonical; rebuild source and replay");
  }

  const state = await store.loadState(streamKey);
  await forEachConcurrent(
    state.pools,
    options.concurrency,
    (pool) => reconcilePool(client, pool, blockNumber),
  );
  log("info", "reconcile_pools_complete", { pools: state.pools.length });

  let ticksDone = 0;
  await forEachConcurrent(state.ticks, options.concurrency, async (tick) => {
    await reconcileTick(client, tick, blockNumber);
    ticksDone += 1;
    if (ticksDone % 500 === 0) {
      log("info", "reconcile_ticks_progress", { complete: ticksDone, total: state.ticks.length });
    }
  });
  log("info", "reconcile_ticks_complete", { ticks: state.ticks.length });

  let positionsDone = 0;
  await forEachConcurrent(state.positions, options.concurrency, async (position) => {
    await reconcilePosition(client, position, blockNumber);
    positionsDone += 1;
    if (positionsDone % 1_000 === 0) {
      log("info", "reconcile_positions_progress", {
        complete: positionsDone,
        total: state.positions.length,
      });
    }
  });
  log("info", "reconcile_positions_complete", { positions: state.positions.length });

  return {
    blockHash,
    blockNumber,
    pools: state.pools.length,
    positions: state.positions.length,
    ticks: state.ticks.length,
  };
}
