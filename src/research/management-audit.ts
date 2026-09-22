import assert from 'node:assert/strict';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import type {TickRange} from '../v3/position-math.js';
export {replayPaperMint} from '../v3/position-math.js';
import type {FeeSegment} from './swap.js';

const Q128=1n<<128n;

/** Undiluted observed fee growth, matching the paper boundary-fee convention.
 * The caller must retain the Q128 remainder between segments and observations.
 * Partial segments fail: exact agreement requires initialized range boundaries. */
export function paperSegmentCredit(segment:FeeSegment,range:TickRange,liquidity:bigint,protocol:number) {
 assert(protocol===0||(protocol>=4&&protocol<=10));
 if(segment.fee===0n||liquidity===0n)return 0n;
 const a=sqrtRatioAtTick(range.tickLower),b=sqrtRatioAtTick(range.tickUpper);
 const lo=segment.from<segment.to?segment.from:segment.to,hi=segment.from>segment.to?segment.from:segment.to;
 if(lo===hi){if(segment.tickBefore<range.tickLower||segment.tickBefore>=range.tickUpper)return 0n;}
 else{
  if(hi<=a||lo>=b)return 0n;
  assert(lo>=a&&hi<=b,'Partial fee segment: initialized boundary proof unavailable');
 }
 assert(segment.liquidity>0n);
 const fee=segment.fee-(protocol?segment.fee/BigInt(protocol):0n);
 return (fee*Q128/segment.liquidity)*liquidity;
}

export function referenceExposure(amount0:bigint,amount1:bigint,reference:bigint,costsAndReserve:bigint) {
 const risky=amount1*reference/10n**30n,total=amount0+risky-costsAndReserve;
 return total>0n?risky*1000000n/total:1000000n;
}
