import assert from 'node:assert/strict';
import {principalAmounts} from '../backtest/principal.js';
import {marketRange,marketTokens,marketValue,canonicalBalances,type PaperMarket} from '../paper/market.js';
import {solveRecenterSwap,assertRecenterPrice} from '../paper/execution-recenter.js';
import {replayPaperMint} from './management-audit.js';
import {historicalSwapQuote} from './portfolio-math.js';
import {virtualFeeCredit} from './virtual-fees.js';
import {forecastPortfolio,bandOccupancy,bandTraverseProbability,forecastCenterTick,
  type ForecastStats,type ForecastPortfolio} from './adaptive-forecast.js';
import type {FeeSegment,SwapSource} from './swap.js';
import type {AssetReplayCosts} from './asset-replay.js';
export interface ResearchLpCosts extends AssetReplayCosts {
  holdExit:bigint;
  /** Withdraw + collect + mint, with no swap and no router approval. Absent,
   * it is derived from the other frozen costs: withdraw = recenter - entry and
   * mint = recenter - exit, so residual = 2*recenter - entry - exit. */
  residual?:bigint;
}

type Range={tickLower:number;tickUpper:number};
type Position=Range&{liquidity:bigint;fee0:bigint;fee1:bigint};
export interface AdaptivePolicy {
  name:string;halfWidthsTicks:readonly number[];adaptive:boolean;economicGate:boolean;
  budget:bigint;decisionMs:number;quoteTtlMs:number;horizonMs:number;slippageBps:number;
  costBufferPpm:number;feeBufferPpm:number;gasMultiplier:number;feePpm:number;failEveryRecenter:number;
  /** Redeploy an out-of-range position as a one-sided band adjacent to the
   * current tick, funded without a swap, when the recenter gate declines.
   * Off by default; see notes/adaptive-residual-range-2026-09-18.md. */
  residualRange?:boolean;
  /** Candidate spans for that band, in ticks. Defaults to `halfWidthsTicks`.
   * A residual band's whole span is its label, unlike a two-sided band's
   * half-width, so the same list describes bands half as wide. */
  residualWidthsTicks?:readonly number[];
}
export interface ResearchSource extends SwapSource {block:string;at:number}
interface Plan extends Range {
  token:0|1|null;amount:bigint;amountOut:bigint;price:bigint;
  mint:ReturnType<typeof replayPaperMint>;
}
interface Pending {plan:Plan;at:number;block:string;reference:bigint;maxInput:bigint;kind:'entry'|'recenter';score:Record<string,unknown>|null}
const Q128=1n<<128n;
const recordBalances=(b:{amount0:bigint;amount1:bigint})=>({amount0:String(b.amount0),amount1:String(b.amount1)});

/** Offline conditional model only. The canonical book is immutable to every
 * hypothetical strategy. No oracle eligibility or successful broadcasts are
 * inferred from historical swaps or current fork evidence. */
