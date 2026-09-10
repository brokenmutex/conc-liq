import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {readFileSync} from 'node:fs';
import {calculateMonitorAnchorBlock} from '../src/rpc-health/probe.js';
import {advanceHolding, holdingChainFault, type PaperHoldingPolicy, type PaperHoldingState} from '../src/paper/holding.js';
import type {RpcHealthEvaluation} from '../src/rpc-health/domain.js';
import type {evaluatePaperCurrentRisk, PaperCurrentRiskRead} from '../src/paper/reference.js';
const policy:PaperHoldingPolicy={kind:'bounded_infrastructure_v1',maxLagBlocks:30,chainPauseSeconds:60,riskPauseSeconds:30};
const at=(seconds:number)=>new Date(Date.parse('2026-09-10T12:00:00Z')+seconds*1000).toISOString();
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
type Risk=ReturnType<typeof evaluatePaperCurrentRisk>;
const good={eligible:true,reasons:[],evidence:{failedChecks:[]}} as unknown as Risk;
const stale={eligible:false,reasons:['paper_current_risk_evidence_unavailable'],evidence:{failedChecks:['canonical_validation_age']}} as unknown as Risk;
function step(t:number,samples:ReturnType<typeof sample>[],previous?:PaperHoldingState,risk=good,riskRead:PaperCurrentRiskRead|null=null){
 return advanceHolding({now:at(t),samples,previous,risk,riskRead,policy});
}
describe('bounded holding incidents',()=>{
 it('classifies the recorded twelve later chain incidents without inventing missing hashes',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/paper-chain-incidents.json',import.meta.url),'utf8')) as
   {rows:{sessionId:string;samples:{id:string;snapshot:RpcHealthEvaluation}[]}[]};
  assert.equal(fixture.rows.length,12);
  for(const row of fixture.rows){
   const decisions=row.samples.map(s=>holdingChainFault(s.snapshot,30));
   if(row.sessionId==='40')assert(decisions.some(d=>d.hard.includes('private_block_lag_hard')));
   else assert(decisions.every(d=>!d.hard.length && d.transient.length),row.sessionId);
   if(['32','44','46'].includes(row.sessionId))for(const {snapshot:s} of row.samples){
    const heads=s.probes.filter(p=>p.role==='reference').map(p=>BigInt(p.headBlock!));
    const anchor=calculateMonitorAnchorBlock(heads,64,BigInt(s.privateHead!),30n)!;
    assert(s.probes.every(p=>BigInt(p.headBlock!)-anchor>=64n));
    assert.notEqual(anchor,BigInt(s.anchorBlock!),'Old shallow proof must not be relabelled valid');
   }
  }
 });
 it('tolerates a short syncing incident and recovery hysteresis beyond 60 seconds',()=>{
  let s=step(0,[sample(0)]);
  s=step(10,[sample(10,['private_reports_syncing'])],s);assert(s.paused);assert.equal(s.chainSince,at(10));
  for(let t=20;t<=140;t+=10){s=step(t,[sample(t,[],true)],s);assert(s.paused);assert.deepEqual(s.exitReasons,[]);}
  s=step(150,[sample(150)],s);assert(!s.paused);assert(s.resumeFromPause);assert.equal(s.chainSince,null);
 });
 it('persists the incident clock through a restart and latches expiry after recovery',()=>{
  let s=step(0,[sample(0,['private_reports_syncing'])]);
  for(let t=10;t<=50;t+=10)s=step(t,[sample(t,['private_reports_syncing'])],JSON.parse(JSON.stringify(s)));
  s=step(60,[sample(60)],s);assert(s.exitReasons.includes('paper_chain_pause_expired'));
  s=step(70,[sample(70)],s);assert(s.exitReasons.includes('paper_chain_pause_expired'));
 });
 it('detects a whole sustained incident between worker ticks',()=>{
  const s=step(80,Array.from({length:8},(_,i)=>sample((i+1)*10,i<7?['private_reports_syncing']:[])),step(0,[sample(0)]));
  assert(s.exitReasons.includes('paper_chain_pause_expired'));
 });
 it('bounds a missing monitor and does not restart its deadline on each tick',()=>{
  let s=step(0,[sample(0)]);
  s=step(31,[sample(0)],s);assert.equal(s.chainSince,at(30));
  s=step(90,[sample(0)],s);assert(s.exitReasons.includes('paper_chain_pause_expired'));
 });
 it('keeps unavailable quorum transient and observed conflicting hashes hard',()=>{
  const missing=sample(0,['reference_hash_quorum_unavailable']);
  Object.assign(missing.snapshot.probes[2]!,{anchorHash:null,anchorError:'timeout'});
  assert.deepEqual(holdingChainFault(missing.snapshot,30).hard,[]);
  const conflict=sample(0,['reference_hash_quorum_unavailable']);
  Object.assign(conflict.snapshot.probes[2]!,{anchorHash:'0x'+'b'.repeat(64)});
  assert(holdingChainFault(conflict.snapshot,30).hard.length);
 });
 it('keeps the recorded 107-block hard lag and malformed identity hard',()=>{
  assert(step(0,[sample(0,['private_block_lag_hard'])]).exitReasons.includes('private_block_lag_hard'));
  const bad=sample(0);Object.assign(bad.snapshot.probes[0]!,{chainId:1});
  assert(step(0,[bad]).exitReasons.includes('chain_identity_mismatch'));
 });
 it('retains 64-confirmation proof at the holding gate',()=>{
  const shallow=sample(0);Object.assign(shallow.snapshot.probes[0]!,{headBlock:shallow.snapshot.anchorBlock!+63n});
  assert(step(0,[shallow]).paused);
 });
 it('allows a real risk refresh within 30 seconds, but latches a late refresh',()=>{
  let s=step(0,[sample(0)],undefined,stale);assert.equal(s.riskSince,at(0));
  s=step(20,[sample(20)],s,good);assert.deepEqual(s.exitReasons,[]);assert(!s.paused);
  s=step(30,[sample(30)],s,stale);s=step(60,[sample(60)],s,good);
  assert(s.exitReasons.includes('paper_risk_pause_expired'));
 });
 it('does not spend the risk retry budget while the chain blocks RPC',()=>{
  let s=step(0,[sample(0,['private_reports_syncing'])],undefined,stale);
  for(let t=10;t<=120;t+=10)s=step(t,[sample(t,[],true)],s,stale);
  assert.equal(s.riskSince,null);assert.deepEqual(s.exitReasons,[]);
  s=step(130,[sample(130)],s,stale);assert.equal(s.riskSince,at(130));
 });
 it('does not grant grace to token, multiplier or true-price safety violations',()=>{
  for(const reason of ['paper_token_safety_check_failed','paper_reference_band_exceeded','paper_usdg_oracle_price_stale']){
   const r={...good,eligible:false,reasons:[reason]};
   assert(step(0,[sample(0)],undefined,r).exitReasons.includes(reason));
  }
 });
});
