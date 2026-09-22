import assert from 'node:assert/strict';
import {Q96,sqrtRatioAtTick} from '../backtest/principal.js';

export interface TickRange {tickLower:number;tickUpper:number}
const Q128=1n<<128n;
const ceilDiv=(a:bigint,b:bigint)=>(a+b-1n)/b;

/** Exact V3 token amounts for liquidity at the observed sqrt price. */
export function positionAmounts(price:bigint,range:TickRange,liquidity:bigint,roundUp:boolean){
 const lower=sqrtRatioAtTick(range.tickLower),upper=sqrtRatioAtTick(range.tickUpper);
 const bounded=price<lower?lower:price>upper?upper:price;
 const delta=(a:bigint,b:bigint,token:0|1)=>{
  assert(a>0n&&b>=a&&liquidity>=0n);
  const numerator=token===0?liquidity*Q96*(b-a):liquidity*(b-a);
  const denominator=token===0?a*b:Q96;
  return roundUp?ceilDiv(numerator,denominator):numerator/denominator;
 };
 return {amount0:delta(bounded,upper,0),amount1:delta(lower,bounded,1)};
}

/** Position manager LiquidityAmounts rounding with a separate token0 reserve.
 * Token names and decimals are supplied by the caller, never assumed here. */
export function replayPaperMint(price:bigint,range:TickRange,amount0:bigint,amount1:bigint,reserve0:bigint){
 assert(amount0>=reserve0&&reserve0>=0n&&amount1>=0n);
 const a=sqrtRatioAtTick(range.tickLower),b=sqrtRatioAtTick(range.tickUpper);
 assert(a<b);
 const l0=(lo:bigint,hi:bigint)=>(amount0-reserve0)*(lo*hi/Q96)/(hi-lo);
 const l1=(lo:bigint,hi:bigint)=>amount1*Q96/(hi-lo);
 const liquidity=price<=a?l0(a,b):price>=b?l1(a,b):(()=>{const x=l0(price,b),y=l1(a,price);return x<y?x:y;})();
 assert(liquidity>=0n&&liquidity<Q128);
 const amounts=positionAmounts(price,range,liquidity,true);
 assert(amounts.amount0<=amount0-reserve0&&amounts.amount1<=amount1);
 return {liquidity,...amounts,idle0:amount0-amounts.amount0,idle1:amount1-amounts.amount1};
}
