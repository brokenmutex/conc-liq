import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AdaptiveLpReplay,type AdaptivePolicy,type ResearchSource} from '../src/research/adaptive-lp.js';
import {TrailingForecast,forecastPortfolio} from '../src/research/adaptive-forecast.js';
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
