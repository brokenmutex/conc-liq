import assert from 'node:assert/strict';
import { paperEntryRange } from '../paper/engine.js';
import { sqrtRatioAtTick } from '../backtest/principal.js';
import { sizeLiquidityForQuoteBudget } from '../simulator/math.js';
import { historicalSwapQuote, modeledFeeGrowth, nvdaValueQuote, positionAmounts, type TickRange } from '../research/portfolio-math.js';
import type { FeeSegment, SwapSource } from '../research/swap.js';
import type { ExperimentFrame } from './market.js';
const Q128=1n<<128n, priceX18=(p:bigint)=>(1n<<192n)*10n**30n/p**2n;
export interface ExperimentCosts {buy:string;sell:string;mint:string;remove:string;revoke:string}
export interface Candidate {id:string;budget:string;halfWidthTicks:number;management:'exit_reentry'|'recenter';costMultiplier:number;feeIncomePpm:number}
interface Position extends TickRange {liquidity:bigint;fee0:bigint;fee1:bigint;enteredAt:number;center:bigint}
interface Pending {kind:'entry'|'recenter'|'exit';after:number;range:TickRange|null;token:0|1|null;amount:bigint;minimum:bigint;reason:string;target:bigint}
export interface PortfolioState {
 benchmark:{cash:bigint;rwa:bigint;after:number|null;minimum:bigint;filled:boolean};
 cash:bigint;rwa:bigint;position:Position|null;pending:Pending|null;lastAt:number|null;lastBlock:string|null;lastTarget:string|null;
 costs:bigint;fees0:bigint;fees1:bigint;hold0:bigint|null;hold1:bigint|null;holdCosts:bigint;lastExit:number;lastMove:number;persistence:number;
 peak:bigint;drawdown:bigint;maxExposure:bigint;peakShare:bigint;entries:number;recenters:number;exits:number;infrastructureExits:number;infrastructureExitCosts:bigint;infrastructureReentryCosts:bigint;lastExitReason:string|null;
 observations:number;eligible:number;activeSeconds:number;outsideSeconds:number;cashSeconds:number;blocked:Record<string,number>;invalid:string|null;
}
export class ExperimentPortfolio {
 s:PortfolioState;
 actions:Record<string,unknown>[]=[];
 constructor(readonly candidate:Candidate,readonly costModel:ExperimentCosts,state?:PortfolioState){
  assert([10,20,30,40,50].includes(candidate.halfWidthTicks));assert([1,2].includes(candidate.costMultiplier)&&[500000,1000000].includes(candidate.feeIncomePpm));assert(['exit_reentry','recenter'].includes(candidate.management));assert(BigInt(candidate.budget)>0n&&BigInt(candidate.budget)<=10000000000n);
  this.s=state??{benchmark:{cash:BigInt(candidate.budget),rwa:0n,after:null,minimum:0n,filled:false},cash:BigInt(candidate.budget),rwa:0n,position:null,pending:null,lastAt:null,lastBlock:null,lastTarget:null,costs:0n,fees0:0n,fees1:0n,hold0:null,hold1:null,holdCosts:0n,lastExit:-1e15,lastMove:-1e15,persistence:0,peak:BigInt(candidate.budget),drawdown:0n,maxExposure:0n,peakShare:0n,entries:0,recenters:0,exits:0,infrastructureExits:0,infrastructureExitCosts:0n,infrastructureReentryCosts:0n,lastExitReason:null,observations:0,eligible:0,activeSeconds:0,outsideSeconds:0,cashSeconds:0,blocked:{},invalid:null};
 }
 cost(kind:keyof ExperimentCosts){return BigInt(this.costModel[kind])*BigInt(this.candidate.costMultiplier);}
 balances(m:SwapSource){const p=this.s.position,a=p?positionAmounts(m.price,p,p.liquidity,false):{amount0:0n,amount1:0n};return {amount0:this.s.cash+a.amount0+(p?p.fee0/Q128:0n),amount1:this.s.rwa+a.amount1+(p?p.fee1/Q128:0n)};}
 private gross(m:SwapSource,reference=priceX18(m.price)){const b=this.balances(m);return b.amount0+nvdaValueQuote(b.amount1,reference);}
 private reserve(){return this.s.position?this.cost('remove')+this.cost('sell')+this.cost('revoke'):this.s.rwa>0n?this.cost('sell')+this.cost('revoke'):0n;}
 private block(reason:string){this.s.blocked[reason]=(this.s.blocked[reason]??0)+1;}
 private record(f:ExperimentFrame,action:string,reason:string){assert(this.s.cash>=0n&&this.s.rwa>=0n);this.actions.push({sourceAt:f.sourceAt,observedAt:f.observedAt,block:f.block,action,reason,cash:String(this.s.cash),rwa:String(this.s.rwa),costs:String(this.s.costs)});}
 private charge(kind:keyof ExperimentCosts){const cost=this.cost(kind);if(this.s.cash<cost){this.block('cash_insufficient_for_cost');return false;}this.s.cash-=cost;this.s.costs+=cost;return true;}
 private allowed(f:ExperimentFrame,range?:TickRange){
  if(!f.referenceEligible||!f.chainHealthy||!f.dataValid||!f.referencePrice)return false;
  const ref=BigInt(f.referencePrice);for(const price of [BigInt(f.price),...(range?[sqrtRatioAtTick(range.tickLower),sqrtRatioAtTick(range.tickUpper)]:[])]){const v=priceX18(price);if(v*1000000n<ref*950000n||v*1000000n>ref*1050000n)return false;}
  return true;
 }
 accrue(segment:FeeSegment,protocol:number){const p=this.s.position;if(!p||this.s.invalid)return;const credit=modeledFeeGrowth(segment,p,p.liquidity,protocol)*p.liquidity*BigInt(this.candidate.feeIncomePpm)/1000000n;
  if(segment.token===0){const old=p.fee0/Q128;p.fee0+=credit;this.s.fees0+=p.fee0/Q128-old;}else{const old=p.fee1/Q128;p.fee1+=credit;this.s.fees1+=p.fee1/Q128-old;}
  if(segment.liquidity>0n){const share=p.liquidity*1000000n/segment.liquidity;if(share>this.s.peakShare)this.s.peakShare=share;}
 }
 private remove(f:ExperimentFrame,m:SwapSource,reason:string){const p=this.s.position;if(!p)return true;if(!this.charge('remove'))return false;const a=positionAmounts(m.price,p,p.liquidity,false);this.s.cash+=a.amount0+p.fee0/Q128;this.s.rwa+=a.amount1+p.fee1/Q128;this.s.position=null;this.record(f,'remove_collect',reason);return true;}
 private swap(f:ExperimentFrame,m:SwapSource,token:0|1,amount:bigint,minimum:bigint,reason:string):SwapSource|null{
  if(amount===0n)return m;const q=historicalSwapQuote(m,amount,token);if(!q.fullyFilled||!q.passesSlippage||q.amountOut<minimum){this.block('swap_preflight_failed');return null;}
  if((token===0&&this.s.cash<amount+this.cost('buy'))||(token===1&&(this.s.rwa<amount||this.s.cash<this.cost('sell')))){this.block('swap_funding_failed');return null;}
  assert(this.charge(token===0?'buy':'sell'));if(token===0){this.s.cash-=amount;this.s.rwa+=q.amountOut;}else{this.s.rwa-=amount;this.s.cash+=q.amountOut;}
  this.record(f,token===0?'buy_nvda':'sell_nvda',reason);return {...m,price:q.sqrtPriceAfter,tick:q.tickAfter,liquidity:q.liquidityAfter};
 }
 private quote(f:ExperimentFrame,m:SwapSource,kind:'entry'|'recenter',reason:string){
  const range=paperEntryRange({tick:m.tick,sqrtPriceX96:String(m.price)},{halfWidthSpacings:this.candidate.halfWidthTicks/10,feeAccounting:'initialized_boundaries_v1'});
  if(!this.allowed(f,range)||!m.ticks.includes(range.tickLower)||!m.ticks.includes(range.tickUpper)){this.block('entry_range_or_boundary_ineligible');return;}
  const target=this.gross(m)*800000n/1000000n;
  const sized=sizeLiquidityForQuoteBudget({budgetQuote:target,token0:'USDG',token1:'NVDA',quoteToken:'USDG',sqrtPriceX96:m.price,...range});
  if(sized.liquidity===0n||sized.liquidity*1000000n>m.liquidity*10000n){this.block('liquidity_share_admission');return;}
  const b=this.balances(m);let token:0|1|null=null,amount=0n;
  // Retain existing tokens; purchase only the shortfall needed by the new range.
  if(b.amount1<sized.amount1){token=0;const want=sized.amount1-b.amount1;let lo=0n,hi=b.amount0-this.cost('buy')-this.cost('mint')-(this.s.position?this.cost('remove'):0n);if(hi<=0n){this.block('quote_funding');return;}
   if(historicalSwapQuote(m,hi,0).amountOut<want){this.block('quote_funding');return;}
   while(lo<hi){const mid=(lo+hi)/2n;if(historicalSwapQuote(m,mid,0).amountOut>=want)hi=mid;else lo=mid+1n;}amount=lo;
  }else if(b.amount0<sized.amount0+this.cost('mint')+this.gross(m)/5n){token=1;const want=sized.amount0+this.cost('mint')+this.gross(m)/5n-b.amount0;let lo=0n,hi=b.amount1-sized.amount1;if(hi<=0n||historicalSwapQuote(m,hi,1).amountOut<want){this.block('quote_funding');return;}
   while(lo<hi){const mid=(lo+hi)/2n;if(historicalSwapQuote(m,mid,1).amountOut>=want)hi=mid;else lo=mid+1n;}amount=lo;
  }
  const q=token===null?null:historicalSwapQuote(m,amount,token);if(q&&(!q.fullyFilled||!q.passesSlippage)){this.block('quote_slippage');return;}
  this.s.pending={kind,after:Date.parse(f.observedAt),range,token,amount,minimum:q?q.amountOut*9950n/10000n:0n,reason,target};this.record(f,'signal_'+kind,reason);
 }
 private place(f:ExperimentFrame,m:SwapSource,pending:Pending){
  const before=this.s.costs,infra=pending.kind==='entry'&&this.s.lastExitReason==='infrastructure';
  try{
  const r=pending.range!;if(m.tick<r.tickLower||m.tick>=r.tickUpper||!this.allowed(f,r)||!m.ticks.includes(r.tickLower)||!m.ticks.includes(r.tickUpper)){this.block('frozen_range_expired');return;}
  if(pending.kind==='recenter'&&!this.remove(f,m,'routine_recenter'))return;
  const after=pending.token===null?m:this.swap(f,m,pending.token,pending.amount,pending.minimum,pending.reason);if(!after)return;
  // Record the original acquired-inventory passive comparator once, as paper does.
  if(this.s.hold0===null){this.s.hold0=this.s.cash;this.s.hold1=this.s.rwa;this.s.holdCosts=this.s.costs;}
  if(this.s.cash<this.cost('mint')){this.block('mint_funding');return;}
  const maximum=pending.target,reserve=(this.gross(after)+4n)/5n;
  let lo=0n,hi=(1n<<128n)-1n;const feasible=(l:bigint)=>{const a=positionAmounts(after.price,r,l,true);return a.amount0+this.cost('mint')+reserve<=this.s.cash&&a.amount1<=this.s.rwa&&a.amount0+nvdaValueQuote(a.amount1,priceX18(after.price))<=maximum;};
  while(lo<hi){const mid=(lo+hi+1n)/2n;if(feasible(mid))lo=mid;else hi=mid-1n;}
  if(lo===0n||lo*1000000n>after.liquidity*10000n){this.block('mint_liquidity_admission');return;}
  const a=positionAmounts(after.price,r,lo,true);if(a.amount0+nvdaValueQuote(a.amount1,priceX18(after.price))<1000000n){this.block('mint_too_small');return;}
  assert(this.charge('mint'));this.s.cash-=a.amount0;this.s.rwa-=a.amount1;this.s.position={...r,liquidity:lo,fee0:0n,fee1:0n,enteredAt:Date.parse(f.sourceAt),center:after.price};this.s.lastMove=Date.parse(f.observedAt);
  if(pending.kind==='recenter')this.s.recenters++;else this.s.entries++;this.record(f,'mint',pending.reason);
  }finally{if(infra)this.s.infrastructureReentryCosts+=this.s.costs-before;if(pending.kind==='entry'&&this.s.position)this.s.lastExitReason=null;}
 }
 private exit(f:ExperimentFrame,m:SwapSource,reason:string){
  const before=this.s.costs;try{
  if(!this.remove(f,m,reason))return false;
  if(this.s.rwa>0n&&!this.swap(f,m,1,this.s.rwa,0n,reason))return false;
  if(!this.charge('revoke'))return false;
  this.s.lastExit=Date.parse(f.observedAt);this.s.lastExitReason=reason;this.s.exits++;if(reason==='infrastructure')this.s.infrastructureExits++;
  this.s.pending=null;this.record(f,'cash_exit',reason);return true;
  }finally{if(reason==='infrastructure')this.s.infrastructureExitCosts+=this.s.costs-before;}
 }
 expireEntryIntents(f:ExperimentFrame){
  if(this.s.pending&&this.s.pending.kind!=='exit'){
   this.record(f,'cancel_pending','data_pause_requires_new_quote');this.s.pending=null;this.block('data_pause_quote_expired');
  }
  if(!this.s.benchmark.filled)this.s.benchmark.after=null;
 }
 /** Reconstruct ownership and fees across a bounded blackout, never missed orders. */
 observeWithoutDecision(f:ExperimentFrame,m:SwapSource){
  const s=this.s,at=Date.parse(f.observedAt);
  assert(f.dataValid&&(s.lastTarget===null||s.lastTarget===f.targetSetHash));
  assert(s.lastBlock===null||BigInt(f.block)>BigInt(s.lastBlock));
  const gap=s.lastAt===null?0:at-s.lastAt;assert(gap>=0&&gap<=900000);
  if(s.position){if(m.tick>=s.position.tickLower&&m.tick<s.position.tickUpper)s.activeSeconds+=gap/1000;else s.outsideSeconds+=gap/1000;}else s.cashSeconds+=gap/1000;
  s.lastAt=at;s.lastBlock=f.block;s.lastTarget=f.targetSetHash;s.observations++;
  this.block('missed_forward_decision');this.expireEntryIntents(f);
  const nav=this.gross(m)-this.reserve();if(nav>s.peak)s.peak=nav;
  const dd=s.peak?(s.peak-nav)*1000000n/s.peak:0n;if(dd>s.drawdown)s.drawdown=dd;
 }
 decision(f:ExperimentFrame,m:SwapSource){
  const at=Date.parse(f.observedAt),source=Date.parse(f.sourceAt),s=this.s;if(s.invalid)return;
  if(!f.dataValid||(s.lastTarget!==null&&s.lastTarget!==f.targetSetHash)||(s.lastBlock!==null&&BigInt(f.block)<=BigInt(s.lastBlock))) {s.invalid='canonical_source_or_order_invalid';return;}
  if(f.reasons.includes('source_ahead_of_confirmed_quorum')){this.block('awaiting_confirmation');return;}
  const gap=s.lastAt===null?0:at-s.lastAt;
  if(s.position&&(gap>900000||at-source>180000||at<source)){s.invalid='source_gap_or_stale';return;}
  if(s.position){if(m.tick>=s.position.tickLower&&m.tick<s.position.tickUpper)s.activeSeconds+=gap/1000;else s.outsideSeconds+=gap/1000;}else s.cashSeconds+=gap/1000;
  s.lastAt=at;s.lastBlock=f.block;s.lastTarget=f.targetSetHash;s.observations++;
  const benchmark=s.benchmark;
  if(!benchmark.filled&&this.allowed(f)&&at-source<=180000){
   const amount=BigInt(this.candidate.budget)*40n/100n,q=historicalSwapQuote(m,amount,0);
   if(benchmark.after===null){if(q.fullyFilled&&q.passesSlippage){benchmark.after=at;benchmark.minimum=q.amountOut*9950n/10000n;}}
   else if(source>benchmark.after){
    if(at-benchmark.after<=900000&&q.fullyFilled&&q.passesSlippage&&q.amountOut>=benchmark.minimum){benchmark.cash-=amount+this.cost('buy');benchmark.rwa=q.amountOut;benchmark.filled=true;}
    else benchmark.after=null;
   }
  }
  const b=this.balances(m),ref=f.referencePrice?BigInt(f.referencePrice):null;
  const referenceNav=ref?b.amount0+nvdaValueQuote(b.amount1,ref)-this.reserve():null;
  const exposure=ref&&referenceNav!==null?referenceNav>0n?nvdaValueQuote(b.amount1,ref)*1000000n/referenceNav:1000000n:null;
  if(exposure!==null&&exposure>s.maxExposure)s.maxExposure=exposure;
  const eligible=this.allowed(f,s.position??undefined);if(eligible)s.eligible++;
  const reason=!f.chainHealthy?'infrastructure':!eligible?'reference_or_token':exposure!==null&&exposure>=600000n?'inventory':s.position&&source-s.position.enteredAt>=86400000?'holding_limit':null;
  if((s.position||s.rwa>0n)&&reason&&s.pending?.kind!=='exit'){s.pending={kind:'exit',after:at,range:null,token:null,amount:0n,minimum:0n,reason,target:0n};this.record(f,'signal_exit',reason);}
  if(s.pending&&source>s.pending.after){const pending=s.pending;
   if(pending.kind==='exit'){if(f.chainHealthy)this.exit(f,m,pending.reason);}
   else{s.pending=null;if(at-pending.after<=900000&&eligible)this.place(f,m,pending);else this.block('pending_entry_expired_or_ineligible');}
  }else if(!s.pending){
   if(!s.position){if(at-s.lastExit>=600000&&eligible&&at-source<=180000)this.quote(f,m,'entry','entry_or_reentry');else this.block(at-s.lastExit<600000?'cooldown':'entry_gate');}
   else if(this.candidate.management==='recenter'&&eligible){
    const p=s.position,center=priceX18(p.center),now=priceX18(m.price),lower=priceX18(sqrtRatioAtTick(p.tickUpper)),upper=priceX18(sqrtRatioAtTick(p.tickLower));
    const distance=now<center?center-now:now-center,width=now<center?center-lower:upper-center;
    s.persistence=distance>0n&&distance*100n>=width*70n?s.persistence+1:0;
    if(s.persistence>=2&&at-s.lastMove>=600000){this.quote(f,m,'recenter','persistent_70_percent');s.persistence=0;}
   }
  }
  if(s.position&&s.pending?.kind!=='exit'&&ref){
   const post=this.balances(m),total=post.amount0+nvdaValueQuote(post.amount1,ref)-this.reserve(),postExposure=total>0n?nvdaValueQuote(post.amount1,ref)*1000000n/total:1000000n;
   if(postExposure>s.maxExposure)s.maxExposure=postExposure;
   if(postExposure>=600000n){s.pending={kind:'exit',after:at,range:null,token:null,amount:0n,minimum:0n,reason:'inventory',target:0n};this.record(f,'signal_exit','inventory');}
  }
  const nav=this.gross(m)-this.reserve();if(nav>s.peak)s.peak=nav;const dd=s.peak?(s.peak-nav)*1000000n/s.peak:0n;if(dd>s.drawdown)s.drawdown=dd;
 }
 summary(f:ExperimentFrame,m:SwapSource){const s=this.s,ref=f.referencePrice?BigInt(f.referencePrice):null,nav=s.invalid?null:this.gross(m)-this.reserve();
  const hold=s.hold0===null?BigInt(this.candidate.budget):s.hold0+nvdaValueQuote(s.hold1!,priceX18(m.price));
  const commonHold=s.benchmark.filled?s.benchmark.cash+nvdaValueQuote(s.benchmark.rwa,priceX18(m.price)):null;
  const refNav=s.invalid||!ref?null:this.gross(m,ref)-this.reserve(),refHold=!ref?null:s.hold0===null?BigInt(this.candidate.budget):s.hold0+nvdaValueQuote(s.hold1!,ref);
  return {candidate:this.candidate,evidenceClass:'modeled_path_with_frozen_fork_cost_scenarios',executionEligible:false,invalid:s.invalid,
   nav:nav===null?null:String(nav),pnl:nav===null?null:String(nav-BigInt(this.candidate.budget)),alpha:nav===null?null:String(nav-hold),
   alphaPpm:nav===null?null:String((nav-hold)*1000000n/BigInt(this.candidate.budget)),commonHold:commonHold===null?null:String(commonHold),commonAlpha:nav===null||commonHold===null?null:String(nav-commonHold),commonAlphaPpm:nav===null||commonHold===null?null:String((nav-commonHold)*1000000n/BigInt(this.candidate.budget)),referenceNav:refNav===null?null:String(refNav),referenceAlpha:refNav===null||refHold===null?null:String(refNav-refHold),
   costs:String(s.costs),exitReserve:String(this.reserve()),feesQuote:String(s.fees0+nvdaValueQuote(s.fees1,priceX18(m.price))),cash:String(s.cash),rwa:String(s.rwa),liquidity:String(s.position?.liquidity??0n),
   entries:s.entries,recenters:s.recenters,exits:s.exits,infrastructureExits:s.infrastructureExits,infrastructureExitCosts:String(s.infrastructureExitCosts),infrastructureReentryCosts:String(s.infrastructureReentryCosts),observations:s.observations,eligible:s.eligible,
   activeSeconds:s.activeSeconds,outsideSeconds:s.outsideSeconds,cashSeconds:s.cashSeconds,drawdownPpm:String(s.drawdown),maxExposurePpm:String(s.maxExposure),peakSharePpm:String(s.peakShare),blocked:s.blocked};
 }
}
