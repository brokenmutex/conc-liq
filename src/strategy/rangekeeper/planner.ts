import assert from 'node:assert/strict';
import {MAX_TICK,MIN_TICK,sqrtRatioAtTick} from '../../backtest/principal.js';
import {replayPaperMint} from '../../research/management-audit.js';
import type {RangeKeeperCandidate,RangeKeeperDecision,RangeKeeperLimits,RangeKeeperObservation,RangeKeeperState} from './domain.js';

const PPM=1_000_000n;
const min=(a:bigint,b:bigint)=>a<b?a:b;
const max=(a:bigint,b:bigint)=>a>b?a:b;
const remaining=(limit:bigint,spent:bigint)=>limit>spent?limit-spent:0n;
export const rawValue=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);
const affordableRaw=(value:bigint,price:bigint,decimals:number)=>value*10n**BigInt(decimals)/price;

/** A full even span centered on the floor-aligned current tick. */
export function rangeKeeperRange(tick:number,spacing:number,fullWidthSpacings:number){
 assert(Number.isSafeInteger(tick)&&Number.isSafeInteger(spacing)&&spacing>0);
 assert(Number.isSafeInteger(fullWidthSpacings)&&fullWidthSpacings>0&&fullWidthSpacings%2===0);
 const anchor=Math.floor(tick/spacing)*spacing,half=fullWidthSpacings/2;
 const tickLower=anchor-half*spacing,tickUpper=anchor+half*spacing;
 assert(tickLower>=MIN_TICK&&tickUpper<=MAX_TICK,'rangekeeper_tick_bounds');
 assert(tick>=tickLower&&tick<tickUpper,'rangekeeper_centered_range_missed_price');
 return {tickLower,tickUpper};
}

export interface SwapQuote {
 amountOut:bigint;priceAfter:bigint;feeValue:bigint;shortfallValue:bigint;
 sourceBlock:bigint;sourceHash:string;
}
export interface RangeKeeperPlannerInput {
 state:RangeKeeperState;observation:RangeKeeperObservation;limits:RangeKeeperLimits;
 spacing:number;decimals0:number;decimals1:number;quoteToken:0|1;maxPoolDeviationPpm:number;
 /** Quotes must use the exact canonical observation and the approved direct route. */
 quote:(token:0|1,amountIn:bigint)=>Promise<SwapQuote>;
 /** Exact calldata simulation for the frozen proposal at this observation. */
 simulate:(candidate:RangeKeeperCandidate)=>Promise<boolean>;
}

function candidateIdentity(c:RangeKeeperCandidate){
 return [c.kind,c.range.tickLower,c.range.tickUpper,c.swap?.token??'none',String(c.swap?.amountIn??0n),
  String(c.amount0Desired),String(c.amount1Desired),String(c.amount0Min),String(c.amount1Min),String(c.liquidity)].join(':');
}

