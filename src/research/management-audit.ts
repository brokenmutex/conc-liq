import assert from 'node:assert/strict';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import {positionAmounts, type TickRange} from './portfolio-math.js';
import type {FeeSegment} from './swap.js';

const Q96=1n<<96n, Q128=1n<<128n;

/** Replay the position manager's LiquidityAmounts rounding, with native gas
 * accounted separately from the token inventory, as the paper fork does. */
export function replayPaperMint(price:bigint, range:TickRange, cash:bigint, rwa:bigint, reserve:bigint) {
 assert(cash>=reserve&&reserve>=0n&&rwa>=0n);
 const a=sqrtRatioAtTick(range.tickLower), b=sqrtRatioAtTick(range.tickUpper);
 assert(a<b);
 const l0=(lo:bigint,hi:bigint)=>(cash-reserve)*(lo*hi/Q96)/(hi-lo);
 const l1=(lo:bigint,hi:bigint)=>rwa*Q96/(hi-lo);
 const liquidity=price<=a?l0(a,b):price>=b?l1(a,b):(()=>{const x=l0(price,b),y=l1(a,price);return x<y?x:y;})();
 assert(liquidity>=0n&&liquidity<Q128);
 const amounts=positionAmounts(price,range,liquidity,true);
 assert(amounts.amount0<=cash-reserve&&amounts.amount1<=rwa);
 return {liquidity,...amounts,idle0:cash-amounts.amount0,idle1:rwa-amounts.amount1};
}

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
