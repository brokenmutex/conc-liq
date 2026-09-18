import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AdaptiveLpReplay,type AdaptivePolicy,type ResearchSource} from '../src/research/adaptive-lp.js';
import {TrailingForecast,forecastPortfolio,rangeOccupancy} from '../src/research/adaptive-forecast.js';
import {NVDA_PAPER_MARKET,marketTokens} from '../src/paper/market.js';
import {sqrtRatioAtTick as sqrt} from '../src/backtest/principal.js';
import {historicalSwapQuote} from '../src/research/portfolio-math.js';
import {principalAmounts} from '../src/backtest/principal.js';
const depth=10n**18n,costs={entry:100n,recenter:200n,exit:80n,hold:30n,holdExit:25n};
const source=(tick:number,at:number,block=String(at+1)):ResearchSource=>({price:sqrt(tick),tick,at,block,liquidity:depth,fee:500,spacing:10,ticks:[-1000,1000],net:t=>t===-1000?depth:t===1000?-depth:0n});
const policy:AdaptivePolicy={name:'fixed_20',halfWidthsTicks:[20],adaptive:false,economicGate:false,budget:5000000000n,decisionMs:30000,quoteTtlMs:90000,horizonMs:600000,slippageBps:50,costBufferPpm:500000,feeBufferPpm:250000,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const stats={asOf:0,spanMs:7200000,count:121,varianceTicksPerMs:0,growth0:0n,growth1:0n};

test('causal forecast rejects future samples, short history and long timestamp gaps',()=>{
 const f=new TrailingForecast();
 for(let i=0;i<=120;i++)f.observe({at:i*60000,price:sqrt(i%2),growth0:BigInt(i),growth1:0n});
 assert(f.stats(7200000));assert.equal(f.stats(7199999),null);assert.equal(f.stats(7400000),null);
 assert.throws(()=>f.observe({at:7200000,price:sqrt(0),growth0:120n,growth1:0n}),/advance/);
 f.observe({at:9000000,price:sqrt(0),growth0:121n,growth1:0n});assert.equal(f.stats(9000000),null);
});
test('zero-variance in-range fee forecast agrees with its trailing-rate baseline',()=>{
 const f=forecastPortfolio(NVDA_PAPER_MARKET,source(0,0),{amount0:0n,amount1:0n,position:{tickLower:-20,tickUpper:20,liquidity:10000000n}},
  {...stats,growth0:1n<<128n},600000,0n);
 assert(f);assert.equal(f.feesQuote,f.trailingAlwaysActiveFeesQuote);assert(f.feesQuote>0n);
 const out=forecastPortfolio(NVDA_PAPER_MARKET,source(50,0),{amount0:0n,amount1:0n,position:{tickLower:-20,tickUpper:20,liquidity:10000000n}},
  {...stats,growth0:1n<<128n},600000,0n);
 assert(out);assert.equal(out.feesQuote,0n);
});
test('zero-variance forecasts preserve fractional-tick prices without a spurious price move',()=>{
 const m={...source(0,0),price:(sqrt(0)+sqrt(1))/2n},p={tickLower:-20,tickUpper:20,liquidity:10000000000000n};
 const b=principalAmounts({...p,sqrtPriceX96:m.price}),q0=marketTokens(NVDA_PAPER_MARKET).quoteIsToken0;
 const exit=historicalSwapQuote(m,q0?b.amount1:b.amount0,q0?1:0);
 const f=forecastPortfolio(NVDA_PAPER_MARKET,m,{amount0:0n,amount1:0n,position:p},stats,600000,80n);
 assert(f);assert.equal(f.terminalQuote,(q0?b.amount0:b.amount1)+exit.amountOut-80n);
});
test('research entry and recenter use virtual ticks with later-block fills and full cost charges',async()=>{
 for(const market of [NVDA_PAPER_MARKET,{...NVDA_PAPER_MARKET,rwa:'0x0000000000000000000000000000000000000001' as const}]){
  const m=new AdaptiveLpReplay(market,costs,policy);
  await m.step(source(0,0),null);assert(m.pending);assert.equal(m.entries,0);
  await m.step(source(0,30000,'1'),null);assert.equal(m.entries,0);
  await m.step(source(0,60000),null);assert.equal(m.entries,1);assert.equal(m.gas,100n);
  await m.step(source(30,90000),null);assert(m.pending);
  await m.step(source(30,120000),null);assert.equal(m.recenters,1);assert.equal(m.gas,300n);assert.equal(m.invalid,null);
  const held=m.balances(source(30,120000)),s=m.summary(source(30,120000),held);
  assert.equal(s.totalGasWithExitQuote,'380');assert.equal(BigInt(s.alphaQuote!),BigInt(s.terminalCashQuote!)-BigInt(s.holdTerminalCashQuote!));
 }
});
test('expired quotes do not charge transaction gas or reset portfolio',async()=>{
 const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,policy);await m.step(source(0,0),null);
 const before=m.balances(source(0,0));await m.step(source(0,100000),null);
 assert.equal(m.gas,0n);assert.equal(m.entries,0);assert.deepEqual(m.balances(source(0,100000)),before);assert.equal(m.rejected.quote_expired,1);
});
test('partial mint failure retains swapped inventory and charges recovery without resetting capital',async()=>{
 const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,{...policy,failEveryRecenter:1});
 for(const [tick,at] of [[0,0],[0,30000],[30,60000],[30,90000]])await m.step(source(tick!,at!),null);
 assert.equal(m.failures,1);assert.equal(m.position,null);assert.equal(m.gas,300n);assert.equal(m.recenters,0);
 const before=m.balances(source(30,90000)),a=m.actions.at(-1)!;
 assert.deepEqual(a.afterSwap,{amount0:String(before.amount0),amount1:String(before.amount1)});
 await m.step(source(30,120000),null);assert.equal(m.pending,null);
 await m.step(source(30,690000),null);assert(m.pending);await m.step(source(30,720000),null);
 assert.equal(m.entries,2);assert.equal(m.gas,400n);assert(m.position);
 const last=m.actions.at(-1)!;assert.deepEqual(last.before,a.afterSwap);
});
test('economic gate preserves an out-of-range position when no fees repay the move',async()=>{
 const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,{...policy,economicGate:true});
 await m.step(source(0,0),stats);await m.step(source(0,30000),{...stats,asOf:30000});
 const p=m.position;assert(p);
 await m.step(source(30,60000),{...stats,asOf:60000});
 assert.equal(m.pending,null);assert.equal(m.position,p);assert.equal(m.gas,100n);assert.equal(m.rejected.economic_gate,1);
 assert.equal(m.scores[0]!.accepted,false);
});
test('fee dilution, full-range exits and common passive benchmark remain separate',async()=>{
 const base=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,policy),stress=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,{...policy,gasMultiplier:2,feePpm:500000});
 for(const m of [base,stress]){await m.step(source(0,0),null);await m.step(source(0,30000),null);m.accrue({from:sqrt(-40),to:sqrt(40),tickBefore:-40,liquidity:depth,fee:1000000000000n,token:0,crossed:null},0);}
 assert(base.fees0>=stress.fees0*2n&&base.fees0<=stress.fees0*2n+1n);assert(base.partialSegments>0);
 const q0=marketTokens(NVDA_PAPER_MARKET).quoteIsToken0,hold={amount0:q0?2500000000n:2498750000n,amount1:q0?2498750000n:2500000000n};
 const a=base.summary(source(0,60000),hold),b=stress.summary(source(0,60000),hold);
 assert.equal(BigInt(a.holdTerminalCashQuote!)-BigInt(b.holdTerminalCashQuote!),costs.hold+costs.holdExit);
});

