import assert from 'node:assert/strict';
import {it} from 'node:test';
import {OffHoursCap,type CapFrame} from '../src/research/offhours-cap.js';
import {OffHoursRecenter,type RangePolicy} from '../src/research/offhours-recenter.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {inventoryBalances,poolReference} from '../src/research/inventory-management.js';
import type {RpcHealthEvaluation} from '../src/rpc-health/domain.js';
import type {SwapSource} from '../src/research/swap.js';
const at=(seconds:number)=>new Date(Date.parse('2026-09-09T01:00:00Z')+seconds*1000).toISOString();
function sample(t:number, reasons:string[]=[], recovery=false){
 const hash='0x'+'a'.repeat(64),head=10000+t*10;
 const probe={chainId:4663,error:null,anchorError:null,anchorBlock:BigInt(head-64),anchorHash:hash,
  headBlock:BigInt(head),headHash:hash,headTimestamp:BigInt(Date.parse(at(t))/1000),latencyMs:1,syncing:false,syncingError:null};
 return {id:String(t),snapshot:{observedAt:at(t),allowBulk:!reasons.length&&!recovery,
  reasons:recovery?['recovery_hysteresis']:reasons,warnings:[],state:reasons.length?'open':recovery?'half_open':'healthy',
  privateSyncing:false,lagBlocks:0n,anchorBlock:probe.anchorBlock,anchorHash:hash,privateAnchorHash:hash,
  privateHead:probe.headBlock,privateHeadTimestamp:probe.headTimestamp,privateHeadUnchangedSince:null,
  privateLatencyMs:1,lagSeconds:0n,referenceCount:2,referenceQuorum:2,referenceHead:probe.headBlock,
  referenceHeadSpreadBlocks:0n,referenceHeadTimestamp:probe.headTimestamp,schemaVersion:1,
  consecutiveHealthy:reasons.length?0:12,consecutiveUnhealthy:reasons.length?1:0,
  probes:[{...probe,role:'private',name:'private'},{...probe,role:'reference',name:'a'},{...probe,role:'reference',name:'b'}],
 } as RpcHealthEvaluation};
}
const costs={entry:800000n,exit:200000n,buy:250000n,feePpm:1000000};
function market(tick=222300):SwapSource {const l=10n**22n;return {price:sqrtRatioAtTick(tick),tick,liquidity:l,fee:500,spacing:10,ticks:[-887270,...Array.from({length:21},(_,i)=>222200+i*10),887270],net:t=>t===-887270?l:t===887270?-l:0n};}
function frame(t:number,m=market()):CapFrame{return {id:String(t),block:String(t+100000),hash:'0x'+'a'.repeat(64),sourceAt:at(t),observedAt:at(t+1),targetSetHash:'x',price:String(m.price),tick:m.tick,liquidity:String(m.liquidity),global0:'0',global1:'0',referencePrice:String(poolReference(m.price)),referenceEligible:true,referenceReasons:[],allHealthIds:[],referenceBasis:'test',chainHealthy:true,reasons:[],dataValid:true,events:[]};}
function step(model:OffHoursRecenter,t:number,m=market()){
 const previous=model.holding?.lastHealthAt,start=previous?Math.floor((Date.parse(previous)-Date.parse(at(0)))/1000):t;
 const samples=[];for(let s=start+10;s<t+1;s+=10)samples.push(sample(s));samples.push(sample(t+1));
 model.decision(frame(t,m),m,samples);
}
const recenterCosts={remove:200000n,mint:600000n,buy:200000n,sell:250000n};
const model=(policy:RangePolicy,cap=800000)=>new OffHoursRecenter(1000000000n,cap,costs,policy,recenterCosts);

