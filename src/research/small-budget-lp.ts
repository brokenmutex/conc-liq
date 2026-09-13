import assert from 'node:assert/strict';
import {AdaptiveLpReplay,type AdaptivePolicy,type ResearchLpCosts,type ResearchSource} from './adaptive-lp.js';
import {type ForecastStats,forecastPortfolio} from './adaptive-forecast.js';
import {type PaperMarket,marketTokens} from '../paper/market.js';
import {replayPaperMint} from './management-audit.js';
import {historicalSwapQuote} from './portfolio-math.js';
import {assertRecenterPrice} from '../paper/execution-recenter.js';

export interface TimingProfile {withdrawMs:number;swapMs:number;mintMs:number;stageGasQuote:number[];gasQuote:number}
export interface SmallBudgetOptions {gasBudget:bigint|null;profiles:{entry:TimingProfile;recenter:TimingProfile};requireForecastForFixed:boolean}
/** Research-only staged sensitivity. It reuses width forecasts, but explicitly
 * removes LP inventory before swap/mint latency. No signer or live controller. */
export class SmallBudgetLpReplay extends AdaptiveLpReplay {
 stage:'withdraw'|'swap'|'mint'|null=null;due=0;stageCosts:bigint[]=[];timing:TimingProfile|null=null;
 swappedPlan:Awaited<ReturnType<AdaptiveLpReplay['plan']>>|null=null;
 stopped=false;stopReason:string|null=null;closedAt:number|null=null;unavailableMarks=0;invalidAt:number|null=null;
 constructor(market:PaperMarket,costs:ResearchLpCosts,policy:AdaptivePolicy,readonly options:SmallBudgetOptions){super(market,costs,policy);}
 override mark(m:ResearchSource){
  if(m.liquidity===0n){this.unavailableMarks++;return this.peak;}
  const value=super.mark(m);if(this.invalid&&this.invalidAt===null)this.invalidAt=m.at;return value;
 }
 record(m:ResearchSource,kind:string,before:{amount0:bigint;amount1:bigint},gas:bigint,extra:Record<string,unknown>={}){
  const after=this.balances(m),str=(b:{amount0:bigint;amount1:bigint})=>({amount0:String(b.amount0),amount1:String(b.amount1)});
  this.actions.push({at:m.at,block:m.block,kind,before:str(before),after:str(after),gasQuote:String(gas),...extra});
 }
 closeForBudget(m:ResearchSource){
  this.pending=null;this.stage=null;this.stopReason='gas_budget';
  const b=this.balances(m),q0=marketTokens(this.market).quoteIsToken0,risky=q0?b.amount1:b.amount0;
  try{
   const q=risky?historicalSwapQuote(m,risky,q0?1:0,this.policy.slippageBps):null;
   assert(!q||(q.fullyFilled&&q.passesSlippage),'budget_exit_unavailable');
   const cost=this.position||risky?this.cost('exit'):0n;
   assert(this.options.gasBudget===null||this.gas+cost<=this.options.gasBudget,'exit_reserve_missing');
   const cash=(q0?b.amount0:b.amount1)+(q?.amountOut??0n);
   this.position=null;this.cash0=q0?cash:0n;this.cash1=q0?0n:cash;this.gas+=cost;this.stopped=true;this.closedAt=m.at;
   this.record(m,'budget_exit',b,cost,{amountIn:String(risky),amountOut:String(q?.amountOut??0n),token:q0?1:0});
  }catch{this.reject('budget_exit_unavailable');}
 }
 override async step(m:ResearchSource,stats:ForecastStats|null){
  if(m.liquidity===0n){this.unavailableMarks++;return;}
  if(this.stopped){this.mark(m);return;}
  if(this.stopReason){this.closeForBudget(m);this.mark(m);return;}
  if(this.options.requireForecastForFixed&&!stats&&!this.pending){this.mark(m);this.reject('forecast_unavailable');return;}
  await super.step(m,stats);
  if(this.pending&&!this.stage){
   const kind=this.pending.kind,cost=this.cost(kind);
   if(this.options.gasBudget!==null&&this.gas+cost+this.cost('exit')>this.options.gasBudget){this.closeForBudget(m);return;}
   this.timing=this.options.profiles[kind];const p=this.timing;
   // Entry has no withdrawal; any initial approvals belong to its swap stage.
   const weights=kind==='entry'?[0,p.stageGasQuote[0]!+p.stageGasQuote[1]!,p.stageGasQuote[2]!]:p.stageGasQuote;
   this.stageCosts=[cost*BigInt(weights[0]!)/BigInt(p.gasQuote),cost*BigInt(weights[1]!)/BigInt(p.gasQuote),0n];
   this.stageCosts[2]=cost-this.stageCosts[0]!-this.stageCosts[1]!;
   this.stage=kind==='entry'?'swap':'withdraw';this.due=m.at+(kind==='entry'?p.swapMs:p.withdrawMs);
  }
 }
 abandon(m:ResearchSource,reason:string){this.reject(reason);this.pending=null;this.stage=null;this.swappedPlan=null;this.cooldownUntil=m.at+600000;}
 override async fill(m:ResearchSource,stats:ForecastStats|null){
  const pending=this.pending;if(!pending||!this.stage||m.at<this.due||BigInt(m.block)<=BigInt(pending.block))return;
  const before=this.balances(m),p=this.timing!;
  if(this.stage==='withdraw'){
   try{
    assert(m.at-pending.at<=this.policy.quoteTtlMs,'withdraw_quote_expired');
    assert(m.tick>=pending.plan.tickLower&&m.tick<pending.plan.tickUpper,'range_left_before_withdraw');
    assertRecenterPrice(m.price,pending.reference,this.policy.slippageBps);
    const plan=await this.plan(m,pending.plan);
    if(this.policy.economicGate){
     assert(stats,'withdraw_forecast_unavailable');
     const keep=forecastPortfolio(this.market,m,this.portfolio(),stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm);
     const move=forecastPortfolio(this.market,m,{amount0:plan.mint.idle0,amount1:plan.mint.idle1,position:{...plan,liquidity:plan.mint.liquidity}},stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm);
     assert(keep&&move,'withdraw_forecast_unavailable');
     const a=this.cost('recenter')*BigInt(this.policy.costBufferPpm)/1000000n,b=move.feesQuote*BigInt(this.policy.feeBufferPpm)/1000000n;
     assert(move.terminalQuote-this.cost('recenter')-keep.terminalQuote>(a>b?a:b),'withdraw_economic_gate');
    }
   }catch(e){this.abandon(m,e instanceof Error?e.message:'withdraw_rejected');return;}
   this.cash0=before.amount0;this.cash1=before.amount1;this.position=null;this.recenterAttempts++;
   this.gas+=this.stageCosts[0]!;this.record(m,'withdraw',before,this.stageCosts[0]!);
   this.stage='swap';this.due=m.at+Math.max(0,p.swapMs-p.withdrawMs);return;
  }
  if(this.stage==='swap'){
   // Full stage gas is charged on attempts, including failed preflight. This is
   // an explicit adverse-cost assumption, not a count of real broadcasts.
   this.gas+=this.stageCosts[1]!;
   try{
    assert(m.tick>=pending.plan.tickLower&&m.tick<pending.plan.tickUpper,'range_left_before_swap');
    const plan=await this.plan(m,pending.plan);this.swappedPlan=plan;
    this.cash0=before.amount0+(plan.token===0?-plan.amount:plan.token===1?plan.amountOut:0n);
    this.cash1=before.amount1+(plan.token===1?-plan.amount:plan.token===0?plan.amountOut:0n);
    this.record(m,'swap',before,this.stageCosts[1]!,{token:plan.token,amountIn:String(plan.amount),amountOut:String(plan.amountOut),tickLower:plan.tickLower,tickUpper:plan.tickUpper});
    this.stage='mint';this.due=m.at+Math.max(0,p.mintMs-p.swapMs);
   }catch(e){this.record(m,'swap_aborted',before,this.stageCosts[1]!);this.abandon(m,e instanceof Error?e.message:'swap_rejected');}
   return;
  }
  this.gas+=this.stageCosts[2]!;
  try{
   assert(m.tick>=pending.plan.tickLower&&m.tick<pending.plan.tickUpper,'range_left_before_mint');
   // Recovery/mint is re-quoted from held inventory at this stage; no second
   // balancing swap and no fictitious LP fees during the intervening delay.
   const mint=replayPaperMint(m.price,pending.plan,this.cash0,this.cash1,0n);assert(mint.liquidity>0n,'empty_mint');
   this.cash0=mint.idle0;this.cash1=mint.idle1;this.position={tickLower:pending.plan.tickLower,tickUpper:pending.plan.tickUpper,liquidity:mint.liquidity,fee0:0n,fee1:0n};
   if(pending.kind==='entry')this.entries++;else this.recenters++;
   this.record(m,'mint',before,this.stageCosts[2]!,{tickLower:pending.plan.tickLower,tickUpper:pending.plan.tickUpper,liquidity:String(mint.liquidity),amount0:String(mint.amount0),amount1:String(mint.amount1)});
   this.pending=null;this.stage=null;this.swappedPlan=null;
  }catch(e){this.failures++;this.record(m,'mint_aborted',before,this.stageCosts[2]!);this.abandon(m,e instanceof Error?e.message:'mint_rejected');}
 }
}