test('first-exit occupancy is exact at zero variance, zero outside the band and falls with volatility',()=>{
 assert.deepEqual(rangeOccupancy(0,-10,10,0),{occupancy:1,exitProbability:0,inRange:true});
 assert.deepEqual(rangeOccupancy(10,-10,10,25),{occupancy:0,exitProbability:1,inRange:false});
 assert.deepEqual(rangeOccupancy(-11,-10,10,25),{occupancy:0,exitProbability:1,inRange:false});
 let previous=1;
 for(const variance of [1,9,25,100,400,1600]){
  const r=rangeOccupancy(0,-10,10,variance);
  assert(r.occupancy<=previous&&r.occupancy>0&&r.exitProbability>=0&&r.exitProbability<=1);previous=r.occupancy;
 }
 // Expected first-exit time of a centered band is w²/v, so occupancy ≈ w²/V for V ≫ w².
 assert(Math.abs(rangeOccupancy(0,-10,10,10000).occupancy-0.01)<0.001);
 // Scale invariance and symmetry: the band/sigma ratio determines occupancy.
 const a=rangeOccupancy(0,-10,10,100),b=rangeOccupancy(0,-20,20,400);
 assert(Math.abs(a.occupancy-b.occupancy)<1e-9&&Math.abs(a.exitProbability-b.exitProbability)<1e-9);
 assert(Math.abs(rangeOccupancy(-9,-10,10,25).occupancy-rangeOccupancy(9,-10,10,25).occupancy)<1e-9);
 assert(rangeOccupancy(-9,-10,10,25).occupancy<rangeOccupancy(0,-10,10,25).occupancy);
});
test('forecast fees fall with volatility and a crossing charge applies only to positions inside their band',()=>{
 const p={tickLower:-10,tickUpper:10,liquidity:10000000000000n},rich={...stats,growth0:1n<<128n};
 const calm=forecastPortfolio(NVDA_PAPER_MARKET,source(0,0),{amount0:0n,amount1:0n,position:p},{...rich,varianceTicksPerMs:1/600000},600000,0n,1000000,200n);
 const wild=forecastPortfolio(NVDA_PAPER_MARKET,source(0,0),{amount0:0n,amount1:0n,position:p},{...rich,varianceTicksPerMs:400/600000},600000,0n,1000000,200n);
 assert(calm&&wild);assert(calm.feesQuote>wild.feesQuote);assert(calm.occupancy>wild.occupancy);
 assert.equal(calm.crossingChargeQuote,BigInt(Math.round(calm.exitProbability*1000000))*200n/1000000n);
 assert(wild.crossingChargeQuote>calm.crossingChargeQuote&&wild.crossingChargeQuote<=200n);
 const outside=forecastPortfolio(NVDA_PAPER_MARKET,source(50,0),{amount0:0n,amount1:0n,position:p},{...rich,varianceTicksPerMs:400/600000},600000,0n,1000000,200n);
 assert(outside);assert.equal(outside.feesQuote,0n);assert.equal(outside.crossingChargeQuote,0n);assert.equal(outside.occupancy,0);
});
test('adaptive width selection widens with trailing volatility and tightens in flat markets',async()=>{
 const wide=(tick:number,at:number):ResearchSource=>({...source(tick,at),ticks:[-100000,100000],net:t=>t===-100000?depth:t===100000?-depth:0n});
 const adaptive:AdaptivePolicy={...policy,name:'adaptive',halfWidthsTicks:[10,20,40,80,160],adaptive:true,economicGate:true,budget:1000000000n};
 const real={entry:176526n,recenter:220524n,exit:117376n,hold:51062n,holdExit:50834n};
 const chosen=async(sigmaTicksPerHorizon:number,growthDiv:bigint)=>{
  const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,real,adaptive);
  await m.step(wide(0,0),{asOf:0,spanMs:3600000,count:60,varianceTicksPerMs:sigmaTicksPerHorizon**2/600000,growth0:(1n<<128n)/growthDiv,growth1:(1n<<128n)/growthDiv/200n});
  assert(m.pending,JSON.stringify(m.rejected));return (m.pending.plan.tickUpper-m.pending.plan.tickLower)/2;
 };
 for(const growthDiv of [10n,1000n]){
  assert.equal(await chosen(3,growthDiv),10);assert.equal(await chosen(20,growthDiv),20);assert.equal(await chosen(40,growthDiv),40);
  let previous=0;
  for(const sigma of [1,5,10,20,40,80]){const w=await chosen(sigma,growthDiv);assert(w>=previous);previous=w;}
  assert(previous>=80);
 }
});

