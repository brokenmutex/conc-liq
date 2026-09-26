import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyPaperCloseConvertPrestateReport} from '../src/deployments/paper-close-convert-prestate-sampler.js';
import {buildProspectivePaperCloseConvertPrestateGasProfiles,
 PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1} from
 '../src/deployments/paper-close-convert-prestate-gas-profiles.js';
import {selectPaperCloseConvertPrestateCostsV1} from
 '../src/deployments/paper-close-convert-prestate-costs.js';
import {validReport} from './fixtures/paper-close-convert-prestate-report.js';

test('prestate sampler verifier accepts only report-bound simulated inventory and quote',()=>{
 const report=validReport();
 assert.equal(verifyPaperCloseConvertPrestateReport(report).reportHash,report.reportHash);
 const prospective=buildProspectivePaperCloseConvertPrestateGasProfiles(report);
 assert.equal(prospective.pathVersion,PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1);
 assert.equal(prospective.profiles.length,7);assert.equal(prospective.actionAvailable,false);
 assert(prospective.profiles.every(profile=>profile.status==='provisional'&&
  profile.evidenceClass==='fork_estimated'&&profile.validation.reportHash===report.reportHash));
 assert.equal('terminalMarkId' in report,false);
 const changedInventory={...report,inventory:{...report.inventory,token0Raw:'101'}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedInventory));
 const changedQuote={...report,quote:{...report.quote,expectedOutputRaw:'91'}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedQuote));
 const changedFeeReplay={...report,feeReplay:{...report.feeReplay,intervalHash:'a'.repeat(64)}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedFeeReplay));
});

test('prospective cost selector accepts only the exact seven report-bound prestate rows',()=>{
 const report=validReport(),prospective=buildProspectivePaperCloseConvertPrestateGasProfiles(report),
  version=3,rows=prospective.profiles.map((profile,index)=>({id:
   `00000000-0000-4000-8000-${String(index+11).padStart(12,'0')}`,version,
   poolAddress:profile.poolAddress,pathVersion:profile.pathVersion,stage:profile.stage,
   allowanceState:profile.allowanceState,sizeBand:profile.sizeBand,component:profile.component,
   status:profile.status,evidenceClass:profile.evidenceClass,model:profile.model,
   validation:{...profile.validation,actionAvailable:false},sourceHash:profile.sourceHash,
   observedUntil:profile.observedUntil})),
  gasPriceObservedAt=new Date(report.frame.source.timestamp*1000).toISOString(),now=Date.parse(gasPriceObservedAt);
 const costs=selectPaperCloseConvertPrestateCostsV1({report,rows,gasPriceWei:100n,
  gasPriceObservedAt,now});
 assert.equal(costs.kind,'paper_close_convert_prestate_costs_v1');
 assert.equal(costs.pathVersion,PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1);
 assert.equal(costs.stages.length,7);assert.equal(costs.paidGasAvailable,false);
 assert(costs.stages.every(stage=>stage.version===version&&stage.evidenceClass==='fork_estimated'));
 assert.throws(()=>selectPaperCloseConvertPrestateCostsV1({report,
  rows:rows.map(row=>({...row,pathVersion:'paper_static_manual_close_convert_v2'})),
  gasPriceWei:100n,gasPriceObservedAt,now}),/paper_close_convert_prestate_cost_profiles_unavailable/);
 assert.throws(()=>selectPaperCloseConvertPrestateCostsV1({report,rows:rows.slice(1),
  gasPriceWei:100n,gasPriceObservedAt,now}),/paper_close_convert_prestate_cost_profiles_unavailable/);
});