export class AdaptiveLpReplay {
  cash0:bigint;cash1:bigint;position:Position|null=null;pending:Pending|null=null;
  gas=0n;fees0=0n;fees1=0n;allocationGap0=0n;allocationGap1=0n;partialSegments=0;
  entries=0;recenters=0;recenterAttempts=0;failures=0;residuals=0;rejected:Record<string,number>={};
  last: {at:number;outside:boolean;holding:boolean;deployment:bigint;exposure:bigint}|null=null;
  firstAt:number|null=null;lastDecision:number|null=null;cooldownUntil=0;
  peak:bigint;drawdownPpm=0n;maxExposurePpm=0n;maxLiquidityRatioPpm=0n;
  holdingMs=0;outsideMs=0;totalMs=0;deploymentPpmMs=0n;exposurePpmMs=0n;gapMs=0;
  invalid:string|null=null;actions:Record<string,unknown>[]=[];scores:Record<string,unknown>[]=[];
  constructor(readonly market:PaperMarket,readonly costs:ResearchLpCosts,readonly policy:AdaptivePolicy){
    // Any V3 fee tier and tick grid. `marketRange` rounds to the market's own
    // spacing and `halfWidthsTicks` must fit it, so a 3000/60 book supplies
    // 60/120/240/480/960 in place of 10/20/40/80/160.
    assert(policy.budget>0n&&policy.halfWidthsTicks.length>0);
    assert(Number.isInteger(market.fee)&&market.fee>0&&market.fee<1000000,'Pool fee outside the V3 domain');
    assert(Number.isInteger(market.tickSpacing)&&market.tickSpacing>0,'Pool tick spacing must be a positive integer');
    assert(policy.halfWidthsTicks.every(w=>Number.isInteger(w)&&w>0&&w%market.tickSpacing===0));
    assert((policy.residualWidthsTicks??[]).every(w=>Number.isInteger(w)&&w>0&&w%market.tickSpacing===0),
      'Residual band spans must fit the pool tick spacing');
    assert(policy.gasMultiplier>=1&&Number.isInteger(policy.gasMultiplier));
    assert(policy.feePpm>=0&&policy.feePpm<=1000000);
    const b=canonicalBalances(market,policy.budget,0n);this.cash0=b.amount0;this.cash1=b.amount1;this.peak=policy.budget;
  }
  cost(kind:keyof ResearchLpCosts){
    const base=kind==='residual'&&this.costs.residual===undefined
      ? 2n*this.costs.recenter-this.costs.entry-this.costs.exit
      : this.costs[kind]!;
    assert(base>0n,`Cost ${kind} is not positive`);
    return base*BigInt(this.policy.gasMultiplier);
  }
  balances(m:SwapSource){
    const p=this.position,a=p?principalAmounts({...p,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n};
    return {amount0:this.cash0+a.amount0+(p?p.fee0/Q128:0n),amount1:this.cash1+a.amount1+(p?p.fee1/Q128:0n)};
  }
  portfolio():ForecastPortfolio {
    return {amount0:this.cash0+(this.position?this.position.fee0/Q128:0n),amount1:this.cash1+(this.position?this.position.fee1/Q128:0n),position:this.position};
  }
  accrue(s:FeeSegment,protocol:number){
    const p=this.position;if(!p||this.invalid)return;
    const c=virtualFeeCredit(s,p,p.liquidity,protocol),scale=BigInt(this.policy.feePpm);
    const key=s.token===0?'fee0':'fee1',before=p[key]/Q128;p[key]+=c.lower*scale/1000000n;
    if(s.token===0){this.fees0+=p[key]/Q128-before;this.allocationGap0+=(c.upper-c.lower)*scale/1000000n;}
    else{this.fees1+=p[key]/Q128-before;this.allocationGap1+=(c.upper-c.lower)*scale/1000000n;}
    if(c.partial)this.partialSegments++;
  }
  reject(reason:string){this.rejected[reason]=(this.rejected[reason]??0)+1;}
  mark(m:ResearchSource){
    const b=this.balances(m),nav=marketValue(this.market,m.price,b.amount0,b.amount1)-this.gas;
    if(nav>this.peak)this.peak=nav;
    const dd=(this.peak-nav)*1000000n/this.peak;if(dd>this.drawdownPpm)this.drawdownPpm=dd;
    const q0=marketTokens(this.market).quoteIsToken0,risky=marketValue(this.market,m.price,q0?0n:b.amount0,q0?b.amount1:0n);
    const principal=this.position?principalAmounts({...this.position,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n};
    const deployment=nav>0n?marketValue(this.market,m.price,principal.amount0,principal.amount1)*1000000n/nav:0n;
    const exposure=nav>0n?risky*1000000n/nav:0n;
    if(exposure>this.maxExposurePpm)this.maxExposurePpm=exposure;
    const outside=!!this.position&&(m.tick<this.position.tickLower||m.tick>=this.position.tickUpper);
    if(this.position&&!outside&&m.liquidity>0n){const r=this.position.liquidity*1000000n/m.liquidity;if(r>this.maxLiquidityRatioPpm)this.maxLiquidityRatioPpm=r;}
    if(this.last){
      const dt=m.at-this.last.at;assert(dt>=0);this.totalMs+=dt;
      if(this.last.holding){this.holdingMs+=dt;if(this.last.outside)this.outsideMs+=dt;}
      this.deploymentPpmMs+=this.last.deployment*BigInt(dt);this.exposurePpmMs+=this.last.exposure*BigInt(dt);
      if(dt>900000)this.gapMs+=dt;
    }
    this.firstAt??=m.at;this.last={at:m.at,outside,holding:!!this.position,deployment,exposure};
    if(nav<=0n)this.invalid='capital_exhausted';
    return nav;
  }
  async plan(m:SwapSource,range:Range):Promise<Plan>{
    const b=this.balances(m);
    const swap=await solveRecenterSwap(m.price,range,b.amount0,b.amount1,async(amount,token)=>{
      const q=historicalSwapQuote(m,amount,token,this.policy.slippageBps);assert(q.fullyFilled,'swap_unfilled');return {amountOut:q.amountOut,price:q.sqrtPriceAfter};
    });
    if(swap.token!==null){const q=historicalSwapQuote(m,swap.amount,swap.token,this.policy.slippageBps);assert(q.passesSlippage,'quote_slippage');}
    assertRecenterPrice(swap.price,m.price,this.policy.slippageBps);
    const a=b.amount0+(swap.token===0?-swap.amount:swap.token===1?swap.amountOut:0n);
    const c=b.amount1+(swap.token===1?-swap.amount:swap.token===0?swap.amountOut:0n);
    const mint=replayPaperMint(swap.price,range,a,c,0n);assert(mint.liquidity>0n,'empty_mint');
    return {...range,...swap,mint};
  }
  async step(m:ResearchSource,stats:ForecastStats|null){
    if(this.invalid)return;
    if(stats)assert(stats.asOf<=m.at,'Future forecast input');
    this.mark(m);
    if(this.invalid||this.lastDecision!==null&&m.at-this.lastDecision<this.policy.decisionMs)return;
    this.lastDecision=m.at;
    if(this.pending){await this.fill(m,stats);this.mark(m);return;}
    if(m.at<this.cooldownUntil)return;
    if(this.position&&m.tick>=this.position.tickLower&&m.tick<this.position.tickUpper)return;
    if((this.policy.adaptive||this.policy.economicGate)&&!stats){this.reject('forecast_unavailable');return;}
    try{
      const kind=this.position?'recenter':'entry';
      let best:{plan:Plan;forecast:ReturnType<typeof forecastPortfolio>}|null=null;
      for(const width of this.policy.halfWidthsTicks){
        try{
          const plan=await this.plan(m,marketRange(m.price,m.tick,width,this.market.tickSpacing));
          const forecast=stats?forecastPortfolio(this.market,m,{amount0:plan.mint.idle0,amount1:plan.mint.idle1,position:{...plan,liquidity:plan.mint.liquidity}},stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter')):null;
          if(this.policy.adaptive&&!forecast)continue;
          if(!best||(forecast&&best.forecast&&forecast.terminalQuote>best.forecast.terminalQuote))best={plan,forecast};
        }catch{/* One infeasible width must not exclude the other candidates. */}
      }
      assert(best,'no_feasible_range');
      let score:Record<string,unknown>|null=null;
      if(this.policy.economicGate&&this.position){
        assert(stats&&best.forecast,'forecast_unavailable');
        const keep=forecastPortfolio(this.market,m,this.portfolio(),stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter'));
        assert(keep,'keep_forecast_unavailable');
        const benefit=best.forecast.terminalQuote-this.cost(kind)-keep.terminalQuote;
        const costBuffer=this.cost(kind)*BigInt(this.policy.costBufferPpm)/1000000n;
        const feeBuffer=best.forecast.feesQuote*BigInt(this.policy.feeBufferPpm)/1000000n;
        const buffer=costBuffer>feeBuffer?costBuffer:feeBuffer;
        score={at:m.at,asOf:stats.asOf,benefitQuote:String(benefit),bufferQuote:String(buffer),moveFeesQuote:String(best.forecast.feesQuote),keepFeesQuote:String(keep.feesQuote),accepted:benefit>buffer};
        this.scores.push(score);assert(benefit>buffer,'economic_gate');
      }
      const b=this.balances(m),plan=best.plan;
      this.pending={plan,at:m.at,block:m.block,reference:m.price,maxInput:plan.token===0?b.amount0:plan.token===1?b.amount1:0n,kind,score};
    }catch(e){this.reject(e instanceof Error?e.message:'quote_failed');}
    // The gate has had its say. A position it declined to recenter is one-sided
    // and earning nothing; redeploying it costs a fraction of a recenter and
    // needs no swap.
    if(this.policy.residualRange&&!this.pending&&!this.invalid&&stats)await this.residualStep(m,stats);
  }
  async fill(m:ResearchSource,stats:ForecastStats|null){
    const pending=this.pending!;
    if(BigInt(m.block)<=BigInt(pending.block)||m.at<=pending.at)return;
    this.pending=null;
    try{
      assert(m.at-pending.at<=this.policy.quoteTtlMs,'quote_expired');
      assert(m.tick>=pending.plan.tickLower&&m.tick<pending.plan.tickUpper,'frozen_range_left');
      assertRecenterPrice(m.price,pending.reference,this.policy.slippageBps);
      const plan=await this.plan(m,pending.plan);
      assert(plan.token===pending.plan.token,'swap_direction_changed');
      assert(plan.amount<=pending.maxInput,'frozen_input_budget');
      assertRecenterPrice(plan.price,pending.reference,this.policy.slippageBps);
      if(plan.token!==null)assert(plan.amountOut*pending.plan.amount*10000n>=pending.plan.amountOut*plan.amount*BigInt(10000-this.policy.slippageBps),'frozen_swap_minimum');
      // Entry is bounded on the liquidity the re-planned mint produces, not on
      // the quote's per-leg amounts. A two-sided mint funded from cash needs a
      // swap, so a few ticks of drift between quote and fill move the legs
      // arbitrarily far apart while the deployed liquidity barely moves: over
      // the live pilot's 43 mints the worst per-leg deviation from plan was
      // 9,999 bps and the worst liquidity deviation 17.9 bps, with none above
      // 50. The old per-leg check rejected 30 of 31 gated re-entries. The
      // recenter path is unchanged and still carries no mint bound of its own;
      // both kinds keep the frozen swap minimum above.
      if(pending.kind==='entry')
        assert(plan.mint.liquidity*10000n>=pending.plan.mint.liquidity*BigInt(10000-this.policy.slippageBps),'frozen_mint_minimum');
      if(this.policy.economicGate&&pending.kind==='recenter'){
        assert(stats,'fill_forecast_unavailable');
        const keep=forecastPortfolio(this.market,m,this.portfolio(),stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter'));
        const move=forecastPortfolio(this.market,m,{amount0:plan.mint.idle0,amount1:plan.mint.idle1,position:{...plan,liquidity:plan.mint.liquidity}},stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter'));
        assert(keep&&move,'fill_forecast_unavailable');
        const bufferA=this.cost('recenter')*BigInt(this.policy.costBufferPpm)/1000000n,bufferB=move.feesQuote*BigInt(this.policy.feeBufferPpm)/1000000n;
        assert(move.terminalQuote-this.cost('recenter')-keep.terminalQuote>(bufferA>bufferB?bufferA:bufferB),'fill_economic_gate');
      }
      const before=this.balances(m),after={amount0:before.amount0+(plan.token===0?-plan.amount:plan.token===1?plan.amountOut:0n),amount1:before.amount1+(plan.token===1?-plan.amount:plan.token===0?plan.amountOut:0n)};
      if(pending.kind==='recenter')this.recenterAttempts++;
      const fail=pending.kind==='recenter'&&this.policy.failEveryRecenter>0&&this.recenterAttempts%this.policy.failEveryRecenter===0;
      this.gas+=this.cost(pending.kind);
      if(fail){
        // Deterministic stress: removal and swap succeed, mint reverts. Charge
        // the full successful bundle estimate as a scenario for attempted gas.
        // Preserve released/swapped inventory and pay again for later recovery.
        this.cash0=after.amount0;this.cash1=after.amount1;this.position=null;this.failures++;this.cooldownUntil=m.at+600000;
      }else{
        this.cash0=plan.mint.idle0;this.cash1=plan.mint.idle1;
        this.position={tickLower:plan.tickLower,tickUpper:plan.tickUpper,liquidity:plan.mint.liquidity,fee0:0n,fee1:0n};
        if(pending.kind==='entry')this.entries++;else this.recenters++;
      }
      this.actions.push({at:m.at,block:m.block,quoteAt:pending.at,quoteBlock:pending.block,kind:fail?'partial_mint_failure':pending.kind,
        before:recordBalances(before),afterSwap:recordBalances(after),idle:recordBalances({amount0:this.cash0,amount1:this.cash1}),
        token:plan.token,amountIn:String(plan.amount),amountOut:String(plan.amountOut),gasQuote:String(this.cost(pending.kind)),
        tickLower:plan.tickLower,tickUpper:plan.tickUpper,liquidity:fail?'0':String(plan.mint.liquidity),minted0:fail?'0':String(plan.mint.amount0),minted1:fail?'0':String(plan.mint.amount1)});
    }catch(e){this.reject(e instanceof Error?e.message:'preflight_failed');}
  }
  /** 1 when the position holds only token1 (tick at or above tickUpper), 0
   * when only token0 (tick below tickLower), null when it is in range. */
  heldToken(m:SwapSource):0|1|null{
    const p=this.position;if(!p)return null;
    if(m.tick>=p.tickUpper)return 1;
    if(m.tick<p.tickLower)return 0;
    return null;
  }
  /** The closest swap-free band on the side of the token already held. A
   * token1 position needs the whole band at or below the tick; a token0
   * position needs it strictly above. */
  residualRange(m:SwapSource,span:number,token:0|1):Range{
    const s=this.market.tickSpacing,base=Math.floor(m.tick/s)*s;
    return token===1?{tickLower:base-span,tickUpper:base}:{tickLower:base+s,tickUpper:base+s+span};
  }
  /** Fee value for a hypothetical band at current depth, mirroring the fee
   * term of `forecastPortfolio` with unstopped occupancy in its place. */
  private bandFees(m:SwapSource,stats:ForecastStats,liquidity:bigint,occupancy:number){
    if(m.liquidity===0n||liquidity<=0n)return 0n;
    const occ=BigInt(Math.round(occupancy*1000000));
    const fee=(token:0|1)=>(token===0?stats.growth0:stats.growth1)*BigInt(this.policy.horizonMs)*liquidity*m.liquidity*occ*BigInt(this.policy.feePpm)/
      (BigInt(stats.spanMs)*Q128*(m.liquidity+liquidity)*1000000n*1000000n);
    return marketValue(this.market,m.price,fee(0),fee(1));
  }
  /** Redeploy a one-sided position into an adjacent band with no swap. The
   * inventory is identical either way, so there is no keep-versus-move
   * terminal comparison: the gate is forecast fees against the action's own
   * cost plus buffer, net of what keeping the current band already forecasts. */
  async residualStep(m:ResearchSource,stats:ForecastStats){
    const token=this.heldToken(m);
    if(token===null||!this.position)return;
    const center=forecastCenterTick(m.price),variance=stats.varianceTicksPerMs*this.policy.horizonMs;
    const cost=this.cost('residual');
    let best:{span:number;range:Range;mint:ReturnType<typeof replayPaperMint>;fees:bigint;charge:bigint;net:bigint}|null=null;
    for(const span of this.policy.residualWidthsTicks??this.policy.halfWidthsTicks){
      try{
        const range=this.residualRange(m,span,token);
        const b=this.balances(m),mint=replayPaperMint(m.price,range,b.amount0,b.amount1,0n);
        if(mint.liquidity<=0n)continue;
        const fees=this.bandFees(m,stats,mint.liquidity,bandOccupancy(center,range.tickLower,range.tickUpper,variance));
        const charge=cost*BigInt(Math.round(bandTraverseProbability(center,range.tickLower,range.tickUpper,variance,token)*1000000))/1000000n;
        const net=fees-charge;
        if(!best||net>best.net)best={span,range,mint,fees,charge,net};
      }catch{/* One infeasible span must not exclude the other candidates. */}
    }
    if(!best){this.reject('residual_infeasible');return;}
    const p=this.position;
    const keep=this.bandFees(m,stats,p.liquidity,bandOccupancy(center,p.tickLower,p.tickUpper,variance));
    const benefit=best.fees-best.charge-keep;
    const buffer=cost*BigInt(this.policy.costBufferPpm)/1000000n;
    this.scores.push({at:m.at,asOf:stats.asOf,kind:'residual',span:best.span,benefitQuote:String(benefit),
      bufferQuote:String(cost+buffer),accepted:benefit>cost+buffer});
    if(benefit<=cost+buffer){this.reject('residual_gate');return;}
    const before=this.balances(m);
    this.gas+=cost;
    this.cash0=best.mint.idle0;this.cash1=best.mint.idle1;
    this.position={tickLower:best.range.tickLower,tickUpper:best.range.tickUpper,liquidity:best.mint.liquidity,fee0:0n,fee1:0n};
    this.residuals++;
    this.actions.push({at:m.at,block:m.block,kind:'residual',span:best.span,
      before:recordBalances(before),afterSwap:recordBalances(before),
      idle:recordBalances({amount0:this.cash0,amount1:this.cash1}),
      token:null,amountIn:'0',amountOut:'0',gasQuote:String(cost),
      tickLower:best.range.tickLower,tickUpper:best.range.tickUpper,
      liquidity:String(best.mint.liquidity),minted0:String(best.mint.amount0),minted1:String(best.mint.amount1)});
    this.mark(m);
  }
  summary(m:ResearchSource,hold:{amount0:bigint;amount1:bigint}){
    this.mark(m);
    const b=this.balances(m),q0=marketTokens(this.market).quoteIsToken0;
    const close=(b:{amount0:bigint;amount1:bigint},gas:bigint,exit:bigint)=>{
      const risky=q0?b.amount1:b.amount0,cash=q0?b.amount0:b.amount1;
      try{const q=risky>0n?historicalSwapQuote(m,risky,q0?1:0,this.policy.slippageBps):null;
        if(q&&(!q.fullyFilled||!q.passesSlippage))return null;
        return cash+(q?.amountOut??0n)-gas-exit;
      }catch{return null;}
    };
    const needsExit=!!this.position||(q0?b.amount1:b.amount0)>0n,exitCost=needsExit?this.cost('exit'):0n;
    const terminal=close(b,this.gas,exitCost),holding=close(hold,this.cost('hold'),this.cost('holdExit'));
    const marked=marketValue(this.market,m.price,b.amount0,b.amount1)-this.gas;
    return {name:this.policy.name,fromAt:this.firstAt,toAt:m.at,entries:this.entries,recenters:this.recenters,recenterAttempts:this.recenterAttempts,partialFailures:this.failures,residuals:this.residuals,
      markedNavQuote:String(marked),terminalCashQuote:terminal===null?null:String(terminal),holdTerminalCashQuote:holding===null?null:String(holding),
      netPnlQuote:terminal===null?null:String(terminal-this.policy.budget),alphaQuote:terminal===null||holding===null?null:String(terminal-holding),
      terminalExitCostQuote:String(exitCost),gasPaidQuote:String(this.gas),totalGasWithExitQuote:String(this.gas+exitCost),
      fees0:String(this.fees0),fees1:String(this.fees1),feesQuote:String(marketValue(this.market,m.price,this.fees0,this.fees1)),
      feeApportionmentGapQuote:String(marketValue(this.market,m.price,(this.allocationGap0+Q128-1n)/Q128,(this.allocationGap1+Q128-1n)/Q128)),partialFeeSegments:this.partialSegments,
      drawdownPpm:String(this.drawdownPpm),maximumRiskyExposurePpm:String(this.maxExposurePpm),maximumLiquidityToExistingPpm:String(this.maxLiquidityRatioPpm),
      holdingMs:this.holdingMs,outsideMs:this.outsideMs,totalMs:this.totalMs,sourceGapMs:this.gapMs,
      averageDeploymentPpm:this.totalMs?String(this.deploymentPpmMs/BigInt(this.totalMs)):null,averageRiskyExposurePpm:this.totalMs?String(this.exposurePpmMs/BigInt(this.totalMs)):null,
      invalid:this.invalid,terminalExecutable:terminal!==null,rejected:this.rejected,actions:this.actions,economicScores:this.scores,executionEligible:false};
  }
}