// --- W3: any V3 fee tier and tick grid -------------------------------------
test('a 3000-tier, spacing-60 market runs the same policy on its own grid',async()=>{
 const market={...NVDA_PAPER_MARKET,fee:3000,tickSpacing:60};
 const depth3000=10n**18n;
 const src=(tick:number,at:number,block=String(at+1)):ResearchSource=>({price:sqrt(tick),tick,at,block,liquidity:depth3000,
  fee:3000,spacing:60,ticks:[-6000,6000],net:t=>t===-6000?depth3000:t===6000?-depth3000:0n});
 const wide:AdaptivePolicy={...policy,name:'fixed_120',halfWidthsTicks:[120]};
 const m=new AdaptiveLpReplay(market,costs,wide);
 await m.step(src(0,0),null);assert(m.pending,JSON.stringify(m.rejected));
 // The chosen band is centred on the 60-tick grid, not the 10-tick grid.
 assert.equal(Math.abs(m.pending.plan.tickLower%60),0);assert.equal(Math.abs(m.pending.plan.tickUpper%60),0);
 assert.equal(m.pending.plan.tickUpper-m.pending.plan.tickLower,240);
 await m.step(src(0,60000),null);assert.equal(m.entries,1);
 // Half-widths that do not fit the grid are rejected outright.
 assert.throws(()=>new AdaptiveLpReplay(market,costs,{...policy,halfWidthsTicks:[10]}),/assert/i);
 // Fee tiers outside the V3 domain remain rejected.
 assert.throws(()=>new AdaptiveLpReplay({...market,fee:0},costs,wide),/V3 domain/);
 assert.throws(()=>new AdaptiveLpReplay({...market,tickSpacing:0},costs,wide),/positive integer/);
});
test('the experiment book replays a swap with its own fee tier and spacing',async()=>{
 const {ExperimentMarket}=await import('../src/experiment/market.js');
 const seed={price:String(sqrt(0)),tick:0,liquidity:'1000000000000000000',global0:'0',global1:'0',protocol0:0,protocol1:0,
  fee:3000,spacing:60,ticks:[{tick:-6000,gross:'1000000000000000000',net:'1000000000000000000'},
   {tick:6000,gross:'1000000000000000000',net:'-1000000000000000000'}]};
 const book=new ExperimentMarket(seed);
 assert.equal(book.source().fee,3000);assert.equal(book.source().spacing,60);
 assert.equal(book.seed().fee,3000);assert.equal(book.seed().spacing,60);
 // Seeds written before 3000-tier support carry no tier and stay fee-500/10.
 const {fee,spacing,...legacy}=seed;
 const old=new ExperimentMarket(legacy);
 assert.equal(old.source().fee,500);assert.equal(old.source().spacing,10);
});