async function construct(input:RangeKeeperPlannerInput,range:{tickLower:number;tickUpper:number},kind:'entry'|'recenter'){
 const {observation:o,limits:l,decimals0:d0,decimals1:d1}=input;
 const p0=o.price0!,p1=o.price1!;
 const wallet0=o.wallet0+o.released0,wallet1=o.wallet1+o.released1;
 const total=rawValue(wallet0,p0,d0)+rawValue(wallet1,p1,d1);
 const fraction=total>l.maxDeploymentValue?l.maxDeploymentValue*PPM/total:PPM;
 // The cap is fixed at campaign creation. Token surplus remains idle inventory.
 const base0=wallet0*fraction/PPM,base1=wallet1*fraction/PPM;
 const floor=l.maxDeploymentValue*BigInt(l.minDeploymentPpm)/PPM;
 const evaluate=(a0:bigint,a1:bigint,price:bigint)=>{
  if(price<=sqrtRatioAtTick(range.tickLower)||price>=sqrtRatioAtTick(range.tickUpper))return null;
  const m=replayPaperMint(price,range,a0,a1,0n);
  if(m.liquidity===0n)return null;
  const deployed=rawValue(m.amount0,p0,d0)+rawValue(m.amount1,p1,d1);
  return {m,deployed,feasible:deployed>=floor&&deployed<=l.maxDeploymentValue};
 };
 const initial=evaluate(base0,base1,o.sqrtPriceX96);
 const make=(a0:bigint,a1:bigint,price:bigint,swap:RangeKeeperCandidate['swap']):RangeKeeperCandidate|null=>{
  const r=evaluate(a0,a1,price);if(!r?.feasible)return null;
  const haircut=10_000n-BigInt(l.maxSlippageBps);
  return {kind,range,swap,amount0Desired:a0,amount1Desired:a1,
   amount0Min:r.m.amount0*haircut/10_000n,amount1Min:r.m.amount1*haircut/10_000n,
   liquidity:r.m.liquidity,deployedValue:r.deployed,sourceBlock:o.block,sourceHash:o.hash,expiresAt:o.timestamp+90};
 };
 if(initial?.feasible)return make(base0,base1,o.sqrtPriceX96,null);
 // The token left idle by the exact no-swap mint is the only allowed input.
 const idle0=initial?.m.idle0??base0,idle1=initial?.m.idle1??base1;
 const token:0|1=rawValue(idle0,p0,d0)>rawValue(idle1,p1,d1)?0:1;
 const available=token===0?base0:base1,priceIn=token===0?p0:p1,decimalsIn=token===0?d0:d1;
 if(available===0n)return null;
 const bound=min(available*BigInt(l.maxSwapInputPpm)/PPM,affordableRaw(l.maxSwapInputValue,priceIn,decimalsIn));
 if(bound===0n)return null;
 const seen=new Map<bigint,SwapQuote>();
 const quoted=async(amount:bigint)=>{
  const q=seen.get(amount)??await input.quote(token,amount);
  assert(q.sourceBlock===o.block&&q.sourceHash.toLowerCase()===o.hash.toLowerCase(),'rangekeeper_quote_source');
  assert(q.amountOut>0n&&q.priceAfter>0n&&q.feeValue>=0n&&q.shortfallValue>=0n,'rangekeeper_invalid_quote');
  for(const [otherAmount,other] of seen){
   const smaller=amount<otherAmount;
   assert(smaller?q.amountOut<=other.amountOut:q.amountOut>=other.amountOut,'rangekeeper_quote_nonmonotonic_output');
   assert(token===0?(smaller?q.priceAfter>=other.priceAfter:q.priceAfter<=other.priceAfter):
    (smaller?q.priceAfter<=other.priceAfter:q.priceAfter>=other.priceAfter),'rangekeeper_quote_nonmonotonic_price');
  }
  seen.set(amount,q);
  assert(q.shortfallValue<=l.maxSwapShortfallValue,'rangekeeper_swap_shortfall');
  const next0=token===0?base0-amount:base0+q.amountOut;
  const next1=token===1?base1-amount:base1+q.amountOut;
  if(next0<0n||next1<0n)return null;
  if(q.priceAfter<=sqrtRatioAtTick(range.tickLower)||q.priceAfter>=sqrtRatioAtTick(range.tickUpper))return null;
  const haircut=10_000n-BigInt(l.maxSlippageBps);
  return make(next0,next1,q.priceAfter,{token,amountIn:amount,quotedOut:q.amountOut,
   minOut:q.amountOut*haircut/10_000n,priceAfter:q.priceAfter,feeValue:q.feeValue,shortfallValue:q.shortfallValue});
 };
 let upper=1n,lower=0n,found:RangeKeeperCandidate|null=null,calls=0;
 while(upper<=bound&&calls<80){
  const c=await quoted(upper);calls++;
  if(c){found=c;break;}
  if(upper===bound)break;
  lower=upper;upper=min(bound,upper*2n);
 }
 if(!found)return null;
 while(upper-lower>1n&&calls<160){
  const middle=(upper+lower)/2n,c=await quoted(middle);calls++;
  if(c){upper=middle;found=c;}else lower=middle;
 }
 if(upper-lower>1n)return null;
 // Prove minimality at the raw-unit predecessor, including quote impact.
 if(upper>1n&&await quoted(upper-1n))return null;
 return found;
}

