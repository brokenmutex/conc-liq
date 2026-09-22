import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {it} from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {verifyPaperGasEvidence} from '../src/deployments/paper-gas-evidence.js';

const file=new URL('../research/calibration/static-manual-aapl-usdg-fork-2026-09-22.json',import.meta.url);

it('retained owned-fork stage evidence is internally consistent and tampering fails',()=>{
 const original=JSON.parse(readFileSync(file,'utf8'));
 const report=verifyPaperGasEvidence(original);
 assert.equal((report.stageProfiles as unknown[]).length,6);
 const changed=structuredClone(original);
 changed.stageProfiles[2].evidence.estimate.totalFeeWei='1';
 const {reportHash:_old,...body}=changed;
 changed.reportHash=contentHash(body);
 assert.throws(()=>verifyPaperGasEvidence(changed));
});
