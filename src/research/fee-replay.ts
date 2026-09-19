import assert from "node:assert/strict";
import { calculatePositionFees, feeGrowthInside, subtractUint256 } from "../accounting/math.js";
import { V3ReplayState } from "../replay/state.js";
import type { ReplayPoolState, StoredReplayEvent } from "../replay/domain.js";
import { tickSpacingForFee } from "../simulator/math.js";
import { lowerBound, reconstructSwap, type FeeSegment } from "./swap.js";

const Q128 = 1n << 128n, MASK256 = (1n << 256n) - 1n;
interface FeeTick { gross: bigint; net: bigint; outside0: bigint; outside1: bigint }
export interface FeePosition { owner: string; lower: number; upper: number; liquidity: bigint; last0: bigint; last1: bigint; owed0: bigint; owed1: bigint }
export function emptyPool(address: string, fee: number): ReplayPoolState {
  return { poolAddress: address, chainId: 4663, rwaSymbol: "NVDA", fee,
    initialized: false, sqrtPriceX96: null, tick: null, liquidity: 0n, observationCardinalityNext: null,
    feeProtocol0: 0, feeProtocol1: 0, eventCount: 0n, mintCount: 0n, burnCount: 0n, collectCount: 0n,
    swapCount: 0n, flashCount: 0n, lastEventBlock: null, lastEventTransactionIndex: null, lastEventLogIndex: null };
}

