import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {paperGasEvidenceClassFor} from '../src/deployments/paper-cost.js';
import {verifyPaperGasEvidence} from '../src/deployments/paper-gas-evidence.js';

// The retained owned-fork sample is the only complete, real stage report in the
// repository. Converting it to simulation shape exercises the verifier on
// genuine calldata and a genuine source rather than a hand-built fixture, which
// is what makes the negative cases below meaningful.
const file=new URL('../research/calibration/static-manual-aapl-usdg-fork-2026-09-22.json',
 import.meta.url);
const forkReport=()=>JSON.parse(readFileSync(file,'utf8'));

function asSimulated(mutate:(stage:any,report:any)=>void={}as never){
 const report=forkReport();
 for(const stage of report.stageProfiles){
  const {estimate:_estimate,localHash:_hash,localGasUsed:used,
   localEffectiveGasPriceWei:_price,...rest}=stage.evidence;
  stage.model.source.method='provider_simulate_v1_exact_call_v1';
  stage.model.gasUnitsExpected=used;
  stage.model.gasUnitsBound=String((BigInt(used)*13n+9n)/10n);
  stage.sourceHash=contentHash(stage.model.source);
  stage.evidence={...rest,simulation:{gasUsed:used,status:'0x1',
   parentHash:report.source.hash,basis:'provider_eth_simulateV1_sequenced_calls'}};
  stage.evidence.stateOverrideHash=createHash('sha256')
   .update(JSON.stringify(stage.evidence.stateOverrides)).digest('hex');
  if(typeof mutate==='function')mutate(stage,report);
 }
 const {reportHash:_old,...body}=report;
 return {...body,reportHash:contentHash(JSON.parse(JSON.stringify(body)))};
}

test('a simulated stage verifies on its own evidence shape',()=>{
 const report=verifyPaperGasEvidence(asSimulated());
 assert.equal((report.stageProfiles as unknown[]).length,6);
 for(const stage of report.stageProfiles as any[]){
  assert.equal(stage.model.source.method,'provider_simulate_v1_exact_call_v1');
  assert.equal(paperGasEvidenceClassFor(stage.model.source.method),'provider_simulated');
 }
});

test('a simulated stage that did not build on the pinned source is rejected',()=>{
 // This is the provenance guarantee the owned fork gets from
 // first.hash===source.hash. A remote simulation must prove the same thing from
 // its own response, or the measurement is unattributable.
 assert.throws(()=>verifyPaperGasEvidence(asSimulated(stage=>{
  stage.evidence.simulation.parentHash='0x'+'9'.repeat(64);
 })),/pinned canonical source/);
});

test('a simulated stage may not claim units its simulation did not measure',()=>{
 assert.throws(()=>verifyPaperGasEvidence(asSimulated(stage=>{
  stage.model.gasUnitsExpected=String(BigInt(stage.evidence.simulation.gasUsed)/2n);
  stage.sourceHash=contentHash(stage.model.source);
 })));
});

test('a simulated stage may not also carry a node estimate',()=>{
 // Otherwise a report could satisfy the fork contract and the simulation
 // contract at once, and the recorded method would stop meaning anything.
 const fork=forkReport();
 assert.throws(()=>verifyPaperGasEvidence(asSimulated((stage,_report)=>{
  stage.evidence.estimate=fork.stageProfiles[0].evidence.estimate;
 })),/must not carry a node estimate/);
});

test('the retained owned-fork report still verifies unchanged',()=>{
 const report=verifyPaperGasEvidence(forkReport());
 for(const stage of report.stageProfiles as any[])
  assert.equal(paperGasEvidenceClassFor(stage.model.source.method),'fork_estimated');
});