it('recenter needs persistence, cooldown and a later source; it does not restart the session or benchmark',()=>{
 const m=model('net_swap');step(m,0);step(m,60);const benchmark=structuredClone(m.benchmark),enteredAt=m.enteredAt;
 step(m,600,market(222311));assert.equal(m.rangeIntent,null);
 step(m,660,market(222311));assert(m.rangeIntent);assert.equal(m.recenters,0);
 step(m,660,market(222311));assert.equal(m.recenters,0);
 step(m,720,market(222311));assert.equal(m.recenters,1);assert.equal(m.entries,1);assert.equal(m.exits,0);
 assert.equal(m.book.position!.tickLower,222290);assert.equal(m.enteredAt,enteredAt);assert.deepEqual(m.benchmark,benchmark);
 assert.equal(m.recenterSwaps,1);assert.equal(m.gas,costs.entry+recenterCosts.remove+recenterCosts.mint+recenterCosts.sell);
});
it('no-swap recenter retains all NVDA and charges only withdrawal plus mint',()=>{
 const m=model('preserve_tokens');step(m,0);step(m,60);step(m,600,market(222311));step(m,660,market(222311));
 const before=inventoryBalances(m.book,market(222311));step(m,720,market(222311));const after=inventoryBalances(m.book,market(222311));
 assert.equal(m.recenters,1);assert.equal(m.recenterSwaps,0);assert(before.amount1-after.amount1<=1n&&before.amount1>=after.amount1);
 assert.equal(m.gas,costs.entry+recenterCosts.remove+recenterCosts.mint);assert(m.book.rwa>0n);
});
it('a one-observation excursion resets; a failed delayed move retains the position and its fees',()=>{
 const m=model('net_swap');step(m,0);step(m,60);step(m,600,market(222311));step(m,660);assert.equal(m.displacement,null);
 step(m,720,market(222311));assert.equal(m.rangeIntent,null);step(m,780,market(222311));assert(m.rangeIntent);
 m.book.position!.fee0=500n*(1n<<128n);const before=structuredClone(m.book);step(m,840,market(222318));
 assert.equal(m.recenters,0);assert.deepEqual(m.book,before);assert.equal(m.rejections.recenter_fill_fill_tick_drift,1);
});
it('inventory liquidation preempts recentering and every subsequent cycle pays all accumulated gas',()=>{
 const low=model('net_swap',600000),high=model('net_swap');
 for(const m of [low,high]){step(m,0);step(m,60);step(m,600,market(222311));step(m,660,market(222311));}
 assert.equal(low.exits,1);assert.equal(low.recenters,0);assert(high.rangeIntent);step(high,720,market(222311));assert.equal(high.recenters,1);
 high.pending={kind:'exit',at:Date.parse(at(780)),reason:'test_full_exit',deadline:null};step(high,840,market(222311));
 assert.equal(high.exits,1);assert.equal(high.book.gas,0n);assert.equal(high.gas,costs.entry+high.recenterGas+costs.exit);
 const cash=high.book.cash;step(high,1500);step(high,1560);assert.equal(high.entries,2);assert.equal(high.actions.filter(a=>a.kind==='entry')[1].budget,String(cash));
});
it('hold_range is identical to the frozen baseline, including accounting and actions',()=>{
 const base=new OffHoursCap(1000000000n,600000,costs),hold=model('hold_range',600000);
 for(const t of [0,60,120,180,240,300]){const m=market(t>=120?222315:222300),health=[sample(t+1)];base.decision(frame(t,m),m,health);hold.decision(frame(t,m),m,health);}
 for(const [k,v] of Object.entries(base.summary(market(222315))))assert.deepEqual((hold.summary(market(222315)) as any)[k],v,k);
});

it('net buy planning matches the newly executed fork, including mint and residual balances',async()=>{
 const {readFileSync}=await import('node:fs');const {ExperimentMarket}=await import('../src/experiment/market.js');
 const {balancedRecenterPlan}=await import('../src/research/inventory-management.js');
 const f=JSON.parse(readFileSync(new URL('./fixtures/inventory-recenter-buy-fork.json',import.meta.url),'utf8'));
 const m=new ExperimentMarket(f.seed).source(),b=f.balances.afterCollect,p=balancedRecenterPlan(m,BigInt(b.quote),BigInt(b.rwa));
 assert.equal(p.token,0);assert.deepEqual(JSON.parse(JSON.stringify(p,(_,v)=>typeof v==='bigint'?String(v):v)),f.plan);
 assert.equal(String(p.mint.liquidity),f.position.liquidity);assert.equal(String(p.mint.idle0),f.balances.after.quote);assert.equal(String(p.mint.idle1),f.balances.after.rwa);
});
