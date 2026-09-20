import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inventoryRanges,inventoryMintPlan} from '../src/research/inventory-range.js';
import {InventoryLpReplay} from '../src/research/inventory-lp.js';
import {sqrtRatioAtTick,principalAmounts} from '../src/backtest/principal.js';
import {NVDA_PAPER_MARKET} from '../src/paper/market.js';
import {retainForecastSamples,configSchema} from '../src/adaptive-paper.js';
import {readFileSync} from 'node:fs';
import type {AdaptivePolicy,ResearchSource} from '../src/research/adaptive-lp.js';

test('range enumeration includes one-cell and asymmetric bands on either tick sign',()=>{
 for(const tick of [222245,-226024]){const ranges=inventoryRanges(tick,10,[1,2,4,8]);
  assert.equal(new Set(ranges.map(r=>`${r.tickLower}:${r.tickUpper}`)).size,ranges.length);
  assert(ranges.some(r=>r.tickUpper-r.tickLower===10));
  for(const r of ranges){assert(r.tickLower%10===0);assert(r.tickUpper%10===0);assert(tick>=r.tickLower&&tick<r.tickUpper);}
 }
});
test('competitor-shaped narrower mint preserves inventory and releases quote cash',()=>{
 const price=979676464215491944758868n,a0=147725428313248725586n,a1=99450092266n;
 const plan=inventoryMintPlan(price,{tickLower:-226030,tickUpper:-226020},a0,a1);
 assert.equal(plan.token,null);assert.equal(plan.amount,0n);
 assert.equal(plan.mint.amount0+plan.mint.idle0,a0);assert.equal(plan.mint.amount1+plan.mint.idle1,a1);
 assert(plan.mint.idle1>60000000000n);
});
test('forecast retention honours six hours and preserves the observation before cutoff',()=>{
 const samples=Array.from({length:421},(_,i)=>({at:i*60000,price:1n,growth0:0n,growth1:0n}));
 retainForecastSamples(samples,420*60000,360*60000);
 assert.equal(samples[0]!.at,59*60000);assert.equal(samples.at(-1)!.at-samples[0]!.at,361*60000);
});
const costs={entry:100n,recenter:200n,exit:80n,hold:30n,holdExit:25n,residual:70n};
const policy:AdaptivePolicy={name:'inventory',halfWidthsTicks:[80,160],adaptive:true,economicGate:true,budget:250000000n,decisionMs:30000,quoteTtlMs:90000,horizonMs:600000,slippageBps:50,costBufferPpm:500000,feeBufferPpm:250000,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const options={spanSpacings:[1,2,4,8],cooldownMs:60000,confirmations:2,gasBudgetQuote:10000000n};
const source=(tick:number,at:number):ResearchSource=>({price:sqrtRatioAtTick(tick),tick,at,block:String(at+1),liquidity:10n**18n,fee:500,spacing:10,ticks:[-1000,1000],net:t=>t===-1000?10n**18n:t===1000?-(10n**18n):0n});
const stats=(at:number,growth=0n)=>({asOf:at,spanMs:3600000,count:61,varianceTicksPerMs:0,growth0:growth,growth1:growth});
test('in-range move keeps tokens, pays explicit no-swap cost, and needs confirmation and later fill',async()=>{
 const m=new InventoryLpReplay(NVDA_PAPER_MARKET,costs,policy,options);
 await m.step(source(3,0),stats(0));await m.step(source(3,30000),stats(30000));assert(m.position);
 const rich=(at:number)=>stats(at,(1n<<128n)/1000n);
 await m.step(source(3,90000),rich(90000));assert.equal(Boolean(m.pending),false);
 await m.step(source(3,120000),rich(120000));assert(m.pending);assert.equal(m.pending.plan.token,null);
 const before=m.balances(source(3,150000));await m.fill(source(3,120000),rich(120000));assert.equal(m.recenters,0);
 await m.step(source(3,150000),rich(150000));assert.equal(m.recenters,1);assert.equal(m.gas,170n);
 const after=m.balances(source(3,150000));
 // Mint rounds token use up, principal rounds down: at most one raw unit per leg.
 assert(before.amount0-after.amount0<=1n&&before.amount0>=after.amount0);
 assert(before.amount1-after.amount1<=1n&&before.amount1>=after.amount1);
 assert.equal(m.actions.at(-1)!.early,true);assert.equal(m.actions.at(-1)!.token,null);
 const p=m.position!,principal=principalAmounts({...p,sqrtPriceX96:source(3,150000).price});assert(principal.amount0>=0n);
});
test('fill rejects a vanished economic edge without spending gas or changing inventory',async()=>{
 const m=new InventoryLpReplay(NVDA_PAPER_MARKET,costs,policy,options);
 await m.step(source(3,0),stats(0));await m.step(source(3,30000),stats(30000));
 for(const at of [90000,120000])await m.step(source(3,at),stats(at,(1n<<128n)/1000n));assert(m.pending);
 const before=m.balances(source(3,150000));await m.step(source(3,150000),stats(150000));
 assert.equal(m.pending,null);assert.equal(m.recenters,0);assert.equal(m.gas,100n);assert.deepEqual(m.balances(source(3,150000)),before);
});
test('entry requires a reserved full exit cost and config rejects implicit no-swap costs',async()=>{
 const m=new InventoryLpReplay(NVDA_PAPER_MARKET,costs,policy,{...options,gasBudgetQuote:179n});
 await m.step(source(3,0),stats(0));assert.equal(m.pending,null);assert.equal(m.gas,0n);assert(m.rejected.inventory_exit_reserve);
 const c=JSON.parse(readFileSync('config/adaptive-paper-60m.json','utf8'));c.inventoryRange={kind:'inventory_preserving_v1',...options,gasBudgetQuote:'10000000'};
 assert.throws(()=>configSchema.parse(c),/explicit no-swap/);
 const shipped=configSchema.parse(JSON.parse(readFileSync('config/adaptive-paper-inventory-250.json','utf8')));
 assert.equal(shipped.assets.length,1);assert.equal(BigInt(shipped.budgetQuote)+BigInt(shipped.inventoryRange!.gasBudgetQuote),250000000n);
});
test('an observation gap resets confirmations and a worsened mint rejects without cost',async()=>{
 const m=new InventoryLpReplay(NVDA_PAPER_MARKET,costs,policy,options),rich=(at:number)=>stats(at,(1n<<128n)/1000n);
 await m.step(source(3,0),stats(0));await m.step(source(3,30000),stats(30000));
 await m.step(source(3,90000),rich(90000));await m.step(source(3,210000),rich(210000));
 assert.equal(Boolean(m.pending),false);assert.equal(m.inventoryCandidate?.count,1);
 await m.step(source(3,240000),rich(240000));assert(m.pending);
 m.pending.plan.mint.liquidity*=2n;
 const before=m.balances(source(3,270000));await m.step(source(3,270000),rich(270000));
 assert.equal(m.recenters,0);assert.equal(m.gas,100n);assert.deepEqual(m.balances(source(3,270000)),before);
 assert.equal(m.rejected.inventory_frozen_mint_minimum,1);
});
test('fill rechecks the gas reserve and restored candidate needs the remaining confirmation',async()=>{
 const first=new InventoryLpReplay(NVDA_PAPER_MARKET,costs,policy,options),rich=(at:number)=>stats(at,(1n<<128n)/1000n);
 await first.step(source(3,0),stats(0));await first.step(source(3,30000),stats(30000));await first.step(source(3,90000),rich(90000));
 const saved=Object.fromEntries(Object.entries(first).filter(([key])=>!['market','costs','policy','inventory'].includes(key)));
 const restored=new InventoryLpReplay(NVDA_PAPER_MARKET,costs,policy,options);Object.assign(restored,structuredClone(saved));
 await restored.step(source(3,120000),rich(120000));assert(restored.pending);
 restored.gas=options.gasBudgetQuote-80n;
 const before=restored.balances(source(3,150000));await restored.step(source(3,150000),rich(150000));
 assert.equal(restored.recenters,0);assert.equal(restored.gas,options.gasBudgetQuote-80n);
 assert.deepEqual(restored.balances(source(3,150000)),before);assert.equal(restored.rejected.inventory_exit_reserve,1);
});
