import assert from 'node:assert/strict';
import {MIN_TICK,MAX_TICK} from '../backtest/principal.js';
import {marketValue,type PaperMarket} from '../paper/market.js';
import {forecastPortfolio,type ForecastPortfolio,type ForecastStats} from './adaptive-forecast.js';
import {AdaptiveLpReplay,type AdaptivePolicy,type ResearchLpCosts,type ResearchSource} from './adaptive-lp.js';
import {replayPaperMint} from './management-audit.js';
import {historicalSwapQuote} from './portfolio-math.js';
import type {SwapSource} from './swap.js';

const ONE_MILLION=1000000n;
type Token=0|1;
export type HybridStage='approval'|'withdraw_collect'|'swap'|'mint';

export interface HybridGrid {
  /** Whole range spans in pool tick spacings. */
  spanSpacings:readonly number[];
  /** Lower-bound displacement as a fraction of the whole span. */
  lowerOffsetPpm:readonly number[];
  deploymentPpm:readonly number[];
  /** Exact-input fractions of the selected input-token wallet balance. Zero is
   * represented separately and is always considered. */
  swapInputPpm:readonly number[];
  maxSwapInputPpm:number;
  minLiquidity:bigint;
}

export interface HybridStageCosts {
  approval:bigint;
  withdrawCollect:bigint;
  swap:bigint;
  mint:bigint;
  exit:bigint;
  adverseSelectionPpm:number;
  approvalRequired:boolean;
}

export interface HybridPlannerInput {
  market:PaperMarket;
  source:SwapSource;
  portfolio:ForecastPortfolio;
  balances:{amount0:bigint;amount1:bigint};
  stats:ForecastStats;
  horizonMs:number;
  feePpm:number;
  slippageBps:number;
  costBufferPpm:number;
  feeBufferPpm:number;
  grid:HybridGrid;
  costs:HybridStageCosts;
  gasSpent:bigint;
  gasBudgetQuote:bigint;
  fixed?:Pick<HybridPlan,'tickLower'|'tickUpper'|'deploymentPpm'|'token'|'amountIn'>;
}

export interface HybridPlan {
  id:string;
  tickLower:number;
  tickUpper:number;
  deploymentPpm:number;
  token:Token|null;
  amountIn:bigint;
  amountOut:bigint;
  minimumAmountOut:bigint;
  swapFeeInput:bigint;
  swapShortfallOutput:bigint;
  priceAfter:bigint;
  mint:ReturnType<typeof replayPaperMint>;
  idle0:bigint;
  idle1:bigint;
  actionCostQuote:bigint;
  adverseSelectionQuote:bigint;
  terminalQuote:bigint;
  forecastFeesQuote:bigint;
  benefitQuote:bigint;
  bufferQuote:bigint;
  accepted:boolean;
}

export interface HybridPlannerResult {
  keepTerminalQuote:bigint|null;
  selected:HybridPlan|null;
  evaluated:number;
  feasible:number;
  rejected:Record<string,number>;
}

function integerPpm(value:number,name:string){
  assert(Number.isSafeInteger(value)&&value>=0&&value<=1000000,`${name} outside ppm domain`);
}

function validateGrid(grid:HybridGrid){
  assert(grid.spanSpacings.length>0&&grid.spanSpacings.length<=16);
  assert(grid.spanSpacings.every(n=>Number.isSafeInteger(n)&&n>=1&&n<=64));
  assert(grid.lowerOffsetPpm.length>0&&grid.lowerOffsetPpm.length<=16);
  assert(grid.lowerOffsetPpm.every(n=>Number.isSafeInteger(n)&&n>=-1000000&&n<=1000000));
  assert(grid.deploymentPpm.length>0&&grid.deploymentPpm.length<=8);
  for(const n of grid.deploymentPpm)integerPpm(n,'deployment');
  assert(grid.deploymentPpm.every(n=>n>0));
  assert(grid.swapInputPpm.length<=16);
  for(const n of grid.swapInputPpm)integerPpm(n,'swap input');
  integerPpm(grid.maxSwapInputPpm,'maximum swap input');
  assert(grid.swapInputPpm.every(n=>n>0&&n<=grid.maxSwapInputPpm));
  assert(grid.minLiquidity>0n);
}

