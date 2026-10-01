import test from 'node:test';
import assert from 'node:assert/strict';
import {rangeKeeperPaperConfirmationEvidenceSamples} from
 '../src/deployments/rangekeeper-paper-confirmation-runtime.js';
import type {RangeKeeperPaperOwnedForkConfirmationEvidence} from
 '../src/deployments/rangekeeper-paper-confirmation-simulation.js';

const address=`0x${'1'.repeat(40)}`,hash=`0x${'2'.repeat(64)}` as `0x${string}`;
const estimate={gas:'100000',parentGas:'90000',baseFeeWei:'1000000000',parentBaseFeeWei:'1000000000',
 totalFeeWei:'100000000000000',parentFeeWei:'90000000000000',executionFeeWei:'10000000000000',
 basis:'node_estimateGas_with_paper_prestate_and_parent_component' as const};
function evidence():RangeKeeperPaperOwnedForkConfirmationEvidence{
 const stages=Array.from({length:8},(_,index)=>({stage:`stage_${index}`,localTransactionHash:hash,
  to:address,calldata:'0x1234',returnData:'0xabcd',gasUsed:'21000',effectiveGasPriceWei:'1000000000',
  estimate,stateOverrideHash:'a'.repeat(64),stateOverrides:{slot:`0x${index}`}}));
 return {schemaVersion:1,kind:'rangekeeper_paper_owned_fork_confirmation_simulation_v1',status:'success',
  evidenceClass:'caller_claimed_owned_anvil_fork',source:{block:'100',hash,timestamp:1_800_000_000},
  referenceProofHash:'b'.repeat(64),campaignId:'00000000-0000-4000-8000-000000000001',revision:1,
  configHash:'c'.repeat(64),profileHash:'d'.repeat(64),candidateHash:'e'.repeat(64),candidate:{} as never,
  sequenceHash:hash,stages,admissionAvailable:false,openingBooked:false};
}

test('maps owned-fork confirmation stages into gas evidence without losing overrides',()=>{
 const output=rangeKeeperPaperConfirmationEvidenceSamples(evidence());
 assert.equal(output.length,8);
 assert.deepEqual(output[0],{action:'stage_0',to:address,calldata:'0x1234',returnData:'0xabcd',
  localHash:hash,localGasUsed:'21000',localEffectiveGasPriceWei:'1000000000',sourceBlock:'100',
  sourceHash:hash,estimate,stateOverrideHash:'a'.repeat(64),stateOverrides:{slot:'0x0'}});
});

test('rejects malformed owned-fork stage fields before gas-report registration',()=>{
 const malformed=evidence();
 (malformed.stages[0] as {stateOverrideHash:string}).stateOverrideHash='not-a-hash';
 assert.throws(()=>rangeKeeperPaperConfirmationEvidenceSamples(malformed),
  /rangekeeper_confirmation_owned_fork_stage_invalid/);
 const incomplete=evidence();
 (incomplete as {stages:readonly unknown[]}).stages=[];
 assert.throws(()=>rangeKeeperPaperConfirmationEvidenceSamples(incomplete),
  /rangekeeper_confirmation_owned_fork_samples_unavailable/);
});
