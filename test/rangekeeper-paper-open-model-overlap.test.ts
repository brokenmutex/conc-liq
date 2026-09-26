import assert from 'node:assert/strict';
import test from 'node:test';
import {assertRangeKeeperPaperOpenCandidateFresh,assertRangeKeeperPaperOpenReportRows,
 settleRangeKeeperPaperOpenOverlap} from
 '../src/deployments/rangekeeper-paper-open-model-overlap.js';
import type {PaperGasProfileRow} from '../src/deployments/paper-cost.js';
import type {verifyRangeKeeperPaperGasReport} from '../src/deployments/rangekeeper-paper-gas-evidence.js';

const reportFixture=()=>({reportHash:'report-hash',pathVersion:'path-v1',sizeBand:'rk_0123456789abcdef0123456789abcdef',
 sampledAt:'2026-09-26T10:00:00.000Z',scope:{poolAddress:'0x0000000000000000000000000000000000000001'},
 stageProfiles:[{stage:'open_approve_manager_token0',allowanceState:'zero_core_allowances_v1',
  model:{stage:'open_approve_manager_token0',gasUnitsExpected:'10'},sourceHash:'source-a'},
 {stage:'open_approve_manager_token1',allowanceState:'zero_core_allowances_v1',
  model:{stage:'open_approve_manager_token1',gasUnitsExpected:'11'},sourceHash:'source-b'}]}) as unknown as
 ReturnType<typeof verifyRangeKeeperPaperGasReport>;
const rowsFor=(report:ReturnType<typeof reportFixture>):PaperGasProfileRow[]=>report.stageProfiles.map((stage,index)=>({
 id:`persisted-${index}`,version:7,poolAddress:report.scope.poolAddress,pathVersion:report.pathVersion,
 stage:stage.stage,allowanceState:stage.allowanceState,sizeBand:report.sizeBand,component:'gas_units',
 status:'provisional',evidenceClass:'fork_estimated',model:stage.model,sourceHash:stage.sourceHash,
 observedUntil:new Date(report.sampledAt)}));
const receipt={reportHash:'report-hash',version:7,profileIds:['persisted-0','persisted-1']};

test('overlap reconciliation requires the exact imported profile receipt and row contents',()=>{
 const report=reportFixture(),rows=rowsFor(report);
 assert.deepEqual(assertRangeKeeperPaperOpenReportRows(report,receipt,rows),rows);
});

test('overlap reconciliation rejects missing, superseded, or changed persisted evidence',()=>{
 const report=reportFixture(),rows=rowsFor(report);
 assert.throws(()=>assertRangeKeeperPaperOpenReportRows(report,{...receipt,profileIds:['persisted-0','missing']},rows),
  /persisted_profile_mismatch/);
 assert.throws(()=>assertRangeKeeperPaperOpenReportRows(report,receipt,
  rows.map((row,index)=>index===1?{...row,version:8}:row)),/persisted_profile_mismatch/);
 assert.throws(()=>assertRangeKeeperPaperOpenReportRows(report,receipt,
  rows.map((row,index)=>index===0?{...row,model:{...row.model as object,gasUnitsExpected:'999'}}:row)),
  /persisted_profile_mismatch/);
 assert.throws(()=>assertRangeKeeperPaperOpenReportRows(report,{...receipt,reportHash:'other'},rows),
  /registration_mismatch/);
});

test('registration failure publishes nothing and waits for the speculative branch to settle',async()=>{
 let speculativeSettled=false,returnedModel=false;
 const registration=Promise.reject(new Error('registration_failed')),
  speculative=new Promise<string>(resolve=>setTimeout(()=>{
   speculativeSettled=true;resolve('unpublished model');
  },10));
 await assert.rejects(async()=>{
  const [,model]=await settleRangeKeeperPaperOpenOverlap(registration,speculative);
  returnedModel=true;return model;
 },/registration_failed/);
 assert.equal(speculativeSettled,true);
 assert.equal(returnedModel,false);
});

test('overlap keeps the planner expiry and rejects a candidate expired during registration',()=>{
 assert.doesNotThrow(()=>assertRangeKeeperPaperOpenCandidateFresh(100,99_999));
 assert.throws(()=>assertRangeKeeperPaperOpenCandidateFresh(100,100_000),/candidate_expired/);
});
