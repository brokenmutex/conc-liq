import assert from 'node:assert/strict';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import type {FeeSegment} from './swap.js';

/** A fixed-recorded-flow model, not a counterfactual on-chain fee proof.
 * Allocate an observed step's post-protocol fees by its exact rational input
 * distance. Virtual boundaries never mutate the canonical swap/tick book.
 * The two credits bound integer apportionment only, not market-impact error. */
export function virtualFeeCredit(s:FeeSegment, range:{tickLower:number;tickUpper:number}, ours:bigint, protocol:number) {
  assert(ours>=0n && s.fee>=0n && s.liquidity>=0n);
  assert(protocol===0 || Number.isInteger(protocol)&&protocol>=4&&protocol<=10);
  assert(range.tickLower<range.tickUpper);
  const zero={lower:0n,upper:0n,partial:false,allocatedLower:0n,allocatedUpper:0n};
  if(ours===0n || s.fee===0n)return zero;
  assert(s.liquidity>0n,'Fee-bearing segment has no canonical liquidity');
  const a=sqrtRatioAtTick(range.tickLower),b=sqrtRatioAtTick(range.tickUpper);
  const lo=s.from<s.to?s.from:s.to,hi=s.from>s.to?s.from:s.to;
  const left=lo>a?lo:a,right=hi<b?hi:b;
  let numerator=1n,denominator=1n;
  if(lo===hi){if(s.tickBefore<range.tickLower || s.tickBefore>=range.tickUpper)return zero;}
  else {
    if(left>=right)return zero;
    // token0 input is proportional to (1/lo - 1/hi), token1 to (hi-lo).
    numerator=(right-left)*(s.token===0?lo*hi:1n);
    denominator=(hi-lo)*(s.token===0?left*right:1n);
    assert(numerator>0n&&numerator<=denominator);
  }
  const fee=s.fee-(protocol?s.fee/BigInt(protocol):0n),product=fee*numerator;
  const low=product/denominator,high=(product+denominator-1n)/denominator;
  const credit=(n:bigint)=>n*(1n<<128n)/(s.liquidity+ours)*ours;
  return {lower:credit(low),upper:credit(high),partial:numerator!==denominator,allocatedLower:low,allocatedUpper:high};
}