/** Isolated research state: does not change the operational replay or database. */
export class FeeReplay {
  readonly pool: ReplayPoolState;
  readonly state: V3ReplayState;
  readonly ticks = new Map<number, FeeTick>();
  readonly sortedTicks: number[] = [];
  readonly positions = new Map<string, FeePosition>();
  global0 = 0n;
  global1 = 0n;
  crossingSwaps = 0;
  swapSteps = 0;
  private last: StoredReplayEvent | null = null;
  constructor(address: string, fee: number) {
    this.pool = emptyPool(address, fee);
    this.state = new V3ReplayState({ pools: [this.pool] });
  }
  inside(lower: number, upper: number): [bigint, bigint] {
    const lo = this.ticks.get(lower), hi = this.ticks.get(upper);
    assert(lo && hi && this.pool.tick !== null, "Position fee ticks unavailable");
    const common = { currentTick: this.pool.tick, tickLower: lower, tickUpper: upper };
    return [feeGrowthInside({ ...common, feeGrowthGlobalX128: this.global0, lowerFeeGrowthOutsideX128: lo.outside0, upperFeeGrowthOutsideX128: hi.outside0 }),
      feeGrowthInside({ ...common, feeGrowthGlobalX128: this.global1, lowerFeeGrowthOutsideX128: lo.outside1, upperFeeGrowthOutsideX128: hi.outside1 })];
  }
  private accrue(fee: bigint, token: 0 | 1, liquidity: bigint): void {
    assert(fee >= 0n && (fee === 0n || liquidity > 0n), "Fee without active liquidity");
    const protocol = token === 0 ? this.pool.feeProtocol0 : this.pool.feeProtocol1;
    assert(protocol === 0 || (protocol >= 4 && protocol <= 10), "Invalid v3 protocol fee");
    const lpFee = fee - (protocol === 0 ? 0n : fee / BigInt(protocol));
    const growth = liquidity === 0n ? 0n : lpFee * Q128 / liquidity;
    if (token === 0) this.global0 = (this.global0 + growth) & MASK256;
    else this.global1 = (this.global1 + growth) & MASK256;
  }
  private modify(args: Record<string, unknown>, burn: boolean): void {
    const lower = Number(args.tickLower), upper = Number(args.tickUpper), amount = BigInt(String(args.amount));
    assert(Number.isInteger(lower) && Number.isInteger(upper) && lower < upper && amount >= 0n);
    for (const tick of [lower, upper]) {
      if (!this.ticks.has(tick) && amount > 0n) {
        assert(!burn && this.pool.tick !== null, "Missing burned tick");
        this.ticks.set(tick, { gross: 0n, net: 0n, outside0: tick <= this.pool.tick ? this.global0 : 0n, outside1: tick <= this.pool.tick ? this.global1 : 0n });
        this.sortedTicks.splice(lowerBound(this.sortedTicks, tick), 0, tick);
      }
    }
    const owner = String(args.owner).toLowerCase(), key = `${owner}:${lower}:${upper}`;
    let position = this.positions.get(key);
    if (!position) {
      assert(!burn && amount > 0n, "Missing fee position");
      position = { owner, lower, upper, liquidity: 0n, last0: 0n, last1: 0n, owed0: 0n, owed1: 0n };
      this.positions.set(key, position);
    }
    assert(amount > 0n || position.liquidity > 0n, "Cannot poke an empty position");
    const [inside0, inside1] = this.inside(lower, upper);
    const claim = calculatePositionFees({ feeGrowthInside0LastX128: position.last0, feeGrowthInside1LastX128: position.last1,
      feeGrowthInside0X128: inside0, feeGrowthInside1X128: inside1, liquidity: position.liquidity,
      tokensOwed0: position.owed0, tokensOwed1: position.owed1 });
    position.owed0 = claim.claimable0 + (burn ? BigInt(String(args.amount0)) : 0n);
    position.owed1 = claim.claimable1 + (burn ? BigInt(String(args.amount1)) : 0n);
    position.last0 = inside0; position.last1 = inside1;
    const change = burn ? -amount : amount;
    position.liquidity += change;
    assert(position.liquidity >= 0n && position.liquidity < Q128 && position.owed0 < Q128 && position.owed1 < Q128);
    for (const tick of [lower, upper]) {
      const t = this.ticks.get(tick)!;
      t.gross += change; t.net += tick === lower ? change : -change;
      assert(t.gross >= 0n);
      if (t.gross === 0n) {
        assert(t.net === 0n);
        this.ticks.delete(tick); this.sortedTicks.splice(lowerBound(this.sortedTicks, tick), 1);
      }
    }
  }
  apply(event: StoredReplayEvent): FeeSegment[] {
    assert(event.poolAddress.toLowerCase() === this.pool.poolAddress.toLowerCase(), "Wrong research pool");
    if (this.last) {
      const last = this.last;
      assert(event.blockNumber > last.blockNumber || (event.blockNumber === last.blockNumber &&
        (event.transactionIndex > last.transactionIndex || (event.transactionIndex === last.transactionIndex && event.logIndex > last.logIndex))), "Events must be strictly ordered");
      if (event.blockNumber === last.blockNumber) {
        assert(event.blockHash.toLowerCase() === last.blockHash.toLowerCase(), "Block hash changed within event stream");
        if (event.transactionIndex === last.transactionIndex) assert(event.transactionHash.toLowerCase() === last.transactionHash.toLowerCase(), "Transaction identity mismatch");
      }
    } else assert(event.eventName === "Initialize", "Replay must begin at pool initialization");
    const args = event.args as Record<string, unknown>;
    let segments: FeeSegment[] = [];
    try {
      switch (event.eventName) {
        case "Swap": {
          assert(this.pool.sqrtPriceX96 !== null && this.pool.tick !== null);
          segments = reconstructSwap({ price: this.pool.sqrtPriceX96, tick: this.pool.tick, liquidity: this.pool.liquidity,
            fee: this.pool.fee, spacing: tickSpacingForFee(this.pool.fee), ticks: this.sortedTicks, net: tick => this.ticks.get(tick)!.net },
          { price: BigInt(String(args.sqrtPriceX96)), tick: Number(args.tick), liquidity: BigInt(String(args.liquidity)),
            amount0: BigInt(String(args.amount0)), amount1: BigInt(String(args.amount1)) });
          for (const segment of segments) {
            this.accrue(segment.fee, segment.token, segment.liquidity);
            if (segment.crossed !== null) {
              const tick = this.ticks.get(segment.crossed)!;
              tick.outside0 = subtractUint256(this.global0, tick.outside0);
              tick.outside1 = subtractUint256(this.global1, tick.outside1);
            }
          }
          this.swapSteps += segments.length;
          if (segments.some(s => s.crossed !== null)) this.crossingSwaps++;
          break;
        }
        case "Mint": case "Burn": this.modify(args, event.eventName === "Burn"); break;
        case "Flash":
          this.accrue(BigInt(String(args.paid0)), 0, this.pool.liquidity);
          this.accrue(BigInt(String(args.paid1)), 1, this.pool.liquidity);
          break;
        case "Collect": {
          const p = this.positions.get(`${String(args.owner).toLowerCase()}:${args.tickLower}:${args.tickUpper}`);
          const amount0 = BigInt(String(args.amount0)), amount1 = BigInt(String(args.amount1));
          if (!p) assert(amount0 === 0n && amount1 === 0n, "Collect without position");
          else { p.owed0 -= amount0; p.owed1 -= amount1; assert(p.owed0 >= 0n && p.owed1 >= 0n, "Collected fees exceed reconstructed balance"); }
          break;
        }
      }
      this.state.apply(event);
      this.state.clearChanges();
      this.last = event;
      return segments;
    } catch (error) {
      throw new Error(`Fee replay failed at ${event.blockNumber}:${event.transactionIndex}:${event.logIndex} ${event.eventName}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