// --- W4.1: cash-funded entry fills -----------------------------------------
test('an entry fill is bounded on deployed liquidity, not on the quote per-leg amounts',async()=>{
 // A wide book so a large tick move between quote and fill stays quotable.
 const wide=(tick:number,at:number,block=String(at+1)):ResearchSource=>({price:sqrt(tick),tick,at,block,liquidity:depth,
  fee:500,spacing:10,ticks:[-100000,100000],net:t=>t===-100000?depth:t===100000?-depth:0n});
 const entry:AdaptivePolicy={...policy,name:'entry_160',halfWidthsTicks:[160],slippageBps:50};
 const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,entry);
 await m.step(wide(0,0),null);assert(m.pending);
 const quoted=m.pending.plan.mint;
 // Drift the price well inside the frozen band before the fill.
 await m.step(wide(30,60000),null);
 assert.equal(m.entries,1,JSON.stringify(m.rejected));
 const filled=m.actions.at(-1)!;
 const legMoved=[0,1].some(t=>{
  const q=BigInt(quoted[`amount${t}` as 'amount0']),f=BigInt(filled[`minted${t}`] as string);
  return q>0n&&(q>f?q-f:f-q)*10000n>q*50n;
 });
 assert(legMoved,'the drift must move at least one leg past the old per-leg bound');
 assert(BigInt(filled.liquidity as string)*10000n>=quoted.liquidity*BigInt(10000-50));
});
test('an entry fill still fails when the re-planned mint loses more liquidity than the bound allows',async()=>{
 const wide=(tick:number,at:number,block=String(at+1)):ResearchSource=>({price:sqrt(tick),tick,at,block,liquidity:depth,
  fee:500,spacing:10,ticks:[-100000,100000],net:t=>t===-100000?depth:t===100000?-depth:0n});
 const entry:AdaptivePolicy={...policy,name:'entry_160',halfWidthsTicks:[160],slippageBps:50};
 const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,entry);
 await m.step(wide(0,0),null);assert(m.pending);
 // Inside the frozen 50-bps price band the re-plan never loses 50 bps of
 // liquidity -- that is the point of the bound -- so raise the quoted
 // liquidity to put the fill under it.
 m.pending.plan.mint.liquidity=m.pending.plan.mint.liquidity*2n;
 await m.step(wide(30,60000),null);
 assert.equal(m.entries,0);
 assert.equal(m.rejected.frozen_mint_minimum,1,JSON.stringify(m.rejected));
});
test('a drifted entry fill deploys the liquidity it quoted while both legs move far past the old bound',async()=>{
 const wide=(tick:number,at:number,block=String(at+1)):ResearchSource=>({price:sqrt(tick),tick,at,block,liquidity:depth,
  fee:500,spacing:10,ticks:[-100000,100000],net:t=>t===-100000?depth:t===100000?-depth:0n});
 const entry:AdaptivePolicy={...policy,name:'entry_160',halfWidthsTicks:[160],slippageBps:50};
 for(const drift of [5,10,20,30]){
  const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,entry);
  await m.step(wide(0,0),null);assert(m.pending);
  const quoted=m.pending.plan.mint;
  await m.step(wide(drift,60000),null);
  assert.equal(m.entries,1,`drift ${drift}: ${JSON.stringify(m.rejected)}`);
  const filled=m.actions.at(-1)!;
  // Legs move by hundreds to thousands of bps; liquidity moves by single bps
  // and never downward here. The old per-leg check failed every one of these.
  const worstLeg=Math.max(...[0,1].map(t=>{
   const q=BigInt(quoted[`amount${t}` as 'amount0']),f=BigInt(filled[`minted${t}`] as string);
   return q>0n?Math.abs(Number((q-f)*10000n/q)):0;
  }));
  assert(worstLeg>50,`drift ${drift} moved no leg past the old bound`);
  assert(BigInt(filled.liquidity as string)*10000n>=quoted.liquidity*BigInt(10000-50));
 }
});

