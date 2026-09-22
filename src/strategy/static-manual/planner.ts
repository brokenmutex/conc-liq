import assert from 'node:assert/strict';
import {MAX_TICK,MIN_TICK} from '../../backtest/principal.js';
import {replayPaperMint} from '../../v3/position-math.js';

const PPM=1_000_000n;
const rawValue=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);

/** Explicit outward rounding for an operator-requested tick interval. The
 * preview must show both requested and actual ticks before authorization. */
export function alignManualRange(requestedLower:number,requestedUpper:number,spacing:number){
 assert(Number.isSafeInteger(requestedLower)&&Number.isSafeInteger(requestedUpper)&&requestedLower<requestedUpper);
 assert(Number.isSafeInteger(spacing)&&spacing>0);
 const tickLower=Math.floor(requestedLower/spacing)*spacing;
 const tickUpper=Math.ceil(requestedUpper/spacing)*spacing;
 assert(tickLower>=MIN_TICK&&tickUpper<=MAX_TICK&&tickLower<tickUpper,'manual_tick_bounds');
 return {requestedLower,requestedUpper,tickLower,tickUpper,fullWidthTicks:tickUpper-tickLower,
  rounded:tickLower!==requestedLower||tickUpper!==requestedUpper};
}

export interface ManualFrame {
 continuity:'canonical'|'gap'|'reorg';tick:number;sqrtPriceX96:bigint;
 amount0:bigint;amount1:bigint;price0:bigint|null;price1:bigint|null;
 decimals0:number;decimals1:number;quoteToken:0|1;position:null|{tokenId:string;tickLower:number;tickUpper:number};
 pending:boolean;entryAllowed:boolean;safetyExitRequired:boolean;expiryReached:boolean;
}
export interface ManualLimits {
 maxDeploymentValue:bigint;minDeploymentValue:bigint;maxExposurePpm:number;
}
export type ManualDecision=
 |{action:'wait'|'safety_exit';reason:string;rangeState:'inside'|'outside'|'no_liquidity'|'unknown';candidate:null}
 |{action:'entry';reason:'manual_entry';rangeState:'inside'|'outside';candidate:{
   range:{tickLower:number;tickUpper:number};liquidity:bigint;amount0Desired:bigint;amount1Desired:bigint;
   amount0Minted:bigint;amount1Minted:bigint;idle0:bigint;idle1:bigint;
   deployedValue:bigint;exposurePpm:bigint;feeEarningAtEntry:boolean;oneSided:boolean;
 }};

/** Static policy: never proposes a recenter or automatic swap. The execution
 * adapter may build a separate, explicitly previewed bounded funding swap. */
export function decideStaticManual(frame:ManualFrame,range:{tickLower:number;tickUpper:number},limits:ManualLimits):ManualDecision{
 const state=frame.position===null?'no_liquidity':frame.tick>=frame.position.tickLower&&frame.tick<frame.position.tickUpper?'inside':'outside';
 const wait=(reason:string):ManualDecision=>({action:'wait',reason,rangeState:state,candidate:null});
 if(frame.safetyExitRequired||frame.expiryReached)return {action:'safety_exit',reason:frame.expiryReached?'manual_expiry':'manual_safety_exit',rangeState:state,candidate:null};
 if(frame.pending)return wait('pending_transaction');
 if(frame.position)return wait(state==='outside'?'manual_hold_outside':'manual_hold_inside');
 if(frame.continuity!=='canonical')return wait('source_not_canonical');
 if(!frame.entryAllowed)return wait('entry_not_allowed');
 if(frame.price0===null||frame.price1===null||frame.price0<=0n||frame.price1<=0n)return wait('independent_reference_unavailable');
 if(!Number.isSafeInteger(frame.decimals0)||!Number.isSafeInteger(frame.decimals1)||frame.decimals0<0||frame.decimals1<0)throw Error('invalid_decimals');
 if(limits.maxDeploymentValue<=0n||limits.minDeploymentValue<0n||limits.minDeploymentValue>limits.maxDeploymentValue||
  !Number.isSafeInteger(limits.maxExposurePpm)||limits.maxExposurePpm<0||limits.maxExposurePpm>1_000_000)throw Error('invalid_manual_limits');
 if(range.tickLower>=range.tickUpper||range.tickLower<MIN_TICK||range.tickUpper>MAX_TICK)throw Error('invalid_manual_range');
 const p0=frame.price0,p1=frame.price1;
 const total=rawValue(frame.amount0,p0,frame.decimals0)+rawValue(frame.amount1,p1,frame.decimals1);
 if(total===0n)return wait('empty_inventory');
 const fraction=total>limits.maxDeploymentValue?limits.maxDeploymentValue*PPM/total:PPM;
 const amount0=frame.amount0*fraction/PPM,amount1=frame.amount1*fraction/PPM;
 const mint=replayPaperMint(frame.sqrtPriceX96,range,amount0,amount1,0n);
 const deployedValue=rawValue(mint.amount0,p0,frame.decimals0)+rawValue(mint.amount1,p1,frame.decimals1);
 if(mint.liquidity===0n||deployedValue<limits.minDeploymentValue||deployedValue>limits.maxDeploymentValue)
  return wait('manual_mint_unaffordable');
 const risky=frame.quoteToken===0?rawValue(mint.amount1,p1,frame.decimals1):
  rawValue(mint.amount0,p0,frame.decimals0);
 const exposurePpm=risky*PPM/deployedValue;
 if(exposurePpm>BigInt(limits.maxExposurePpm))return wait('manual_exposure_limit');
 const feeEarningAtEntry=frame.tick>=range.tickLower&&frame.tick<range.tickUpper;
 return {action:'entry',reason:'manual_entry',rangeState:feeEarningAtEntry?'inside':'outside',candidate:{
  range,liquidity:mint.liquidity,amount0Desired:amount0,amount1Desired:amount1,
  amount0Minted:mint.amount0,amount1Minted:mint.amount1,idle0:mint.idle0,idle1:mint.idle1,
  deployedValue,exposurePpm,feeEarningAtEntry,oneSided:mint.amount0===0n||mint.amount1===0n,
 }};
}
