import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test,type TestContext} from 'node:test';
import {readPilotGuard,retryPilotHoldingRisk} from '../src/live-pilot/guard.js';
import {advanceHolding} from '../src/paper/holding.js';
import {evaluatePaperCurrentRisk} from '../src/paper/reference.js';

function freshHealth(f:any,at:string){const h=structuredClone(f.health[0]);h.snapshot.observedAt=at;
 for(const p of h.snapshot.probes)p.headTimestamp=String(Math.floor(Date.parse(at)/1000));
 return h;}
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/live-risk-publication-race.json',import.meta.url),'utf8'));
function harness(t:TestContext){
 const f=fixture();t.mock.timers.enable({apis:['Date'],now:Date.parse(f.incident.at)});
 const db={query:async(sql:string)=>{
  if(sql.includes('FROM rpc_health_samples'))return {rows:f.health};
  if(sql.includes('WITH attempts AS')){
   // The new snapshot completes after guard entry, before the MVCC risk read.
   if(Date.now()<Date.parse(f.read.evaluatedAt))t.mock.timers.setTime(Date.parse(f.read.evaluatedAt));
   return {rows:[structuredClone(f.read)]};
  }
  return {rows:[{checkpoint:f.checkpoint,canonical:true,covered:true,coverage_identity_valid:true}]};
 }};
 const client={getBlock:async()=>({number:BigInt(f.health[0].snapshot.anchorBlock),hash:f.health[0].snapshot.anchorHash,
  timestamp:BigInt(Math.floor(Date.now()/1000)-8)})};
 const read=(state=f.state,refresh?:Parameters<typeof readPilotGuard>[5])=>readPilotGuard(db as never,client as never,{strategy:f.policy} as never,'fixture',state,refresh);
 return {f,read};
}
test('recorded publication race becomes a bounded pause using the post-read observation clock',async t=>{
 const {f,read}=harness(t);
 assert.equal(Date.parse(f.read.selected.completedAt)-Date.parse(f.incident.at),225);
 assert.deepEqual(f.incident.observedExitReasons,['paper_current_risk_evidence_invalid']);
 const r=await read();assert(r.holding?.paused);assert.deepEqual(r.holding.exitReasons,[]);
 assert.equal(r.holding.riskSince,f.read.evaluatedAt);assert.equal(r.holding.checkedAt,f.read.evaluatedAt);
 assert.equal(r.entryAllowed,false,'Pending validation must not admit a new position');
});
test('pending validation validates the selected run immediately and resumes without recollection',async t=>{
 const {f,read}=harness(t);let calls=0;
 const r=await read(f.state,async(id,only)=>{
  calls++;assert.equal(id,'19877');assert.equal(only,true);
  t.mock.timers.setTime(Date.parse(f.read.evaluatedAt)+5308);
  f.read.evaluatedAt=new Date().toISOString();f.read.selected.validatedAt=f.read.evaluatedAt;
  f.read.selected.canonical=true;f.read.selected.canonicalObservedHash=f.read.selected.blockHash;
 });
 assert.equal(calls,1);assert.equal(r.holding?.paused,false);assert.deepEqual(r.holding?.exitReasons,[]);assert.equal(r.holding?.riskSince,null);
});
test('failed validation is attempted once and preserves the incident through restart',async t=>{
 const {f,read}=harness(t);let calls=0;
 const r=await read(f.state,async()=>{calls++;throw Error('validation unavailable');});
 assert(r.holding?.paused);assert.equal(calls,1);assert.match(r.holding.retryError!,/validation unavailable/);
 const persisted=JSON.parse(JSON.stringify(r.holding));assert(!await retryPilotHoldingRisk(persisted,async()=>{calls++;}));assert.equal(calls,1);
 const later=advanceHolding({now:new Date(Date.parse(persisted.riskSince)+30000).toISOString(),policy:f.policy.holdingPolicy,
  previous:persisted,samples:[freshHealth(f,new Date(Date.parse(persisted.riskSince)+30000).toISOString())],risk:{eligible:false,reasons:['paper_current_risk_evidence_unavailable'],evidence: r.holding.riskEvidence} as never,riskRead:f.read});
 assert(later.exitReasons.includes('paper_risk_pause_expired'));
});
test('a validation completed after the deadline does not erase the required exit',async t=>{
 const {f,read}=harness(t);const r=await read(f.state,async()=>{
  t.mock.timers.setTime(Date.parse(f.read.evaluatedAt)+30000);f.read.evaluatedAt=new Date().toISOString();f.health=[freshHealth(f,f.read.evaluatedAt)];
  f.read.selected.validatedAt=f.read.evaluatedAt;f.read.selected.canonical=true;f.read.selected.canonicalObservedHash=f.read.selected.blockHash;
 });
 assert(r.holding?.exitReasons.includes('paper_risk_pause_expired'));
});
test('actual future publication timestamps and hash conflicts remain hard exits without a retry',async t=>{
 const {f,read}=harness(t);f.read.selected.completedAt=new Date(Date.parse(f.read.evaluatedAt)+1).toISOString();let calls=0;
 const future=await read(f.state,async()=>{calls++;});assert(future.holding?.exitReasons.includes('paper_current_risk_evidence_invalid'));assert.equal(calls,0);
 f.read.selected.completedAt=fixture().read.selected.completedAt;
 f.read.selected.canonicalObservedHash='0x'+'f'.repeat(64);
 const conflict=await read(f.state,async()=>{calls++;});assert(conflict.holding?.exitReasons.includes('paper_current_risk_evidence_invalid'));assert.equal(calls,0);
});
test('evidence cannot become legitimate merely because the caller observes it later',()=>{
 const f=fixture();f.read.selected.completedAt=new Date(Date.parse(f.read.evaluatedAt)+1).toISOString();
 const risk=evaluatePaperCurrentRisk(f.read,f.checkpoint,f.policy.referencePolicy);
 const r=advanceHolding({now:new Date(Date.parse(f.read.evaluatedAt)+1000).toISOString(),policy:f.policy.holdingPolicy,
  previous:f.state.holding,samples:f.health,risk,riskRead:f.read});
 assert(r.exitReasons.includes('paper_current_risk_evidence_invalid'),'Compare publication with its own database read clock');
});
test('validation alone is not used when the snapshot itself also needs refresh',async t=>{
 const {f,read}=harness(t);f.read.selected.snapshot.blockTimestamp='2026-09-12T17:40:00Z';let calls=0;
 const r=await read(f.state,async(id,only)=>{calls++;assert.equal(id,'19877');assert.equal(only,false);});
 assert.equal(calls,1);assert(r.holding?.paused);assert.deepEqual(r.holding.exitReasons,[]);
});