// --- W1: the one-sided residual range, behind its policy flag --------------
const residualSource=(tick:number,at:number,block=String(at+1)):ResearchSource=>({price:sqrt(tick),tick,at,block,
 liquidity:depth,fee:500,spacing:10,ticks:[-100000,100000],net:t=>t===-100000?depth:t===100000?-depth:0n});
const residualStats=(at:number,div=10n)=>({asOf:at,spanMs:3600000,count:60,varianceTicksPerMs:100/600000,
 growth0:(1n<<128n)/div,growth1:(1n<<128n)/div/200n});
const residualCosts={entry:176526n,recenter:220524n,exit:117376n,hold:51062n,holdExit:50834n};
// A recenter nobody can afford, so the base gate always declines and the
// residual hook is the only thing that can act.
const unaffordable={...residualCosts,recenter:900000000n,residual:147146n};
async function stranded(policyOverrides:Partial<AdaptivePolicy>,costs=residualCosts){
 const p:AdaptivePolicy={...policy,name:'residual',halfWidthsTicks:[10,20,40],adaptive:true,economicGate:true,
  budget:1000000000n,...policyOverrides};
 const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,p);
 await m.step(residualSource(0,0),residualStats(0));
 await m.step(residualSource(0,60000),residualStats(60000));
 assert.equal(m.entries,1,JSON.stringify(m.rejected));
 return m;
}

