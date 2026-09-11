import assert from 'node:assert/strict';
import {it} from 'node:test';
import {OffHoursCap,type CapFrame} from '../src/research/offhours-cap.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {poolReference} from '../src/research/inventory-management.js';
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
function market(tick=222300):SwapSource {const l=10n**22n;return {price:sqrtRatioAtTick(tick),tick,liquidity:l,fee:500,spacing:10,ticks:[-887270,222280,222290,222300,222310,222320,222330,887270],net:t=>t===-887270?l:t===887270?-l:0n};}
function frame(t:number,m=market()):CapFrame{return {id:String(t),block:String(t+100000),hash:'0x'+'a'.repeat(64),sourceAt:at(t),observedAt:at(t+1),targetSetHash:'x',price:String(m.price),tick:m.tick,liquidity:String(m.liquidity),global0:'0',global1:'0',referencePrice:String(poolReference(m.price)),referenceEligible:true,referenceReasons:[],allHealthIds:[],referenceBasis:'test',chainHealthy:true,reasons:[],dataValid:true,events:[]};}
function step(model:OffHoursCap,t:number,m=market()){model.decision(frame(t,m),m,[sample(t+1)]);}
it('requires a later source for entry and preserves a common initial benchmark across caps',()=>{
 const models=[600000,700000,800000].map(c=>new OffHoursCap(1000000000n,c,costs));
 for(const m of models){step(m,0);assert.equal(m.entries,0);step(m,0);assert.equal(m.entries,0);step(m,60);assert.equal(m.entries,1);assert.equal(m.gas,costs.entry);assert(m.nav(market())<m.budget);}
 assert.deepEqual(models[0]!.benchmark,models[2]!.benchmark);
});
it('charges every cycle and compounds reconciled cash through automatic reentry',()=>{
 const m=new OffHoursCap(1000000000n,600000,costs);step(m,0);step(m,60);
 step(m,120,market(222315));assert.equal(m.pending?.kind,'exit');assert.equal(m.exits,0);
 step(m,180,market(222315));assert.equal(m.exits,1);assert.equal(m.gas,costs.entry+costs.exit);
 const cash=m.book.cash;assert(cash<1000000000n);assert.equal(m.nav(market()),cash);assert.equal(m.book.gas,0n);
 step(m,720);assert.equal(m.pending,null);step(m,840);step(m,900);assert.equal(m.entries,2);
 assert.equal(m.actions.filter(a=>a.kind==='entry')[1].budget,String(cash));assert.equal(m.gas,2n*costs.entry+costs.exit);
});
it('isolates the cap decision and flags a missed holding interval as unavailable',()=>{
 const low=new OffHoursCap(1000000000n,600000,costs),high=new OffHoursCap(1000000000n,800000,costs);
 for(const m of [low,high]){step(m,0);step(m,60);step(m,120,market(222315));}
 assert.equal(low.pending?.kind,'exit');assert.equal(high.pending,null);
 step(high,1100);assert.equal(high.invalid,'unobserved_holding_decisions');assert.equal(high.exits,0);
});
it('requests cash before the excluded session and blocks reentry during the cutoff',()=>{
 const m=new OffHoursCap(1000000000n,600000,costs);
 const first=6*3600+20*60;step(m,first);step(m,first+60);assert.equal(m.entries,1);
 // Keep evidence continuous up to 07:50 UTC, ten minutes before 04:00 New York.
 for(let t=first+120;t<=6*3600+50*60;t+=60)step(m,t);
 assert.equal(m.pending?.kind,'exit');step(m,6*3600+51*60);assert.equal(m.exits,1);
 assert.equal(m.actions.at(-1).reason,'scheduled_cash_exit');assert.equal(m.lateExitSeconds,0);
 step(m,7*3600+10*60);assert.equal(m.pending,null);assert.equal(m.entries,1);
});

it('counts a late cash exit even when the first exit decision arrives after the boundary',()=>{
 const m=new OffHoursCap(1000000000n,600000,costs),start=6*3600+20*60;
 step(m,start);step(m,start+60);
 for(let t=start+120;t<=6*3600+49*60;t+=60)step(m,t);
 step(m,7*3600+60);assert.equal(m.pending?.kind,'exit');step(m,7*3600+120);
 assert.equal(m.exits,1);assert.equal(m.lateExitSeconds,121);
});
