import { getAddress, isAddress } from "viem";
import type {
  ReplayChanges,
  ReplayPoolState,
  ReplayPositionState,
  ReplayTickState,
  StoredReplayEvent,
} from "./domain.js";

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;

function poolKey(address: string): string {
  return address.toLowerCase();
}

function tickKey(address: string, tick: number): string {
  return `${poolKey(address)}:${tick}`;
}

function positionKey(
  poolAddress: string,
  ownerAddress: string,
  tickLower: number,
  tickUpper: number,
): string {
  return `${poolKey(poolAddress)}:${ownerAddress.toLowerCase()}:${tickLower}:${tickUpper}`;
}

function requireArgs(value: unknown, eventName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${eventName} arguments are not an object`);
  }
  return value as Record<string, unknown>;
}

function requireBigInt(
  args: Readonly<Record<string, unknown>>,
  name: string,
  eventName: string,
): bigint {
  const value = args[name];
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`${eventName}.${name} is not an exact integer`);
}

function requireUint(
  args: Readonly<Record<string, unknown>>,
  name: string,
  eventName: string,
): bigint {
  const value = requireBigInt(args, name, eventName);
  if (value < 0n) {
    throw new Error(`${eventName}.${name} is negative`);
  }
  return value;
}

function requireInteger(
  args: Readonly<Record<string, unknown>>,
  name: string,
  eventName: string,
): number {
  const value = args[name];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${eventName}.${name} is not a safe integer`);
}

function requireTick(
  args: Readonly<Record<string, unknown>>,
  name: string,
  eventName: string,
): number {
  const tick = requireInteger(args, name, eventName);
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`${eventName}.${name} is outside the v3 tick range`);
  }
  return tick;
}

