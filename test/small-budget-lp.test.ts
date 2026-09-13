import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SmallBudgetLpReplay,type SmallBudgetOptions} from '../src/research/small-budget-lp.js';
import {type AdaptivePolicy,type ResearchSource} from '../src/research/adaptive-lp.js';
import {NVDA_PAPER_MARKET} from '../src/paper/market.js';
import {sqrtRatioAtTick as sqrt} from '../src/backtest/principal.js';
const depth=10n**18n,costs={entry:100n,recenter:200n,exit:80n,hold:30n,holdExit:25n};
const source=(tick:number,at:number):ResearchSource=>({price:sqrt(tick),tick,at,block:String(at+1),liquidity:depth,fee:500,spacing:10,ticks:[-1000,1000],net:t=>t===-1000?depth:t===1000?-depth:0n});
const policy:AdaptivePolicy={name:'fixed_20',halfWidthsTicks:[20],adaptive:false,economicGate:false,budget:1000000n,decisionMs:5000,quoteTtlMs:90000,horizonMs:600000,slippageBps:50,costBufferPpm:500000,feeBufferPpm:250000,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const options:SmallBudgetOptions={gasBudget:1000n,requireForecastForFixed:false,profiles:{entry:{withdrawMs:0,swapMs:10000,mintMs:30000,gasQuote:100,stageGasQuote:[0,40,60]},recenter:{withdrawMs:5000,swapMs:15000,mintMs:35000,gasQuote:200,stageGasQuote:[50,60,90]}}};
const fee={from:sqrt(0),to:sqrt(0),tickBefore:0,liquidity:depth,fee:10n**18n,token:0 as const,crossed:null};
async function enter(m:SmallBudgetLpReplay){for(const t of [0,10000,30000])await m.step(source(0,t),null);assert(m.position);}
test('staged recenter preserves withdrawn inventory and stops LP fees until replacement mint',async()=>{
 const m=new SmallBudgetLpReplay(NVDA_PAPER_MARKET,costs,policy,options);await enter(m);m.accrue(fee,0);assert(m.fees0>0n);
 await m.step(source(30,40000),null);const before=m.balances(source(30,45000));await m.step(source(30,45000),null);
 assert.equal(m.position,null);assert.deepEqual(m.balances(source(30,45000)),before);const fees=m.fees0;m.accrue(fee,0);assert.equal(m.fees0,fees);
 await m.step(source(30,55000),null);const swapped=m.balances(source(30,55000));assert.equal(m.position,null);
 await m.step(source(30,75000),null);assert(m.position);assert.equal(m.recenters,1);assert.equal(m.gas,300n);
 const minted=m.balances(source(30,75000));assert(minted.amount0<=swapped.amount0&&swapped.amount0-minted.amount0<=1n);assert(minted.amount1<=swapped.amount1&&swapped.amount1-minted.amount1<=1n);
 assert.equal(m.actions.reduce((n,a)=>n+BigInt(a.gasQuote as string),0n),m.gas);
});
test('a range left after the swap preserves real swapped inventory through failed mint and cooldown',async()=>{
 const m=new SmallBudgetLpReplay(NVDA_PAPER_MARKET,costs,policy,options);await m.step(source(0,0),null);await m.step(source(0,10000),null);
 const b=m.balances(source(0,10000));await m.step(source(80,30000),null);assert.equal(m.position,null);assert.deepEqual(m.balances(source(80,30000)),b);assert.equal(m.gas,100n);assert.equal(m.failures,1);
 await m.step(source(80,40000),null);assert.equal(m.pending,null);assert.equal(m.gas,100n);
});
test('gas allowance reserves a full exit before admitting another management bundle',async()=>{
 const m=new SmallBudgetLpReplay(NVDA_PAPER_MARKET,costs,policy,{...options,gasBudget:250n});await enter(m);
 await m.step(source(30,40000),null);assert(m.stopped);assert.equal(m.position,null);assert.equal(m.gas,180n);assert.equal(m.recenters,0);assert.equal(m.stopReason,'gas_budget');
 await m.step(source(0,100000),null);assert.equal(m.gas,180n);assert.equal(m.entries,1);
});
test('empty canonical liquidity does not create a capital-exhaustion mark or mutate custody',async()=>{
 const m=new SmallBudgetLpReplay(NVDA_PAPER_MARKET,costs,policy,options);await enter(m);const p=m.position;
 await m.step({...source(-887272,40000),liquidity:0n},null);assert.equal(m.invalid,null);assert.equal(m.position,p);assert.equal(m.unavailableMarks,1);
});
test('fixed controls wait for the same causal forecast availability as adaptive candidates',async()=>{
 const m=new SmallBudgetLpReplay(NVDA_PAPER_MARKET,costs,policy,{...options,requireForecastForFixed:true});await m.step(source(0,0),null);assert.equal(m.pending,null);assert.equal(m.gas,0n);
});
test('economic gate rechecks changed forecasts before withdrawing the old position',async()=>{
 const m=new SmallBudgetLpReplay(NVDA_PAPER_MARKET,costs,{...policy,economicGate:true},options);
 const stats=(at:number,growth0=0n)=>({asOf:at,spanMs:7200000,count:121,varianceTicksPerMs:0,growth0,growth1:0n});
 for(const at of [0,10000,30000])await m.step(source(0,at),stats(at));assert(m.position);const position=m.position;
 await m.step(source(30,40000),stats(40000,1n<<128n));assert(m.pending);assert.equal(m.stage,'withdraw');
 await m.step(source(30,45000),stats(45000));assert.equal(m.position,position);assert.equal(m.pending,null);assert.equal(m.gas,100n);assert.equal(m.rejected.withdraw_economic_gate,1);
});
