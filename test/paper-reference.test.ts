import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe,it} from 'node:test';
import type {RiskSnapshot} from '../src/risk/domain.js';
import {DEFAULT_PAPER_POLICY,type PaperCheckpoint,policyHash} from '../src/paper/engine.js';
import {paperPolicySchema} from '../src/paper/config.js';
import {evaluatePaperReference,heartbeatOracle,latestEquitySessionStart} from '../src/paper/reference.js';
const baseline=JSON.parse(readFileSync(new URL('../notes/paper-continuous-evidence-2026-09-07/risk-snapshot.json',import.meta.url),'utf8')) as RiskSnapshot;
const cp=JSON.parse(readFileSync(new URL('../notes/paper-continuous-evidence-2026-09-07/reference-preflight.json',import.meta.url),'utf8')).cp as PaperCheckpoint;
const policy=DEFAULT_PAPER_POLICY.referencePolicy!;
const evaluate=(snapshot=structuredClone(baseline),p=policy)=>evaluatePaperReference({snapshot,checkpoint:cp,policy:p});
describe('continuous paper reference policy',()=>{
 it('accepts a labelled Friday reference through the holiday without inventing a fresh price',()=>{
  const r=evaluate();assert.equal(r.eligible,true);assert.equal(r.basis,'held_equity_reference');assert(r.ageSeconds!>86400);
  assert.equal(r.referenceUpdatedAt,'2026-09-04T17:46:24.000Z');assert.equal(r.maxDeviationPpm,30000);
 });
 it('uses actual feed heartbeats for USDG rather than the blanket five-minute ceiling',()=>{
  const s=structuredClone(baseline),block=BigInt(Date.parse(s.blockTimestamp)/1000);
  assert.equal(s.quoteOracle!.executionEligible,false);
  assert.equal(heartbeatOracle(s.quoteOracle,block,86400)!.executionEligible,true);
  assert.equal(heartbeatOracle(s.quoteOracle,block,300)!.executionEligible,false);
  assert.equal(heartbeatOracle(s.quoteOracle,BigInt(s.quoteOracle!.state!.updatedAt)+86401n,86400)!.executionEligible,false);
 });
 it('does not reuse the holiday exception once another regular session has opened',()=>{
  assert.equal(new Date(latestEquitySessionStart('2026-09-07T08:58:10Z')!).toISOString(),'2026-09-04T13:30:00.000Z');
  assert.equal(new Date(latestEquitySessionStart('2026-09-08T21:00:00Z')!).toISOString(),'2026-09-08T13:30:00.000Z');
  const s=structuredClone(baseline);(s as {blockTimestamp:string}).blockTimestamp='2026-09-08T21:00:00Z';
  assert(evaluate(s).reasons.includes('paper_equity_reference_age_unacceptable'));
  assert.equal(latestEquitySessionStart('2027-03-01T12:00:00Z'),null);
 });
 it('keeps the bound independent from the pool and rejects an excessive deviation',()=>{
  const r=evaluate(undefined,{...policy,maxDeviationPpm:5000});assert.equal(r.eligible,false);assert(r.reasons.includes('paper_reference_band_exceeded'));
 });
 it('retains issuer pause, incomplete round and multiplier safeguards',()=>{
  for(const kind of ['pause','round','multiplier','pending'] as const){
   const s=structuredClone(baseline),a=s.assets.find(a=>a.registry.symbol==='NVDA')!;
   if(kind==='pause')Object.assign(a.onchain!,{oraclePaused:true});
   if(kind==='round')Object.assign(a.oracle!.state!,{answeredInRound:'0'});
   if(kind==='multiplier')Object.assign(a.flags,{multiplierConsistent:false});
   if(kind==='pending')Object.assign(a.flags,{corporateActionPending:true});
   assert.equal(evaluate(s).eligible,false,kind);
  }
 });
 it('rejects stale USDG or future equity timestamps instead of substituting one dollar',()=>{
  const s=structuredClone(baseline);Object.assign(s.quoteOracle!.state!,{updatedAt:'1'});assert.equal(evaluate(s).eligible,false);
  const other=structuredClone(baseline);Object.assign(other.assets.find(a=>a.registry.symbol==='NVDA')!.oracle!.state!,{updatedAt:String(BigInt(Date.parse(other.blockTimestamp)/1000)+1n)});
  assert.equal(evaluate(other).eligible,false);
 });
 it('does not rewrite the existing regular-hours session policy hash',()=>{
  const old={...DEFAULT_PAPER_POLICY};delete old.referencePolicy;
  assert.equal(policyHash(paperPolicySchema.parse(old)),'32ec0e0acfd86de2f35c2599fdbc93480bbc315b12636b4f9b0cbf91af762924');
 });
});