function requireAddress(
  args: Readonly<Record<string, unknown>>,
  name: string,
  eventName: string,
): string {
  const value = args[name];
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${eventName}.${name} is not an address`);
  }
  return getAddress(value).toLowerCase();
}

function lowerBound(values: readonly number[], needle: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < needle) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

class TickBook {
  private readonly byTick = new Map<number, ReplayTickState>();
  private readonly sortedTicks: number[] = [];

  public constructor(ticks: readonly ReplayTickState[]) {
    for (const tick of [...ticks].sort((left, right) => left.tick - right.tick)) {
      if (tick.liquidityGross <= 0n) {
        throw new Error(`Stored tick ${tick.poolAddress}:${tick.tick} has no gross liquidity`);
      }
      this.byTick.set(tick.tick, tick);
      this.sortedTicks.push(tick.tick);
    }
  }

  public get(tick: number): ReplayTickState | undefined {
    return this.byTick.get(tick);
  }

  public values(): ReplayTickState[] {
    return [...this.byTick.values()];
  }

  public update(
    poolAddress: string,
    tick: number,
    liquidityDelta: bigint,
    upper: boolean,
  ): ReplayTickState | null {
    const existing = this.byTick.get(tick);
    const liquidityGross = (existing?.liquidityGross ?? 0n) + liquidityDelta;
    const liquidityNet = (existing?.liquidityNet ?? 0n) +
      (upper ? -liquidityDelta : liquidityDelta);
    if (liquidityGross < 0n) {
      throw new Error(`Tick gross-liquidity underflow at ${poolAddress}:${tick}`);
    }
    if (liquidityGross === 0n) {
      if (liquidityNet !== 0n) {
        throw new Error(`Cleared tick ${poolAddress}:${tick} has nonzero net liquidity`);
      }
      if (existing !== undefined) {
        this.byTick.delete(tick);
        this.sortedTicks.splice(lowerBound(this.sortedTicks, tick), 1);
      }
      return null;
    }

    const updated: ReplayTickState = existing ?? {
      liquidityGross,
      liquidityNet,
      poolAddress,
      tick,
    };
    updated.liquidityGross = liquidityGross;
    updated.liquidityNet = liquidityNet;
    if (existing === undefined) {
      this.byTick.set(tick, updated);
      this.sortedTicks.splice(lowerBound(this.sortedTicks, tick), 0, tick);
    }
    return updated;
  }

  public netBetweenExclusiveInclusive(fromTick: number, toTick: number): bigint {
    if (toTick <= fromTick) {
      return 0n;
    }
    let total = 0n;
    const start = lowerBound(this.sortedTicks, fromTick + 1);
    for (let index = start; index < this.sortedTicks.length; index += 1) {
      const tick = this.sortedTicks[index]!;
      if (tick > toTick) {
        break;
      }
      total += this.byTick.get(tick)!.liquidityNet;
    }
    return total;
  }
}

export class V3ReplayState {
  private readonly pools = new Map<string, ReplayPoolState>();
  private readonly ticks = new Map<string, TickBook>();
  private readonly positions = new Map<string, ReplayPositionState>();
  private readonly dirtyPools = new Set<string>();
  private readonly dirtyTicks = new Set<string>();
  private readonly deletedTicks = new Map<string, { poolAddress: string; tick: number }>();
  private readonly dirtyPositions = new Set<string>();

  public constructor(input: {
    readonly pools: readonly ReplayPoolState[];
    readonly positions?: readonly ReplayPositionState[];
    readonly ticks?: readonly ReplayTickState[];
  }) {
    for (const pool of input.pools) {
      const key = poolKey(pool.poolAddress);
      this.pools.set(key, pool);
      this.ticks.set(key, new TickBook(
        (input.ticks ?? []).filter((tick) => poolKey(tick.poolAddress) === key),
      ));
    }
    for (const position of input.positions ?? []) {
      this.positions.set(positionKey(
        position.poolAddress,
        position.ownerAddress,
        position.tickLower,
        position.tickUpper,
      ), position);
    }
  }

  public poolStates(): ReplayPoolState[] {
    return [...this.pools.values()];
  }

  public tickStates(): ReplayTickState[] {
    return [...this.ticks.values()].flatMap((book) => book.values());
  }

  public positionStates(): ReplayPositionState[] {
    return [...this.positions.values()];
  }

  public changes(): ReplayChanges {
    const ticks = [...this.dirtyTicks].flatMap((key) => {
      const separator = key.lastIndexOf(":");
      const address = key.slice(0, separator);
      const tick = Number(key.slice(separator + 1));
      const state = this.ticks.get(address)?.get(tick);
      return state === undefined ? [] : [state];
    });
    return {
      deletedTicks: [...this.deletedTicks.values()],
      pools: [...this.dirtyPools].map((key) => this.pools.get(key)!),
      positions: [...this.dirtyPositions].map((key) => this.positions.get(key)!),
      ticks,
    };
  }

  public clearChanges(): void {
    this.dirtyPools.clear();
    this.dirtyTicks.clear();
    this.deletedTicks.clear();
    this.dirtyPositions.clear();
  }

  public apply(event: StoredReplayEvent): void {
    const key = poolKey(event.poolAddress);
    const pool = this.pools.get(key);
    if (pool === undefined) {
      throw new Error(`Event references an unregistered pool ${event.poolAddress}`);
    }
    const args = requireArgs(event.args, event.eventName);
    switch (event.eventName) {
      case "Initialize":
        this.applyInitialize(pool, args);
        break;
      case "Mint":
        this.applyLiquidityChange(pool, args, false);
        pool.mintCount += 1n;
        break;
      case "Burn":
        this.applyLiquidityChange(pool, args, true);
        pool.burnCount += 1n;
        break;
      case "Collect":
        this.applyCollect(pool, args);
        pool.collectCount += 1n;
        break;
      case "Swap":
        this.applySwap(pool, args, event);
        pool.swapCount += 1n;
        break;
      case "Flash":
        this.requireInitialized(pool, event.eventName);
        pool.flashCount += 1n;
        break;
      case "IncreaseObservationCardinalityNext":
        this.applyCardinality(pool, args);
        break;
      case "SetFeeProtocol":
        this.applyFeeProtocol(pool, args);
        break;
      case "CollectProtocol":
        this.requireInitialized(pool, event.eventName);
        break;
      default:
        throw new Error(`Unsupported v3 event ${event.eventName}`);
    }

    pool.eventCount += 1n;
    pool.lastEventBlock = event.blockNumber;
    pool.lastEventTransactionIndex = event.transactionIndex;
    pool.lastEventLogIndex = event.logIndex;
    this.dirtyPools.add(key);
  }

  private requireInitialized(pool: ReplayPoolState, eventName: string): void {
    if (!pool.initialized || pool.tick === null) {
      throw new Error(`${eventName} occurred before Initialize for ${pool.poolAddress}`);
    }
  }

  private applyInitialize(
    pool: ReplayPoolState,
    args: Readonly<Record<string, unknown>>,
  ): void {
    if (pool.initialized) {
      throw new Error(`Pool ${pool.poolAddress} initialized more than once`);
    }
    const sqrtPriceX96 = requireUint(args, "sqrtPriceX96", "Initialize");
    if (sqrtPriceX96 === 0n) {
      throw new Error(`Pool ${pool.poolAddress} initialized at a zero price`);
    }
    pool.initialized = true;
    pool.sqrtPriceX96 = sqrtPriceX96;
    pool.tick = requireTick(args, "tick", "Initialize");
    pool.liquidity = 0n;
    pool.observationCardinalityNext = 1;
  }

  private applyLiquidityChange(
    pool: ReplayPoolState,
    args: Readonly<Record<string, unknown>>,
    burn: boolean,
  ): void {
    const eventName = burn ? "Burn" : "Mint";
    this.requireInitialized(pool, eventName);
    const ownerAddress = requireAddress(args, "owner", eventName);
    const tickLower = requireTick(args, "tickLower", eventName);
    const tickUpper = requireTick(args, "tickUpper", eventName);
    if (tickLower >= tickUpper) {
      throw new Error(`${eventName} has an invalid tick range`);
    }
    const amount = requireUint(args, "amount", eventName);
    const amount0 = requireUint(args, "amount0", eventName);
    const amount1 = requireUint(args, "amount1", eventName);
    const delta = burn ? -amount : amount;
    const key = positionKey(pool.poolAddress, ownerAddress, tickLower, tickUpper);
    let position = this.positions.get(key);
    if (position === undefined) {
      if (burn) {
        throw new Error(`Burn references an unknown position ${key}`);
      }
      position = {
        burnedAmount0: 0n,
        burnedAmount1: 0n,
        burnedLiquidity: 0n,
        collectedAmount0: 0n,
        collectedAmount1: 0n,
        liquidity: 0n,
        mintedAmount0: 0n,
        mintedAmount1: 0n,
        mintedLiquidity: 0n,
        ownerAddress,
        poolAddress: pool.poolAddress,
        tickLower,
        tickUpper,
      };
      this.positions.set(key, position);
    }
    if (position.liquidity + delta < 0n) {
      throw new Error(`Position liquidity underflow for ${key}`);
    }
    position.liquidity += delta;
    if (burn) {
      position.burnedLiquidity += amount;
      position.burnedAmount0 += amount0;
      position.burnedAmount1 += amount1;
    } else {
      position.mintedLiquidity += amount;
      position.mintedAmount0 += amount0;
      position.mintedAmount1 += amount1;
    }
    this.dirtyPositions.add(key);

    this.updateTick(pool.poolAddress, tickLower, delta, false);
    this.updateTick(pool.poolAddress, tickUpper, delta, true);
    if (pool.tick! >= tickLower && pool.tick! < tickUpper) {
      if (pool.liquidity + delta < 0n) {
        throw new Error(`Active liquidity underflow for ${pool.poolAddress}`);
      }
      pool.liquidity += delta;
    }
  }

  private updateTick(
    poolAddress: string,
    tick: number,
    delta: bigint,
    upper: boolean,
  ): void {
    const address = poolKey(poolAddress);
    const key = tickKey(address, tick);
    const updated = this.ticks.get(address)!.update(poolAddress, tick, delta, upper);
    if (updated === null) {
      this.dirtyTicks.delete(key);
      this.deletedTicks.set(key, { poolAddress, tick });
    } else {
      this.deletedTicks.delete(key);
      this.dirtyTicks.add(key);
    }
  }

  private applyCollect(
    pool: ReplayPoolState,
    args: Readonly<Record<string, unknown>>,
  ): void {
    this.requireInitialized(pool, "Collect");
    const ownerAddress = requireAddress(args, "owner", "Collect");
    const tickLower = requireTick(args, "tickLower", "Collect");
    const tickUpper = requireTick(args, "tickUpper", "Collect");
    const amount0 = requireUint(args, "amount0", "Collect");
    const amount1 = requireUint(args, "amount1", "Collect");
    const key = positionKey(pool.poolAddress, ownerAddress, tickLower, tickUpper);
    const position = this.positions.get(key);
    if (position === undefined) {
      if (amount0 === 0n && amount1 === 0n) {
        return;
      }
      throw new Error(`Collect references an unknown position ${key}`);
    }
    position.collectedAmount0 += amount0;
    position.collectedAmount1 += amount1;
    this.dirtyPositions.add(key);
  }

  private applySwap(
    pool: ReplayPoolState,
    args: Readonly<Record<string, unknown>>,
    event: StoredReplayEvent,
  ): void {
    this.requireInitialized(pool, "Swap");
    const nextTick = requireTick(args, "tick", "Swap");
    const nextLiquidity = requireUint(args, "liquidity", "Swap");
    const book = this.ticks.get(poolKey(pool.poolAddress))!;
    const crossedNet = nextTick >= pool.tick!
      ? book.netBetweenExclusiveInclusive(pool.tick!, nextTick)
      : -book.netBetweenExclusiveInclusive(nextTick, pool.tick!);
    const expectedLiquidity = pool.liquidity + crossedNet;
    if (expectedLiquidity !== nextLiquidity) {
      throw new Error(
        `Swap liquidity mismatch for ${pool.poolAddress} at ` +
        `${event.blockNumber}:${event.transactionIndex}:${event.logIndex}; ` +
        `expected ${expectedLiquidity}, event ${nextLiquidity}`,
      );
    }
    pool.sqrtPriceX96 = requireUint(args, "sqrtPriceX96", "Swap");
    pool.tick = nextTick;
    pool.liquidity = nextLiquidity;
  }

  private applyCardinality(
    pool: ReplayPoolState,
    args: Readonly<Record<string, unknown>>,
  ): void {
    this.requireInitialized(pool, "IncreaseObservationCardinalityNext");
    const oldValue = requireInteger(
      args,
      "observationCardinalityNextOld",
      "IncreaseObservationCardinalityNext",
    );
    const nextValue = requireInteger(
      args,
      "observationCardinalityNextNew",
      "IncreaseObservationCardinalityNext",
    );
    if (pool.observationCardinalityNext !== oldValue) {
      throw new Error(
        `Observation-cardinality mismatch for ${pool.poolAddress}: ` +
        `expected old ${pool.observationCardinalityNext}, event ${oldValue}`,
      );
    }
    pool.observationCardinalityNext = nextValue;
  }

  private applyFeeProtocol(
    pool: ReplayPoolState,
    args: Readonly<Record<string, unknown>>,
  ): void {
    this.requireInitialized(pool, "SetFeeProtocol");
    const old0 = requireInteger(args, "feeProtocol0Old", "SetFeeProtocol");
    const old1 = requireInteger(args, "feeProtocol1Old", "SetFeeProtocol");
    if (pool.feeProtocol0 !== old0 || pool.feeProtocol1 !== old1) {
      throw new Error(
        `Fee-protocol mismatch for ${pool.poolAddress}: expected ` +
        `${pool.feeProtocol0}/${pool.feeProtocol1}, event ${old0}/${old1}`,
      );
    }
    pool.feeProtocol0 = requireInteger(args, "feeProtocol0New", "SetFeeProtocol");
    pool.feeProtocol1 = requireInteger(args, "feeProtocol1New", "SetFeeProtocol");
  }
}
