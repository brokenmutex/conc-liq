import assert from 'node:assert/strict';
import {AdaptiveLpReplay,type AdaptivePolicy,type ResearchLpCosts,type ResearchSource} from './adaptive-lp.js';
import {forecastPortfolio,type ForecastStats} from './adaptive-forecast.js';
import {marketRange,type PaperMarket} from '../paper/market.js';

export interface EarlyRangePolicy {
  boundaryPpm:number;
  confirmations:number;
  cooldownMs:number;
  narrowingPersistenceMs:number;
}

/** Optional in-range decisions only. The frozen baseline owns out-of-range
 * decisions, exact funding, later-block fills, gate rechecks and accounting. */
export class AgileLpReplay extends AdaptiveLpReplay {
  boundaryObservations=0;
  lastSuccessfulMove:number|null=null;
  narrowing:{width:number;since:number}|null=null;
  lastEarlyObservation:number|null=null;
  earlyQuoteTimes=new Set<number>();
  constructor(market:PaperMarket,costs:ResearchLpCosts,policy:AdaptivePolicy,readonly early:EarlyRangePolicy){
    super(market,costs,policy);
    assert(policy.adaptive&&policy.economicGate);
    assert(early.boundaryPpm>0&&early.boundaryPpm<1000000);
    assert(Number.isInteger(early.confirmations)&&early.confirmations>=1&&early.cooldownMs>=0&&early.narrowingPersistenceMs>=0);
  }
  override async fill(m:ResearchSource,stats:ForecastStats|null){
    const pending=this.pending,actions=this.actions.length;
    await super.fill(m,stats);
    if(this.actions.length>actions){
      const action=this.actions.at(-1)!;
      action.early=pending!==null&&this.earlyQuoteTimes.has(pending.at);
      if(action.kind!=='partial_mint_failure')this.lastSuccessfulMove=m.at;
      this.boundaryObservations=0;this.narrowing=null;
    }
    if(pending&&this.pending!==pending)this.earlyQuoteTimes.delete(pending.at);
  }
  override async step(m:ResearchSource,stats:ForecastStats|null){
    const p=this.position;
    if(!p||this.pending||m.tick<p.tickLower||m.tick>=p.tickUpper){
      this.boundaryObservations=0;this.narrowing=null;
      await super.step(m,stats);return;
    }
    if(this.invalid)return;
    if(stats)assert(stats.asOf<=m.at,'Future forecast input');
    this.mark(m);
    if(this.invalid||this.lastDecision!==null&&m.at-this.lastDecision<this.policy.decisionMs)return;
    this.lastDecision=m.at;
    if(this.lastEarlyObservation!==null&&m.at-this.lastEarlyObservation>90000){this.boundaryObservations=0;this.narrowing=null;}
    this.lastEarlyObservation=m.at;
    if(m.at<this.cooldownUntil||this.lastSuccessfulMove!==null&&m.at-this.lastSuccessfulMove<this.early.cooldownMs)return;
    const distance=Math.abs(2*m.tick-p.tickLower-p.tickUpper)*1000000/(p.tickUpper-p.tickLower);
    if(!stats||distance<this.early.boundaryPpm){this.boundaryObservations=0;this.narrowing=null;return;}
    if(++this.boundaryObservations<this.early.confirmations)return;
    try{
      let best:{plan:Awaited<ReturnType<AdaptiveLpReplay['plan']>>;forecast:NonNullable<ReturnType<typeof forecastPortfolio>>}|null=null;
      for(const width of this.policy.halfWidthsTicks){
        try{
          const plan=await this.plan(m,marketRange(m.price,m.tick,width,this.market.tickSpacing));
          if(plan.tickLower===p.tickLower&&plan.tickUpper===p.tickUpper)continue;
          const forecast=forecastPortfolio(this.market,m,{amount0:plan.mint.idle0,amount1:plan.mint.idle1,position:{...plan,liquidity:plan.mint.liquidity}},stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter'));
          if(forecast&&(!best||forecast.terminalQuote>best.forecast.terminalQuote))best={plan,forecast};
        }catch{/* An infeasible width does not exclude the other candidates. */}
      }
      assert(best,'early_no_feasible_range');
      const width=best.plan.tickUpper-best.plan.tickLower;
      if(width<p.tickUpper-p.tickLower){
        if(this.narrowing?.width!==width)this.narrowing={width,since:m.at};
        if(m.at-this.narrowing.since<this.early.narrowingPersistenceMs){this.reject('early_narrowing_persistence');return;}
      }else this.narrowing=null;
      const keep=forecastPortfolio(this.market,m,this.portfolio(),stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter'));
      assert(keep,'early_keep_forecast_unavailable');
      const benefit=best.forecast.terminalQuote-this.cost('recenter')-keep.terminalQuote;
      const costBuffer=this.cost('recenter')*BigInt(this.policy.costBufferPpm)/1000000n;
      const feeBuffer=best.forecast.feesQuote*BigInt(this.policy.feeBufferPpm)/1000000n;
      const buffer=costBuffer>feeBuffer?costBuffer:feeBuffer;
      const score={at:m.at,asOf:stats.asOf,benefitQuote:String(benefit),bufferQuote:String(buffer),moveFeesQuote:String(best.forecast.feesQuote),keepFeesQuote:String(keep.feesQuote),accepted:benefit>buffer,early:true};
      this.scores.push(score);assert(benefit>buffer,'early_economic_gate');
      const b=this.balances(m),plan=best.plan;
      this.pending={plan,at:m.at,block:m.block,reference:m.price,maxInput:plan.token===0?b.amount0:plan.token===1?b.amount1:0n,kind:'recenter',score};
      this.earlyQuoteTimes.add(m.at);
    }catch(e){this.reject(e instanceof Error?e.message:'early_quote_failed');}
  }
}