/** One observation advances the persisted timer/confirmation and returns a
 * reason-coded decision. Callers must reconcile pending receipts and custody
 * before supplying an observation. This module never signs or broadcasts. */
export async function planRangeKeeper(input:RangeKeeperPlannerInput):Promise<RangeKeeperDecision>{
 const o=input.observation,l=input.limits,s=structuredClone(input.state);
 const exitReserve=o.requiredExitReserveWei===null?null:max(l.exitReserveWei,o.requiredExitReserveWei);
 const budgets={action:l.maxActionCost,rolling:remaining(l.maxRollingCost,o.rollingSpentCost+o.reservedCost),
  campaign:remaining(l.maxCampaignCost,o.campaignSpentCost+o.reservedCost),nativeWei:exitReserve===null?0n:remaining(o.nativeWei,exitReserve)};
 const result=(action:RangeKeeperDecision['action'],reason:string,candidate:RangeKeeperCandidate|null=null):RangeKeeperDecision=>
  ({action,reason,state:s,candidate,remaining:budgets});
 assert(o.block>=0n&&Number.isSafeInteger(o.timestamp)&&Number.isSafeInteger(o.tick));
 assert(o.sqrtPriceX96>0n&&Number.isInteger(input.maxPoolDeviationPpm)&&input.maxPoolDeviationPpm>0&&input.maxPoolDeviationPpm<=1_000_000);
 assert(o.wallet0>=0n&&o.wallet1>=0n&&o.released0>=0n&&o.released1>=0n&&o.nativeWei>=0n);
 assert(o.requiredExitReserveWei===null||o.requiredExitReserveWei>=0n);
 assert(o.reservedCost>=0n&&o.rollingSpentCost>=0n&&o.campaignSpentCost>=0n);
 if(o.continuity!=='canonical'){s.exit=null;s.confirmation=null;s.lastEligible=null;return result('wait',`source_${o.continuity}`);}
 if(s.lastEligible&&(o.block<=s.lastEligible.block||o.timestamp<=s.lastEligible.timestamp))return result('wait','duplicate_or_backward_observation');
 if(o.safeExitRequired){s.confirmation=null;return result('safety_exit','risk_exit_required');}
 if(o.pending)return result('wait','pending_transaction');
 if(o.price0!==null&&o.price1!==null&&o.price0>0n&&o.price1>0n){
  const equityNow=rawValue(o.wallet0+o.released0,o.price0,input.decimals0)+rawValue(o.wallet1+o.released1,o.price1,input.decimals1);
  if(o.campaignStartValue>equityNow&&o.campaignStartValue-equityNow>l.maxLossValue){s.confirmation=null;return result('safety_exit','loss_limit');}
  if(o.highWaterValue>equityNow&&(o.highWaterValue-equityNow)*PPM>o.highWaterValue*BigInt(l.maxDrawdownPpm)){
   s.confirmation=null;return result('safety_exit','drawdown_limit');
  }
  const poolPrice1=((1n<<192n)*10n**BigInt(input.decimals1)*o.price0)/
   (o.sqrtPriceX96*o.sqrtPriceX96*10n**BigInt(input.decimals0));
  const deviation=poolPrice1>o.price1?poolPrice1-o.price1:o.price1-poolPrice1;
  if(deviation*PPM>o.price1*BigInt(input.maxPoolDeviationPpm)){
   s.confirmation=null;return result(o.position?'safety_exit':'wait','independent_price_band');
  }
 }
 if(o.position){
  const p=o.position,inside=o.tick>=p.tickLower&&o.tick<p.tickUpper;
  if(inside){s.exit=null;s.confirmation=null;return result('wait','inside_range');}
  const matches=s.exit?.tokenId===p.tokenId&&s.exit.tickLower===p.tickLower&&s.exit.tickUpper===p.tickUpper;
  const gap=s.exit?o.timestamp-s.exit.lastOutsideAt:0;
  if(!matches||gap<0||gap>l.maxObservationGapSeconds){
   s.exit={tokenId:p.tokenId,tickLower:p.tickLower,tickUpper:p.tickUpper,block:o.block,hash:o.hash,since:o.timestamp,lastOutsideAt:o.timestamp};
   s.confirmation=null;
  }else s.exit!.lastOutsideAt=o.timestamp;
  if(o.timestamp-s.exit!.since<300)return result('wait','exit_persistence');
 }else {s.exit=null;}
 if(s.lastEligible&&o.timestamp-s.lastEligible.timestamp<30)return result('wait','decision_interval');
 s.lastEligible={block:o.block,hash:o.hash,timestamp:o.timestamp};
 if(!o.entryAllowed||!o.executionReady)return result('wait','entry_or_execution_gate');
 if(o.price0===null||o.price1===null||o.nativePrice===null||o.price0<=0n||o.price1<=0n||o.nativePrice<=0n)return result('wait','independent_reference_unavailable');
 if(o.actionCost===null||o.actionGasWei===null)return result('wait','complete_action_cost_unavailable');
 if(exitReserve===null)return result('wait','complete_exit_reserve_unavailable');
 if(o.liquiditySharePpm===null||o.liquiditySharePpm>l.maxLiquiditySharePpm)return result('wait','liquidity_share_limit');
 const equity=rawValue(o.wallet0+o.released0,o.price0,input.decimals0)+rawValue(o.wallet1+o.released1,o.price1,input.decimals1);
 if(equity===0n)return result('wait','no_strategy_inventory');
 if(o.position&&o.recenters>=l.maxRecenters)return result('wait','recenter_count_limit');
 if(o.actionCost>budgets.action||o.actionCost>budgets.rolling||o.actionCost>budgets.campaign)return result('wait','cost_limit');
 if(o.nativeWei<o.actionGasWei+exitReserve)return result('wait','native_exit_reserve');
 let candidate:RangeKeeperCandidate|null;
 try{candidate=await construct(input,rangeKeeperRange(o.tick,input.spacing,l.fullWidthSpacings),o.position?'recenter':'entry');}
 catch{return result('wait','construction_unproven');}
 if(!candidate)return result('wait','inventory_deployment_unfeasible');
 if(candidate.swap&&candidate.swap.feeValue+candidate.swap.shortfallValue>o.actionCost)return result('wait','incomplete_cost_quote');
 const sw=candidate.swap;
 const next0=o.wallet0+o.released0+(sw?(sw.token===0?-sw.amountIn:sw.quotedOut):0n);
 const next1=o.wallet1+o.released1+(sw?(sw.token===1?-sw.amountIn:sw.quotedOut):0n);
 const nextEquity=rawValue(next0,o.price0,input.decimals0)+rawValue(next1,o.price1,input.decimals1);
 const nextRisk=input.quoteToken===0?rawValue(next1,o.price1,input.decimals1):rawValue(next0,o.price0,input.decimals0);
 if(nextEquity<=0n||nextRisk*PPM>nextEquity*BigInt(l.maxExposurePpm))return result('wait','resulting_exposure_limit');
 const prior=s.confirmation;
 const frozen=prior&&o.timestamp-prior.firstAt<=90&&o.block>prior.firstBlock&&candidateIdentity(prior.candidate)===candidateIdentity(candidate)?prior.candidate:candidate;
 try{if(!await input.simulate(frozen))return result('wait','calldata_simulation_failed');}
 catch{return result('wait','calldata_simulation_unavailable');}
 if(prior&&o.timestamp-prior.firstAt<=90&&o.block>prior.firstBlock&&candidateIdentity(prior.candidate)===candidateIdentity(candidate)){
  s.confirmation=null;return result('execute','two_confirmations',prior.candidate);
 }
 s.confirmation={candidate,firstBlock:o.block,firstHash:o.hash,firstAt:o.timestamp};
 return result('confirm','first_confirmation',candidate);
}
