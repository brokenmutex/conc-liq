import assert from 'node:assert/strict';
import test from 'node:test';
import {assertPaperConversionV3GasWithinReserve,conversionGasEvidenceV3Schema,
 PAPER_CONVERSION_ACCOUNTING_POLICY_V3} from
 '../src/deployments/paper-accounting.js';
import {PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1} from
 '../src/deployments/paper-close-convert-prestate-gas-profiles.js';

test('conversion accounting V3 admits only explicitly provisional prestate gas evidence',()=>{
 const evidence={kind:'candidate_prestate_gas_only',
  pathVersion:PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,evidenceClass:'fork_estimated',
  paidGasAvailable:false,reportHash:'a'.repeat(64),scopeHash:'b'.repeat(64),
  sequenceHash:'c'.repeat(64),sizeBand:'fixture',profileIds:Array.from({length:7},(_,index)=>
   `00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`)};
 assert.equal(PAPER_CONVERSION_ACCOUNTING_POLICY_V3,'paper_fixed_flow_convert_v3');
 assert.doesNotThrow(()=>conversionGasEvidenceV3Schema.parse(evidence));
 assert.throws(()=>conversionGasEvidenceV3Schema.parse({...evidence,
  pathVersion:'paper_static_manual_close_convert_v2'}));
 assert.throws(()=>conversionGasEvidenceV3Schema.parse({...evidence,paidGasAvailable:true}));
});

test('conversion V3 reports expected expense but admits only within its prospective gas bound',()=>{
 assert.doesNotThrow(()=>assertPaperConversionV3GasWithinReserve({cumulativeGasWei:10n,
  expectedGasWei:20n,boundGasWei:30n,reservedNativeWei:45n}));
 assert.throws(()=>assertPaperConversionV3GasWithinReserve({cumulativeGasWei:10n,
  expectedGasWei:20n,boundGasWei:36n,reservedNativeWei:45n}),
 /upper bound exceeds reserved paper allocation/);
});