/** Deterministic, tick-aligned finite range grid. Offsets below -100% and above
 * +100% are deliberately excluded; the endpoints still include the closest
 * wholly one-sided residual bands on either side of spot. */
export function hybridRanges(tick:number,spacing:number,grid:HybridGrid){
  assert(Number.isSafeInteger(tick)&&Number.isSafeInteger(spacing)&&spacing>0);
  validateGrid(grid);
  const base=Math.floor(tick/spacing)*spacing,ranges=new Map<string,{tickLower:number;tickUpper:number}>();
  for(const span of grid.spanSpacings)for(const offset of grid.lowerOffsetPpm){
    const lowerCells=Math.floor(span*offset/1000000);
    const tickLower=base+lowerCells*spacing,tickUpper=tickLower+span*spacing;
    if(tickLower<MIN_TICK||tickUpper>MAX_TICK)continue;
    ranges.set(`${tickLower}:${tickUpper}`,{tickLower,tickUpper});
  }
  return [...ranges.values()];
}

const increment=(record:Record<string,number>,key:string)=>{record[key]=(record[key]??0)+1;};
export function passesHybridEconomicGate(benefitQuote:bigint,bufferQuote:bigint){
  assert(bufferQuote>=0n);return benefitQuote>bufferQuote;
}
const planId=(p:Pick<HybridPlan,'tickLower'|'tickUpper'|'deploymentPpm'|'token'|'amountIn'>)=>
  `${p.tickLower}:${p.tickUpper}:${p.deploymentPpm}:${p.token===null?'none':p.token}:${p.amountIn}`;

function scoreCandidate(input:HybridPlannerInput,spec:Pick<HybridPlan,'tickLower'|'tickUpper'|'deploymentPpm'|'token'|'amountIn'>,
 keepTerminalQuote:bigint):HybridPlan {
  const {source,balances,costs}=input;
  assert(spec.amountIn>=0n);
  if(spec.token===null)assert(spec.amountIn===0n);
  let amountOut=0n,minimumAmountOut=0n,swapFeeInput=0n,swapShortfallOutput=0n,priceAfter=source.price;
  let after0=balances.amount0,after1=balances.amount1,postSource=source;
  if(spec.token!==null){
    const available=spec.token===0?balances.amount0:balances.amount1;
    assert(spec.amountIn>0n&&spec.amountIn<=available*BigInt(input.grid.maxSwapInputPpm)/ONE_MILLION,'hybrid_swap_cap');
    const quote=historicalSwapQuote(source,spec.amountIn,spec.token,input.slippageBps);
    assert(quote.fullyFilled,'hybrid_swap_unfilled');assert(quote.passesSlippage,'hybrid_swap_slippage');
    amountOut=quote.amountOut;minimumAmountOut=quote.idealOutput*BigInt(10000-input.slippageBps)/10000n;
    swapFeeInput=quote.feeInput;swapShortfallOutput=quote.outputShortfall;priceAfter=quote.sqrtPriceAfter;
    if(spec.token===0){after0-=spec.amountIn;after1+=amountOut;}else{after1-=spec.amountIn;after0+=amountOut;}
    postSource={...source,price:quote.sqrtPriceAfter,tick:quote.tickAfter,liquidity:quote.liquidityAfter};
  }
  integerPpm(spec.deploymentPpm,'deployment');assert(spec.deploymentPpm>0);
  const deploy0=after0*BigInt(spec.deploymentPpm)/ONE_MILLION,deploy1=after1*BigInt(spec.deploymentPpm)/ONE_MILLION;
  const mint=replayPaperMint(priceAfter,spec,deploy0,deploy1,0n);
  assert(mint.liquidity>=input.grid.minLiquidity,'hybrid_liquidity_minimum');
  const idle0=after0-mint.amount0,idle1=after1-mint.amount1;
  const move=forecastPortfolio(input.market,postSource,{amount0:idle0,amount1:idle1,position:{...spec,liquidity:mint.liquidity}},
    input.stats,input.horizonMs,costs.exit,input.feePpm,costs.withdrawCollect+costs.mint);
  assert(move,'hybrid_move_forecast_unavailable');
  const gas=(input.portfolio.position?costs.withdrawCollect:0n)+costs.mint+
    (spec.token===null?0n:costs.swap+(costs.approvalRequired?costs.approval:0n));
  const inputValue=spec.token===null?0n:marketValue(input.market,source.price,spec.token===0?spec.amountIn:0n,spec.token===1?spec.amountIn:0n);
  const adverse=inputValue*BigInt(costs.adverseSelectionPpm)/ONE_MILLION;
  const actionCostQuote=gas+adverse;
  assert(input.gasSpent+actionCostQuote+costs.exit<=input.gasBudgetQuote,'hybrid_exit_reserve');
  const terminalQuote=move.terminalQuote-actionCostQuote,benefitQuote=terminalQuote-keepTerminalQuote;
  const costBuffer=actionCostQuote*BigInt(input.costBufferPpm)/ONE_MILLION;
  const feeBuffer=move.feesQuote*BigInt(input.feeBufferPpm)/ONE_MILLION;
  const bufferQuote=costBuffer>feeBuffer?costBuffer:feeBuffer;
  const result={...spec,id:'',amountOut,minimumAmountOut,swapFeeInput,swapShortfallOutput,priceAfter,mint,idle0,idle1,
    actionCostQuote,adverseSelectionQuote:adverse,terminalQuote,forecastFeesQuote:move.feesQuote,benefitQuote,bufferQuote,
    accepted:passesHybridEconomicGate(benefitQuote,bufferQuote)};
  return {...result,id:planId(result)};
}

