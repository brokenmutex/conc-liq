import assert from 'node:assert/strict';
import {AdaptiveLpReplay,type AdaptivePolicy,type ResearchLpCosts,type ResearchSource} from './adaptive-lp.js';
import {forecastPortfolio,type ForecastStats} from './adaptive-forecast.js';
import {inventoryRanges,inventoryMintPlan,type InventoryRange} from './inventory-range.js';
import type {PaperMarket} from '../paper/market.js';
import type {SwapSource} from './swap.js';

export interface InventoryRangeOptions {
 spanSpacings:readonly number[];
 cooldownMs:number;
 confirmations:number;
 gasBudgetQuote:bigint;
}

/** Opt-in research/paper challenger. Initial entry uses the existing acquisition
 * path; subsequent range moves preserve both token totals, including idle cash.
 * Width/placement changes may be considered anywhere in the existing range.
 * A frozen candidate needs repeated evidence, a later fill, a second economic
 * gate and an exit-cost reserve. No signing or live controller integration.
 * Atomic fill remains a modeled assumption, not a staged execution proof. */
export class InventoryLpReplay extends AdaptiveLpReplay {
 lastInventoryMove:number|null=null;
 inventoryCandidate:{key:string;count:number;at:number}|null=null;
 constructor(market:PaperMarket,costs:ResearchLpCosts,policy:AdaptivePolicy,readonly inventory:InventoryRangeOptions){
  super(market,costs,policy);
  assert(policy.economicGate,'Inventory range policy requires the economic gate');
  assert(!policy.residualRange,'Inventory range challenger does not use atomic residual moves');
  assert(costs.residual!==undefined&&costs.residual>0n,'Explicit no-swap bundle cost required');
  assert(Number.isSafeInteger(inventory.cooldownMs)&&inventory.cooldownMs>=0);
  assert(Number.isSafeInteger(inventory.confirmations)&&inventory.confirmations>=1);
  assert(inventory.gasBudgetQuote>0n);
  inventoryRanges(0,market.tickSpacing,inventory.spanSpacings);
 }
 override cost(kind:keyof ResearchLpCosts){return super.cost(kind==='recenter'?'residual':kind);}
 override async plan(m:SwapSource,range:InventoryRange){
  if(!this.position)return super.plan(m,range);
  const b=this.balances(m);return inventoryMintPlan(m.price,range,b.amount0,b.amount1);
 }
 override async fill(m:ResearchSource,stats:ForecastStats|null){
  const pending=this.pending;if(!pending)return;
  if(BigInt(m.block)<=BigInt(pending.block)||m.at<=pending.at)return;
  // Reject without inventory/cost mutation. Recenter mint has a real lower
  // bound, even though its two token legs may change inside the frozen range.
  try{
   assert(this.gas+this.cost(pending.kind)+this.cost('exit')<=this.inventory.gasBudgetQuote,'inventory_exit_reserve');
   if(pending.kind==='recenter'){
    const plan=await this.plan(m,pending.plan);
    assert(plan.token===null,'inventory_swap_forbidden');
    assert(plan.mint.liquidity*10000n>=pending.plan.mint.liquidity*BigInt(10000-this.policy.slippageBps),'inventory_frozen_mint_minimum');
   }
  }catch(error){this.pending=null;this.inventoryCandidate=null;this.reject(error instanceof Error?error.message:'inventory_preflight');return;}
  const n=this.actions.length,early=!!this.position&&m.tick>=this.position.tickLower&&m.tick<this.position.tickUpper;
  await super.fill(m,stats);
  if(this.actions.length>n){const action=this.actions.at(-1)!;action.inventoryPreserving=action.kind!=='entry';action.early=early;this.lastInventoryMove=m.at;}
  this.inventoryCandidate=null;
 }
 override async step(m:ResearchSource,stats:ForecastStats|null){
  if(this.invalid)return;
  if(stats)assert(stats.asOf<=m.at,'Future forecast input');
  if(this.pending||!this.position){
   if(!this.pending&&this.gas+this.cost('entry')+this.cost('exit')>this.inventory.gasBudgetQuote){this.mark(m);this.reject('inventory_exit_reserve');return;}
   await super.step(m,stats);return;
  }
  this.mark(m);if(this.invalid)return;
  if(this.lastDecision!==null&&m.at-this.lastDecision<this.policy.decisionMs)return;
  this.lastDecision=m.at;
  if(this.lastInventoryMove!==null&&m.at-this.lastInventoryMove<this.inventory.cooldownMs)return;
  if(!stats){this.inventoryCandidate=null;this.reject('inventory_forecast_unavailable');return;}
  if(this.gas+this.cost('recenter')+this.cost('exit')>this.inventory.gasBudgetQuote){this.inventoryCandidate=null;this.reject('inventory_exit_reserve');return;}
  const cost=this.cost('recenter'),p=this.position;
  const keep=forecastPortfolio(this.market,m,this.portfolio(),stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,cost);
  if(!keep){this.inventoryCandidate=null;this.reject('inventory_keep_unavailable');return;}
  let best:null|{plan:Awaited<ReturnType<InventoryLpReplay['plan']>>;forecast:NonNullable<ReturnType<typeof forecastPortfolio>>}=null;
  for(const range of inventoryRanges(m.tick,this.market.tickSpacing,this.inventory.spanSpacings)){
   if(range.tickLower===p.tickLower&&range.tickUpper===p.tickUpper)continue;
   try{
    const plan=await this.plan(m,range);
    const forecast=forecastPortfolio(this.market,m,{amount0:plan.mint.idle0,amount1:plan.mint.idle1,position:{...range,liquidity:plan.mint.liquidity}},stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,cost);
    if(forecast&&(!best||forecast.terminalQuote>best.forecast.terminalQuote))best={plan,forecast};
   }catch{/* Reject only this infeasible inventory/range pairing. */}
  }
  if(!best){this.inventoryCandidate=null;this.reject('inventory_no_feasible_range');return;}
  const benefit=best.forecast.terminalQuote-cost-keep.terminalQuote;
  const costBuffer=cost*BigInt(this.policy.costBufferPpm)/1000000n,feeBuffer=best.forecast.feesQuote*BigInt(this.policy.feeBufferPpm)/1000000n;
  const buffer=costBuffer>feeBuffer?costBuffer:feeBuffer,key=`${best.plan.tickLower}:${best.plan.tickUpper}`;
  const prior=this.inventoryCandidate;
  if(benefit<=buffer){this.inventoryCandidate=null;this.reject('inventory_economic_gate');return;}
  this.inventoryCandidate={key,count:prior?.key===key&&m.at-prior.at<=90000?prior.count+1:1,at:m.at};
  if(this.inventoryCandidate.count<this.inventory.confirmations)return;
  const score={kind:'inventory_preserving',at:m.at,asOf:stats.asOf,benefitQuote:String(benefit),bufferQuote:String(buffer),moveFeesQuote:String(best.forecast.feesQuote),keepFeesQuote:String(keep.feesQuote),accepted:true,early:m.tick>=p.tickLower&&m.tick<p.tickUpper};
  this.scores.push(score);
  this.pending={plan:best.plan,at:m.at,block:m.block,reference:m.price,maxInput:0n,kind:'recenter',score};
 }
}