test('the residual flag is off by default and adds nothing to the deployed policy',async()=>{
 const m=await stranded({});
 assert.equal(m.policy.residualRange,undefined);
 await m.step(residualSource(300,120000),residualStats(120000));
 assert.equal(m.residuals,0);
 assert.equal(m.summary(residualSource(300,150000),{amount0:1000000000n,amount1:0n}).residuals,0);
});
test('a declined recenter is followed by a one-sided residual band adjacent to the tick',async()=>{
 const m=await stranded({residualRange:true,residualWidthsTicks:[20]},unaffordable);
 // Fee growth an order of magnitude below the entry's, so the base gate cannot
 // repay even a token recenter while the narrower residual band still can.
 await m.step(residualSource(300,120000),residualStats(120000,1000n));
 assert.equal(m.rejected.economic_gate,1,'the base gate must have declined first');
 const a=m.actions.find(x=>x.kind==='residual');
 assert(a,`no residual placed: ${JSON.stringify(m.rejected)}`);
 // Holding token1 above the old band, so the new band sits at or below the tick.
 assert.equal(a.tickUpper,300);assert.equal(a.tickLower,280);
 assert.equal(a.token,null);assert.equal(a.amountIn,'0');
 assert.equal(a.minted0,'0','a token1 residual must deploy no token0');
 assert(BigInt(a.minted1 as string)>0n);
 assert.equal(a.gasQuote,'147146');
 assert.equal(m.residuals,1);
 assert.equal(m.position!.tickLower,280);assert.equal(m.position!.tickUpper,300);
});
test('a residual placement is refused when its forecast fees do not repay it',async()=>{
 const m=await stranded({residualRange:true,residualWidthsTicks:[20]},unaffordable);
 await m.step(residualSource(300,120000),residualStats(120000,10n**6n));
 assert.equal(m.residuals,0);
 assert.equal(m.rejected.residual_gate,1,JSON.stringify(m.rejected));
 const score=m.scores.at(-1)!;
 assert.equal(score.kind,'residual');assert.equal(score.accepted,false);
});
test('a residual band on the other side is one-sided in token0',async()=>{
 const p:AdaptivePolicy={...policy,name:'residual',halfWidthsTicks:[20],adaptive:false,economicGate:false,
  budget:1000000000n,residualRange:true,residualWidthsTicks:[20]};
 const m=new AdaptiveLpReplay(NVDA_PAPER_MARKET,unaffordable,p);
 // Place a band by hand above the tick so the book holds only token0.
 const source=residualSource(0,0);
 m.position={tickLower:200,tickUpper:240,liquidity:0n,fee0:0n,fee1:0n};
 assert.equal(m.heldToken(source),0);
 const range=m.residualRange(source,20,0);
 assert.equal(range.tickLower,10,'a token0 band must start strictly above the tick');
 assert.equal(range.tickUpper,30);
});
test('the residual cost is taken from the cost bundle when it is supplied',async()=>{
 const p:AdaptivePolicy={...policy,name:'residual',residualRange:true};
 const derived=new AdaptiveLpReplay(NVDA_PAPER_MARKET,{entry:100n,recenter:200n,exit:80n,hold:30n,holdExit:25n},p);
 assert.equal(derived.cost('residual'),2n*200n-100n-80n);
 const explicit=new AdaptiveLpReplay(NVDA_PAPER_MARKET,{entry:100n,recenter:200n,exit:80n,hold:30n,holdExit:25n,residual:174n},p);
 assert.equal(explicit.cost('residual'),174n);
 assert.throws(()=>new AdaptiveLpReplay(NVDA_PAPER_MARKET,{entry:100n,recenter:200n,exit:80n,hold:30n,holdExit:25n},
  {...p,residualWidthsTicks:[15]}),/tick spacing/);
});
test('unstopped band occupancy is positive outside the band where stopped occupancy is zero',async()=>{
 const {bandOccupancy,bandTraverseProbability}=await import('../src/research/adaptive-forecast.js');
 // Started exactly at the upper edge of [-20,0): stopped occupancy is 0.
 assert.equal(rangeOccupancy(0,-20,0,400).occupancy,0);
 const edge=bandOccupancy(0,-20,0,400);
 assert(edge>0&&edge<0.5,`expected partial occupancy at the edge, got ${edge}`);
 assert(bandOccupancy(-10,-20,0,0.0001)>0.99);
 assert.equal(bandOccupancy(-10,-20,0,0),1);
 assert.equal(bandOccupancy(5,-20,0,0),0);
 // A narrower band is traversed more often than a wider one from the same start.
 assert(bandTraverseProbability(0,-20,0,400,1)>bandTraverseProbability(0,-200,0,400,1));
 assert.equal(bandTraverseProbability(0,-20,0,0,1),0);
});