/** Re-evaluate one frozen direction/input/range at a later canonical checkpoint. */
export function evaluateHybridPlan(input:HybridPlannerInput,spec:Pick<HybridPlan,'tickLower'|'tickUpper'|'deploymentPpm'|'token'|'amountIn'>){
  validatePlanner(input);
  const keep=forecastPortfolio(input.market,input.source,input.portfolio,input.stats,input.horizonMs,input.costs.exit,input.feePpm,
    input.costs.withdrawCollect+input.costs.mint);
  assert(keep,'hybrid_keep_forecast_unavailable');
  return scoreCandidate(input,spec,keep.terminalQuote);
}

function validatePlanner(input:HybridPlannerInput){
  validateGrid(input.grid);
  assert(input.balances.amount0>=0n&&input.balances.amount1>=0n);
  assert(Number.isSafeInteger(input.stats.asOf)&&Number.isSafeInteger(input.stats.spanMs)&&input.stats.spanMs>0);
  integerPpm(input.feePpm,'fee');integerPpm(input.costBufferPpm,'cost buffer');integerPpm(input.feeBufferPpm,'fee buffer');
  integerPpm(input.costs.adverseSelectionPpm,'adverse selection');
  for(const value of [input.costs.approval,input.costs.withdrawCollect,input.costs.swap,input.costs.mint,input.costs.exit])assert(value>=0n);
  assert(input.gasSpent>=0n&&input.gasBudgetQuote>0n);
}

/** Compare complete keep and move portfolios. Swap fee and historical price
 * impact are already embedded in amountOut; the explicit action cost contains
 * stage gas, any needed approval, and the separately declared adverse-selection
 * allowance. The finite grid makes no global-optimum claim. */
