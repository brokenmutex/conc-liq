import { encodePacked, getAddress, keccak256, type Hash } from "viem";
import type { RobinhoodClient } from "../client.js";
import { log } from "../logger.js";
import {
  replayPoolStateAbi,
  replayPositionAbi,
  replayTickAbi,
} from "../replay/abi.js";
import type {
  AccountingSourcePosition,
  AccountingSourceSnapshot,
  FeeAccountingSnapshot,
  PoolFeeState,
  PositionFeeState,
  TickFeeState,
} from "./domain.js";
import { calculatePositionFees, feeGrowthInside } from "./math.js";

interface PoolFeeBase {
  readonly feeGrowthGlobal0X128: bigint;
  readonly feeGrowthGlobal1X128: bigint;
  readonly token0: ReturnType<typeof getAddress>;
  readonly token1: ReturnType<typeof getAddress>;
}

interface PoolTotals {
  activePositions: number;
  claimable0: bigint;
  claimable1: bigint;
  pending0: bigint;
  pending1: bigint;
  positions: number;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

function poolKey(address: string): string {
  return address.toLowerCase();
}

function tickKey(address: string, tick: number): string {
  return `${poolKey(address)}:${tick}`;
}

function positionKey(position: AccountingSourcePosition): Hash {
  return keccak256(encodePacked(
    ["address", "int24", "int24"],
    [position.ownerAddress, position.tickLower, position.tickUpper],
  ));
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
  onProgress?: (complete: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let complete = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
      complete += 1;
      onProgress?.(complete, values.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

async function requireCanonicalBlock(
  client: RobinhoodClient,
  source: AccountingSourceSnapshot,
): Promise<void> {
  const block = await client.getBlock({ blockNumber: source.blockNumber });
  if (
    block.number !== source.blockNumber ||
    block.hash.toLowerCase() !== source.blockHash.toLowerCase()
  ) {
    throw new Error(
      `Accounting source block ${source.blockNumber}:${source.blockHash} is not canonical`,
    );
  }
}

async function readPool(
  client: RobinhoodClient,
  source: AccountingSourceSnapshot["pools"][number],
  blockNumber: bigint,
  beforeRpc?: () => Promise<void>,
): Promise<PoolFeeBase> {
  await beforeRpc?.();
  const slot0 = await client.readContract({
    abi: replayPoolStateAbi,
    address: source.poolAddress,
    blockNumber,
    functionName: "slot0",
  });
  await beforeRpc?.();
  const liquidity = await client.readContract({
    abi: replayPoolStateAbi,
    address: source.poolAddress,
    blockNumber,
    functionName: "liquidity",
  });
  await beforeRpc?.();
  const feeGrowth0 = await client.readContract({
    abi: replayPoolStateAbi,
    address: source.poolAddress,
    blockNumber,
    functionName: "feeGrowthGlobal0X128",
  });
  await beforeRpc?.();
  const feeGrowth1 = await client.readContract({
    abi: replayPoolStateAbi,
    address: source.poolAddress,
    blockNumber,
    functionName: "feeGrowthGlobal1X128",
  });
  await beforeRpc?.();
  const token0 = await client.readContract({
    abi: replayPoolStateAbi,
    address: source.poolAddress,
    blockNumber,
    functionName: "token0",
  });
  await beforeRpc?.();
  const token1 = await client.readContract({
    abi: replayPoolStateAbi,
    address: source.poolAddress,
    blockNumber,
    functionName: "token1",
  });
  if (
    slot0[0] !== source.sqrtPriceX96 ||
    slot0[1] !== source.tick ||
    liquidity !== source.liquidity
  ) {
    throw new Error(
      `Accounting pool reconciliation failed for ${source.poolAddress}`,
    );
  }
  return {
    feeGrowthGlobal0X128: feeGrowth0,
    feeGrowthGlobal1X128: feeGrowth1,
    token0: getAddress(token0),
    token1: getAddress(token1),
  };
}

async function readTick(
  client: RobinhoodClient,
  source: AccountingSourceSnapshot["ticks"][number],
  blockNumber: bigint,
): Promise<TickFeeState> {
  const result = await client.readContract({
    abi: replayTickAbi,
    address: source.poolAddress,
    args: [source.tick],
    blockNumber,
    functionName: "ticks",
  });
  if (
    result[0] !== source.liquidityGross ||
    result[1] !== source.liquidityNet ||
    result[7] !== true
  ) {
    throw new Error(
      `Accounting tick reconciliation failed for ${source.poolAddress}:${source.tick}`,
    );
  }
  return {
    ...source,
    feeGrowthOutside0X128: result[2],
    feeGrowthOutside1X128: result[3],
  };
}

async function readPosition(
  client: RobinhoodClient,
  source: AccountingSourcePosition,
  blockNumber: bigint,
  pools: ReadonlyMap<string, PoolFeeBase>,
  sourcePools: ReadonlyMap<string, AccountingSourceSnapshot["pools"][number]>,
  ticks: ReadonlyMap<string, TickFeeState>,
): Promise<PositionFeeState> {
  const result = await client.readContract({
    abi: replayPositionAbi,
    address: source.poolAddress,
    args: [positionKey(source)],
    blockNumber,
    functionName: "positions",
  });
  if (result[0] !== source.liquidity) {
    throw new Error(
      `Accounting position reconciliation failed for ${source.poolAddress}:` +
      `${source.ownerAddress}:${source.tickLower}:${source.tickUpper}`,
    );
  }

  let feeGrowthInside0X128: bigint | null = null;
  let feeGrowthInside1X128: bigint | null = null;
  let pending0 = 0n;
  let pending1 = 0n;
  let claimable0 = result[3];
  let claimable1 = result[4];
  if (source.liquidity > 0n) {
    const pool = pools.get(poolKey(source.poolAddress));
    const sourcePool = sourcePools.get(poolKey(source.poolAddress));
    const lower = ticks.get(tickKey(source.poolAddress, source.tickLower));
    const upper = ticks.get(tickKey(source.poolAddress, source.tickUpper));
    if (
      pool === undefined ||
      sourcePool === undefined ||
      lower === undefined ||
      upper === undefined
    ) {
      throw new Error(
        `Active position has incomplete fee state ${source.poolAddress}:` +
        `${source.ownerAddress}:${source.tickLower}:${source.tickUpper}`,
      );
    }
    feeGrowthInside0X128 = feeGrowthInside({
      currentTick: sourcePool.tick,
      feeGrowthGlobalX128: pool.feeGrowthGlobal0X128,
      lowerFeeGrowthOutsideX128: lower.feeGrowthOutside0X128,
      tickLower: source.tickLower,
      tickUpper: source.tickUpper,
      upperFeeGrowthOutsideX128: upper.feeGrowthOutside0X128,
    });
    feeGrowthInside1X128 = feeGrowthInside({
      currentTick: sourcePool.tick,
      feeGrowthGlobalX128: pool.feeGrowthGlobal1X128,
      lowerFeeGrowthOutsideX128: lower.feeGrowthOutside1X128,
      tickLower: source.tickLower,
      tickUpper: source.tickUpper,
      upperFeeGrowthOutsideX128: upper.feeGrowthOutside1X128,
    });
    const fees = calculatePositionFees({
      feeGrowthInside0LastX128: result[1],
      feeGrowthInside0X128,
      feeGrowthInside1LastX128: result[2],
      feeGrowthInside1X128,
      liquidity: source.liquidity,
      tokensOwed0: result[3],
      tokensOwed1: result[4],
    });
    pending0 = fees.pending0;
    pending1 = fees.pending1;
    claimable0 = fees.claimable0;
    claimable1 = fees.claimable1;
  }
  return {
    ...source,
    claimable0,
    claimable1,
    feeGrowthInside0LastX128: result[1],
    feeGrowthInside0X128,
    feeGrowthInside1LastX128: result[2],
    feeGrowthInside1X128,
    pending0,
    pending1,
    tokensOwed0: result[3],
    tokensOwed1: result[4],
  };
}

export async function collectFeeAccountingSnapshot(input: {
  readonly beforeRpc?: () => Promise<void>;
  readonly client: RobinhoodClient;
  readonly concurrency: number;
  readonly source: AccountingSourceSnapshot;
}): Promise<FeeAccountingSnapshot> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency <= 0) {
    throw new Error("Fee accounting concurrency must be a positive safe integer");
  }
  await input.beforeRpc?.();
  const chainId = await input.client.getChainId();
  if (chainId !== input.source.chainId) {
    throw new Error(
      `Accounting RPC chain ID ${chainId} does not match source ` +
      `${input.source.chainId}`,
    );
  }
  await input.beforeRpc?.();
  await requireCanonicalBlock(input.client, input.source);
  const poolBase = await mapConcurrent(
    input.source.pools,
    input.concurrency,
    (pool) => readPool(
      input.client,
      pool,
      input.source.blockNumber,
      input.beforeRpc,
    ),
  );
  const pools = new Map(
    input.source.pools.map((pool, index) => [
      poolKey(pool.poolAddress),
      poolBase[index]!,
    ]),
  );
  const sourcePools = new Map(
    input.source.pools.map((pool) => [poolKey(pool.poolAddress), pool]),
  );
  const tickStates = await mapConcurrent(
    input.source.ticks,
    input.concurrency,
    async (tick) => {
      await input.beforeRpc?.();
      return readTick(input.client, tick, input.source.blockNumber);
    },
    (complete, total) => {
      if (complete % 500 === 0 || complete === total) {
        log("info", "fee_accounting_ticks_progress", { complete, total });
      }
    },
  );
  const ticks = new Map(
    tickStates.map((tick) => [tickKey(tick.poolAddress, tick.tick), tick]),
  );
  const positionStates = await mapConcurrent(
    input.source.positions,
    input.concurrency,
    async (position) => {
      await input.beforeRpc?.();
      return readPosition(
        input.client,
        position,
        input.source.blockNumber,
        pools,
        sourcePools,
        ticks,
      );
    },
    (complete, total) => {
      if (complete % 1_000 === 0 || complete === total) {
        log("info", "fee_accounting_positions_progress", { complete, total });
      }
    },
  );

  const totals = new Map<string, PoolTotals>();
  for (const position of positionStates) {
    const key = poolKey(position.poolAddress);
    const total = totals.get(key) ?? {
      activePositions: 0,
      claimable0: 0n,
      claimable1: 0n,
      pending0: 0n,
      pending1: 0n,
      positions: 0,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    };
    total.positions += 1;
    if (position.liquidity > 0n) total.activePositions += 1;
    total.claimable0 += position.claimable0;
    total.claimable1 += position.claimable1;
    total.pending0 += position.pending0;
    total.pending1 += position.pending1;
    total.tokensOwed0 += position.tokensOwed0;
    total.tokensOwed1 += position.tokensOwed1;
    totals.set(key, total);
  }
  const poolStates: PoolFeeState[] = input.source.pools.map((sourcePool) => {
    const key = poolKey(sourcePool.poolAddress);
    const base = pools.get(key)!;
    const total = totals.get(key) ?? {
      activePositions: 0,
      claimable0: 0n,
      claimable1: 0n,
      pending0: 0n,
      pending1: 0n,
      positions: 0,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    };
    return { ...sourcePool, ...base, ...total };
  });

  await input.beforeRpc?.();
  await requireCanonicalBlock(input.client, input.source);
  return {
    blockHash: input.source.blockHash,
    blockNumber: input.source.blockNumber,
    chainId: input.source.chainId,
    eventsApplied: input.source.eventsApplied,
    observedAt: new Date().toISOString(),
    pools: poolStates,
    positions: positionStates,
    schemaVersion: 1,
    streamKey: input.source.streamKey,
    ticks: tickStates,
  };
}
