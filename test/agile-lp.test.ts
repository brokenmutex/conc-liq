import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TrailingForecast} from '../src/research/adaptive-forecast.js';
import {agileForecastStats} from '../src/research/agile-forecast.js';
import {AdaptiveLpReplay,type AdaptivePolicy,type ResearchSource} from '../src/research/adaptive-lp.js';
import {AgileLpReplay} from '../src/research/agile-lp.js';
import {NVDA_PAPER_MARKET} from '../src/paper/market.js';
import {sqrtRatioAtTick as sqrt} from '../src/backtest/principal.js';

const spec={lookbackMs:21600000,minimumSpanMs:7200000,minimumSamples:60};
const sample=(i:number,tick:number)=>({at:i*60000,price:sqrt(tick),growth0:BigInt(i)*123456789012345678901234567890n,growth1:BigInt(i)*987654321987654321n});
test('unweighted agile estimator exactly matches frozen variance and bigint fee growth',()=>{
  const f=new TrailingForecast();for(let i=0;i<=420;i++)f.observe(sample(i,i%3));
  assert.deepEqual(agileForecastStats(f.samples,420*60000,spec),f.stats(420*60000));
  const w=agileForecastStats(f.samples,420*60000,{...spec,feeHalfLifeMs:3600000,weightedFeePpm:500000});
  assert(w);assert.equal(w.growth0,f.stats(420*60000)!.growth0);assert.equal(w.growth1,f.stats(420*60000)!.growth1);
});
test('recent-data weighting responds more strongly to a new shock and decays afterward',()=>{
  const f=new TrailingForecast();for(let i=0;i<360;i++)f.observe(sample(i,0));
  f.observe(sample(360,100));
  const weighted={...spec,volatilityHalfLifeMs:900000};
  const shock=agileForecastStats(f.samples,360*60000,weighted)!;
  assert(shock.varianceTicksPerMs>f.stats(360*60000)!.varianceTicksPerMs*10);
  for(let i=361;i<=390;i++)f.observe(sample(i,100));
  assert(agileForecastStats(f.samples,390*60000,weighted)!.varianceTicksPerMs<shock.varianceTicksPerMs/3);
});
test('short history, future data, staleness and long gaps fail closed',()=>{
  const f=new TrailingForecast();for(let i=0;i<=120;i++)f.observe(sample(i,0));
  assert.equal(agileForecastStats(f.samples,7199999,spec),null);
  assert.equal(agileForecastStats(f.samples,7400000,spec),null);
  const short={lookbackMs:1800000,minimumSpanMs:1200000,minimumSamples:20};
  assert(agileForecastStats(f.samples,7200000,short));
  assert.equal(agileForecastStats(f.samples.slice(-10),7200000,short),null);
  f.observe(sample(150,0));assert.equal(agileForecastStats(f.samples,9000000,short),null);
});
const depth=10n**18n,costs={entry:100n,recenter:200n,exit:80n,hold:30n,holdExit:25n};
const source=(tick:number,at:number):ResearchSource=>({price:sqrt(tick),tick,at,block:String(at+1),liquidity:depth,fee:500,spacing:10,ticks:[-1000,1000],net:t=>t===-1000?depth:t===1000?-depth:0n});
const policy:AdaptivePolicy={name:'agile',halfWidthsTicks:[20,40,80,160],adaptive:true,economicGate:true,budget:5000000000n,decisionMs:30000,quoteTtlMs:90000,horizonMs:600000,slippageBps:50,costBufferPpm:500000,feeBufferPpm:250000,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const stats=(at:number)=>({asOf:at,spanMs:7200000,count:121,varianceTicksPerMs:0,growth0:0n,growth1:0n});
const early={boundaryPpm:700000,confirmations:2,cooldownMs:600000,narrowingPersistenceMs:600000};
test('early decisions respect cooldown and confirmation, then retain a losing in-range move',async()=>{
  const m=new AgileLpReplay(NVDA_PAPER_MARKET,costs,policy,early);
  await m.step(source(0,0),stats(0));await m.step(source(0,30000),stats(30000));assert(m.position);
  // Zero-fee tie chooses the first feasible width: +/-20.
  assert.equal(m.position.tickUpper-m.position.tickLower,40);
  await m.step(source(15,60000),stats(60000));assert.equal(m.scores.length,0);
  await m.step(source(15,630000),stats(630000));assert.equal(m.scores.length,0);
  const p=m.position;
  await m.step(source(15,660000),stats(660000));
  assert.equal(m.scores.length,1);assert.equal(m.scores[0]!.accepted,false);
  assert.equal(m.pending,null);assert.equal(m.position,p);assert.equal(m.gas,100n);
});
test('early extension preserves original out-of-range actions and later-block fill rules',async()=>{
  const a=new AdaptiveLpReplay(NVDA_PAPER_MARKET,costs,policy),b=new AgileLpReplay(NVDA_PAPER_MARKET,costs,policy,early);
  for(const [tick,at] of [[0,0],[0,30000],[30,60000],[30,90000]])for(const m of [a,b])await m.step(source(tick!,at!),stats(at!));
  assert.deepEqual(b.balances(source(30,90000)),a.balances(source(30,90000)));
  assert.deepEqual(b.actions.map(({early:_,...rest})=>rest),a.actions);
  assert.deepEqual(b.scores,a.scores);
});
test('accepted early move must pass the gate again at fill and conserves the inherited action path',async()=>{
  const m=new AgileLpReplay(NVDA_PAPER_MARKET,costs,{...policy,feeBufferPpm:0},early);
  await m.step(source(0,0),stats(0));await m.step(source(0,30000),stats(30000));
  const rich=(at:number)=>({...stats(at),varianceTicksPerMs:0.0002,growth0:(1n<<128n)/1000n,growth1:(1n<<128n)/1000n});
  await m.step(source(15,630000),rich(630000));await m.step(source(15,660000),rich(660000));
  assert(m.pending,JSON.stringify({rejected:m.rejected,scores:m.scores}));assert.equal(m.recenters,0);assert.equal(m.scores.at(-1)!.early,true);
  const before=m.balances(source(15,690000));
  await m.step(source(15,690000),stats(690000));
  assert.equal(m.pending,null);assert.equal(m.recenters,0);assert.deepEqual(m.balances(source(15,690000)),before);
  assert.equal(m.rejected.fill_economic_gate,1);assert.equal(m.gas,100n);
  await m.step(source(15,720000),rich(720000));await m.step(source(15,750000),rich(750000));
  assert(m.pending);await m.step(source(15,780000),rich(780000));
  assert.equal(m.recenters,1);assert.equal(m.actions.at(-1)!.early,true);assert.equal(m.gas,300n);
});
test('a gap breaks early confirmations and narrowing requires persistent evidence',async()=>{
  const gap=new AgileLpReplay(NVDA_PAPER_MARKET,costs,policy,early);
  await gap.step(source(0,0),stats(0));await gap.step(source(0,30000),stats(30000));
  await gap.step(source(15,630000),stats(630000));await gap.step(source(15,750000),stats(750000));
  assert.equal(gap.scores.length,0);
  await gap.step(source(15,780000),stats(780000));assert.equal(gap.scores.length,1);

  const m=new AgileLpReplay(NVDA_PAPER_MARKET,costs,{...policy,halfWidthsTicks:[160],feeBufferPpm:0},early);
  await m.step(source(0,0),stats(0));await m.step(source(0,30000),stats(30000));
  assert.equal(m.position!.tickUpper-m.position!.tickLower,320);
  m.policy.halfWidthsTicks=[20,40,80,160];
  const rich=(at:number)=>({...stats(at),growth0:(1n<<128n)/1000n,growth1:(1n<<128n)/1000n});
  for(let at=630000;at<1260000;at+=30000){await m.step(source(120,at),rich(at));assert.equal(m.pending,null);}
  assert(m.rejected.early_narrowing_persistence!>0);assert.equal(m.gas,100n);
  await m.step(source(120,1260000),rich(1260000));assert(m.pending);
  assert(m.pending.plan.tickUpper-m.pending.plan.tickLower<320);
});