export function planHybridAction(input:HybridPlannerInput):HybridPlannerResult {
  validatePlanner(input);
  const rejected:Record<string,number>={},keep=forecastPortfolio(input.market,input.source,input.portfolio,input.stats,input.horizonMs,
    input.costs.exit,input.feePpm,input.costs.withdrawCollect+input.costs.mint);
  if(!keep)return {keepTerminalQuote:null,selected:null,evaluated:0,feasible:0,rejected:{hybrid_keep_forecast_unavailable:1}};
  const specs:Pick<HybridPlan,'tickLower'|'tickUpper'|'deploymentPpm'|'token'|'amountIn'>[]=[];
  if(input.fixed)specs.push(input.fixed);
  else for(const range of hybridRanges(input.source.tick,input.source.spacing,input.grid))for(const deploymentPpm of input.grid.deploymentPpm){
    specs.push({...range,deploymentPpm,token:null,amountIn:0n});
    for(const token of [0,1] as const){const available=token===0?input.balances.amount0:input.balances.amount1;
      for(const ppm of input.grid.swapInputPpm){const amountIn=available*BigInt(ppm)/ONE_MILLION;if(amountIn>0n)specs.push({...range,deploymentPpm,token,amountIn});}
    }
  }
  let selected:HybridPlan|null=null,feasible=0;
  for(const spec of specs)try{
    const candidate=scoreCandidate(input,spec,keep.terminalQuote);feasible++;
    if(!selected||candidate.terminalQuote>selected.terminalQuote||
      candidate.terminalQuote===selected.terminalQuote&&candidate.amountIn<selected.amountIn||
      candidate.terminalQuote===selected.terminalQuote&&candidate.amountIn===selected.amountIn&&candidate.id<selected.id)selected=candidate;
  }catch(error){increment(rejected,error instanceof Error?error.message:'hybrid_candidate_unavailable');}
  if(!selected)increment(rejected,'hybrid_no_feasible_action');
  else if(!selected.accepted)increment(rejected,'hybrid_economic_gate');
  return {keepTerminalQuote:keep.terminalQuote,selected,evaluated:specs.length,feasible,rejected};
}

export interface HybridStageJournal {
  stage:HybridStage|null;
  completedReceiptIds:string[];
  gasChargedQuote:bigint;
  positionActive:boolean;
  wallet:{amount0:bigint;amount1:bigint};
  failedReason:string|null;
}
export interface HybridStageEvent {
  stage:HybridStage;receiptId:string;canonical:boolean;submitted:boolean;success:boolean;gasQuote:bigint;
  nextStage:HybridStage|null;walletAfter?:{amount0:bigint;amount1:bigint};positionActiveAfter?:boolean;failureReason?:string;
}

/** Receipt-reconciled transition used by the replay and snapshot tests. A
 * duplicate receipt is idempotent. A submitted revert pays gas and retains the
 * current stage and inventory; completed stages are never replayed. */
export function applyHybridStage(journal:HybridStageJournal,event:HybridStageEvent){
  assert(event.receiptId.length>0&&event.gasQuote>=0n);
  if(journal.completedReceiptIds.includes(event.receiptId))return false;
  assert(event.canonical,'hybrid_stage_noncanonical');
  assert(journal.stage===event.stage,'hybrid_stage_out_of_order');
  if(event.submitted)journal.gasChargedQuote+=event.gasQuote;
  if(!event.success){journal.failedReason=event.failureReason??`hybrid_${event.stage}_reverted`;return true;}
  assert(event.submitted,'hybrid_stage_success_without_submission');
  journal.completedReceiptIds.push(event.receiptId);
  if(event.walletAfter)journal.wallet={...event.walletAfter};
  if(event.positionActiveAfter!==undefined)journal.positionActive=event.positionActiveAfter;
  journal.failedReason=null;journal.stage=event.nextStage;
  return true;
}

export interface HybridReplayOptions {
  grid:HybridGrid;
  costs:HybridStageCosts;
  gasBudgetQuote:bigint;
  cooldownMs:number;
  confirmations:number;
  stageTtlMs:number;
  stageDelayMs:Readonly<Record<HybridStage,number>>;
}

interface PendingHybrid {
  plan:HybridPlan;kind:'entry'|'recenter';quotedAt:number;quotedBlock:string;stage:HybridStage;stageStartedAt:number;
  completedReceiptIds:string[];afterSwap:{amount0:string;amount1:string}|null;
  actualSwap:{amountOut:string;feeInput:string;shortfallOutput:string}|null;before:{amount0:string;amount1:string};
}
const record=(b:{amount0:bigint;amount1:bigint})=>({amount0:String(b.amount0),amount1:String(b.amount1)});

/** Opt-in staged research/paper model. It owns no signer and never broadcasts.
 * Each stage needs a later canonical observation. Reverts retain completed
 * custody changes so recovery resumes at the missing stage. */
export class HybridLpReplay extends AdaptiveLpReplay {
  hybridPending:PendingHybrid|null=null;
  hybridCandidate:{key:string;count:number;at:number}|null=null;
  lastHybridMove:number|null=null;
  nextHybridEvaluationAt=0;
  hybridAdverseSelectionQuote=0n;
  hybridDecisions:Record<string,unknown>[]=[];
  hybridStages:Record<string,unknown>[]=[];
  constructor(market:PaperMarket,costs:ResearchLpCosts,policy:AdaptivePolicy,readonly hybrid:HybridReplayOptions){
    super(market,costs,policy);validateGrid(hybrid.grid);
    assert(policy.economicGate,'Hybrid policy requires the economic gate');assert(!policy.residualRange,'Hybrid owns residual choices');
    assert(hybrid.gasBudgetQuote>0n&&Number.isSafeInteger(hybrid.cooldownMs)&&hybrid.cooldownMs>=0);
    assert(Number.isSafeInteger(hybrid.confirmations)&&hybrid.confirmations>=1&&hybrid.confirmations<=10);
    assert(Number.isSafeInteger(hybrid.stageTtlMs)&&hybrid.stageTtlMs>=policy.decisionMs);
    for(const stage of ['approval','withdraw_collect','swap','mint'] as const)assert(Number.isSafeInteger(hybrid.stageDelayMs[stage])&&hybrid.stageDelayMs[stage]>=0);
  }
  override cost(kind:keyof ResearchLpCosts){
    if(kind==='exit')return this.hybrid.costs.exit*BigInt(this.policy.gasMultiplier);
    return super.cost(kind);
  }
  private planner(m:ResearchSource,stats:ForecastStats,fixed?:HybridPlannerInput['fixed']){
    const c=this.hybrid.costs,multiplier=BigInt(this.policy.gasMultiplier);
    return {market:this.market,source:m,portfolio:this.portfolio(),balances:this.balances(m),stats,horizonMs:this.policy.horizonMs,
      feePpm:this.policy.feePpm,slippageBps:this.policy.slippageBps,costBufferPpm:this.policy.costBufferPpm,feeBufferPpm:this.policy.feeBufferPpm,
      grid:this.hybrid.grid,costs:{...c,approval:c.approval*multiplier,withdrawCollect:c.withdrawCollect*multiplier,swap:c.swap*multiplier,
        mint:c.mint*multiplier,exit:c.exit*multiplier},gasSpent:this.gas,gasBudgetQuote:this.hybrid.gasBudgetQuote,fixed};
  }
  private stages(plan:HybridPlan,kind:'entry'|'recenter'){
    const result:HybridStage[]=[];
    if(kind==='recenter')result.push('withdraw_collect');
    if(plan.token!==null&&this.hybrid.costs.approvalRequired)result.push('approval');
    if(plan.token!==null)result.push('swap');
    result.push('mint');return result;
  }
  private nextStage(p:PendingHybrid){const all=this.stages(p.plan,p.kind),i=all.indexOf(p.stage);return all[i+1]??null;}
  private stageCost(stage:HybridStage,p:PendingHybrid){const c=this.hybrid.costs,m=BigInt(this.policy.gasMultiplier);
    const base=stage==='approval'?c.approval:stage==='withdraw_collect'?c.withdrawCollect:stage==='swap'?c.swap:c.mint;
    return base*m+(stage==='swap'?p.plan.adverseSelectionQuote:0n);
  }
  cancelPending(reason='hybrid_cancelled'){
    if(!this.hybridPending)return false;this.hybridStages.push({at:this.hybridPending.stageStartedAt,stage:this.hybridPending.stage,status:'cancelled',reason});
    this.hybridPending=null;this.hybridCandidate=null;this.reject(reason);return true;
  }
  async advanceHybrid(m:ResearchSource,stats:ForecastStats|null,receiptId=`${m.block}:${this.hybridPending?.stage??'none'}`,forceRevert=false){
    const p=this.hybridPending;if(!p)return;
    if((m as ResearchSource&{canonical?:boolean;coverageComplete?:boolean}).canonical===false||
      (m as ResearchSource&{canonical?:boolean;coverageComplete?:boolean}).coverageComplete===false){this.reject('hybrid_stage_source_unavailable');return;}
    if(p.completedReceiptIds.includes(receiptId))return;
    if(m.at-p.stageStartedAt<this.hybrid.stageDelayMs[p.stage])return;
    if(m.at-p.stageStartedAt>this.hybrid.stageTtlMs){this.cancelPending('hybrid_stage_expired');return;}
    if(p.stage===this.stages(p.plan,p.kind)[0]){
      if(!stats){this.cancelPending('hybrid_fill_forecast_unavailable');return;}
      try{const checked=evaluateHybridPlan(this.planner(m,stats),{tickLower:p.plan.tickLower,tickUpper:p.plan.tickUpper,
        deploymentPpm:p.plan.deploymentPpm,token:p.plan.token,amountIn:p.plan.amountIn});assert(checked.accepted,'hybrid_fill_economic_gate');}
      catch(error){this.cancelPending(error instanceof Error?error.message:'hybrid_fill_unavailable');return;}
    }
    const cost=this.stageCost(p.stage,p);assert(this.gas+cost+this.cost('exit')<=this.hybrid.gasBudgetQuote,'hybrid_exit_reserve');
    const adverse=p.stage==='swap'?p.plan.adverseSelectionQuote:0n;
    const charged=forceRevert?cost-adverse:cost;this.gas+=charged;
    if(p.stage==='swap'&&!forceRevert)this.hybridAdverseSelectionQuote+=adverse;
    if(forceRevert){this.hybridStages.push({at:m.at,block:m.block,stage:p.stage,receiptId,status:'reverted',gasQuote:String(charged),
      adverseSelectionQuote:String(adverse)});this.reject(`hybrid_${p.stage}_reverted`);p.stageStartedAt=m.at;return;}
    if(p.stage==='withdraw_collect'){
      const b=this.balances(m);this.cash0=b.amount0;this.cash1=b.amount1;this.position=null;
    }else if(p.stage==='swap'){
      const available=p.plan.token===0?this.cash0:this.cash1;assert(p.plan.token!==null&&p.plan.amountIn<=available,'hybrid_frozen_input_budget');
      const q=historicalSwapQuote(m,p.plan.amountIn,p.plan.token,this.policy.slippageBps);assert(q.fullyFilled&&q.passesSlippage,'hybrid_swap_fill_unavailable');
      assert(q.amountOut>=p.plan.minimumAmountOut,'hybrid_frozen_swap_minimum');
      if(p.plan.token===0){this.cash0-=p.plan.amountIn;this.cash1+=q.amountOut;}else{this.cash1-=p.plan.amountIn;this.cash0+=q.amountOut;}
      p.afterSwap=record({amount0:this.cash0,amount1:this.cash1});
      p.actualSwap={amountOut:String(q.amountOut),feeInput:String(q.feeInput),shortfallOutput:String(q.outputShortfall)};
    }else if(p.stage==='mint'){
      const deploy0=this.cash0*BigInt(p.plan.deploymentPpm)/ONE_MILLION,deploy1=this.cash1*BigInt(p.plan.deploymentPpm)/ONE_MILLION;
      const mint=replayPaperMint(m.price,p.plan,deploy0,deploy1,0n);
      assert(mint.liquidity*10000n>=p.plan.mint.liquidity*BigInt(10000-this.policy.slippageBps),'hybrid_frozen_mint_minimum');
      this.cash0-=mint.amount0;this.cash1-=mint.amount1;
      this.position={tickLower:p.plan.tickLower,tickUpper:p.plan.tickUpper,liquidity:mint.liquidity,fee0:0n,fee1:0n};
      if(p.kind==='entry')this.entries++;else this.recenters++;
      this.lastHybridMove=m.at;
      this.actions.push({at:m.at,block:m.block,quoteAt:p.quotedAt,quoteBlock:p.quotedBlock,kind:p.kind,staged:true,before:p.before,
        afterSwap:p.afterSwap??p.before,idle:record({amount0:this.cash0,amount1:this.cash1}),token:p.plan.token,
        amountIn:String(p.plan.amountIn),amountOut:p.actualSwap?.amountOut??String(p.plan.amountOut),
        swapFeeInput:p.actualSwap?.feeInput??String(p.plan.swapFeeInput),swapShortfallOutput:p.actualSwap?.shortfallOutput??String(p.plan.swapShortfallOutput),
        gasQuote:String(p.plan.actionCostQuote-p.plan.adverseSelectionQuote),adverseSelectionQuote:String(p.plan.adverseSelectionQuote),
        actionCostQuote:String(p.plan.actionCostQuote),tickLower:p.plan.tickLower,
        tickUpper:p.plan.tickUpper,liquidity:String(mint.liquidity),minted0:String(mint.amount0),minted1:String(mint.amount1)});
    }
    p.completedReceiptIds.push(receiptId);this.hybridStages.push({at:m.at,block:m.block,stage:p.stage,receiptId,status:'completed',gasQuote:String(charged-adverse),
      adverseSelectionQuote:String(adverse)});
    const next=this.nextStage(p);if(next){p.stage=next;p.stageStartedAt=m.at;}else{this.hybridPending=null;this.hybridCandidate=null;}
  }
  override async step(m:ResearchSource,stats:ForecastStats|null){
    if(this.invalid)return;if(stats)assert(stats.asOf<=m.at,'Future forecast input');this.mark(m);if(this.invalid)return;
    if(this.hybridPending){await this.advanceHybrid(m,stats);this.mark(m);return;}
    if(this.lastDecision!==null&&m.at-this.lastDecision<this.policy.decisionMs)return;this.lastDecision=m.at;
    if(m.at<this.nextHybridEvaluationAt)return;
    if(this.lastHybridMove!==null&&m.at-this.lastHybridMove<this.hybrid.cooldownMs)return;
    if(!stats){this.hybridCandidate=null;this.reject('hybrid_forecast_unavailable');return;}
    const result=planHybridAction(this.planner(m,stats));for(const [reason,count] of Object.entries(result.rejected))this.rejected[reason]=(this.rejected[reason]??0)+count;
    const selected=result.selected;this.hybridDecisions.push({at:m.at,block:m.block,asOf:stats.asOf,keepTerminalQuote:result.keepTerminalQuote===null?null:String(result.keepTerminalQuote),
      evaluated:result.evaluated,feasible:result.feasible,selected:selected?{id:selected.id,benefitQuote:String(selected.benefitQuote),bufferQuote:String(selected.bufferQuote),accepted:selected.accepted}:null});
    if(!selected?.accepted){this.hybridCandidate=null;this.nextHybridEvaluationAt=m.at+this.hybrid.cooldownMs;return;}
    const key=selected.id,prior=this.hybridCandidate;
    this.hybridCandidate={key,count:prior?.key===key&&m.at-prior.at<=90000?prior.count+1:1,at:m.at};
    if(this.hybridCandidate.count<this.hybrid.confirmations)return;
    const kind=this.position?'recenter':'entry',stage=this.stages(selected,kind)[0]!;
    this.hybridPending={plan:selected,kind,quotedAt:m.at,quotedBlock:m.block,stage,stageStartedAt:m.at,completedReceiptIds:[],afterSwap:null,
      actualSwap:null,before:record(this.balances(m))};
  }
  override summary(m:ResearchSource,hold:{amount0:bigint;amount1:bigint}){
    const result=super.summary(m,hold),exit=BigInt(result.terminalExitCostQuote),gas=this.gas-this.hybridAdverseSelectionQuote;
    return {...result,gasPaidQuote:String(gas),totalGasWithExitQuote:String(gas+exit),adverseSelectionQuote:String(this.hybridAdverseSelectionQuote),
      totalCostsWithExitQuote:String(this.gas+exit)};
  }
}
