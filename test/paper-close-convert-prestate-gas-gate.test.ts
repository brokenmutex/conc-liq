import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessPaperCloseConvertPrestateGasGate} from '../src/deployments/paper-close-convert-prestate-gas-gate.js';

const source=(block:string,hash=`0x${block.padStart(64,'0')}`)=>({block,hash});
const ready={sevenStageReplayVerified:true,prospectiveProfilesRegistered:true,
 terminalEnvelopeWorkerReplayVerified:true} as const;

test('prior persisted fee carry cannot qualify at a later prestate source',()=>{
 const result=assessPaperCloseConvertPrestateGasGate({...ready,
  sampleSource:source('101'),feeCarryThrough:source('100'),feeCarryMode:'stale_prior',
  feeIntervalComplete:false,feeAnchorsRechecked:false});
 assert.equal(result.status,'unavailable');assert.equal(result.actionAvailable,false);
 assert(result.blockers.includes('fee_carry_not_replayed_through_sample_source'));
});

test('ephemeral adjacent interval requires complete coverage and both anchor rechecks',()=>{
 const incomplete=assessPaperCloseConvertPrestateGasGate({...ready,
  sampleSource:source('101'),feeCarryThrough:source('101'),feeCarryMode:'ephemeral_interval',
  feeIntervalComplete:false,feeAnchorsRechecked:true});
 assert.equal(incomplete.ephemeralFeeIntervalVerified,false);
 assert(incomplete.blockers.includes('ephemeral_fee_interval_incomplete_or_unanchored'));
 const unanchored=assessPaperCloseConvertPrestateGasGate({...ready,
  sampleSource:source('101'),feeCarryThrough:source('101'),feeCarryMode:'ephemeral_interval',
  feeIntervalComplete:true,feeAnchorsRechecked:false});
 assert.equal(unanchored.status,'unavailable');
});

test('fully replayed prospective profiles remain fork estimates and never enable action',()=>{
 const result=assessPaperCloseConvertPrestateGasGate({...ready,
  sampleSource:source('101'),feeCarryThrough:source('101'),feeCarryMode:'ephemeral_interval',
  feeIntervalComplete:true,feeAnchorsRechecked:true});
 assert.equal(result.status,'fork_estimated');assert.equal(result.evidenceAvailable,true);
 assert.equal(result.actionAvailable,false);
});

test('fee replay alone does not imply seven-stage sampler, importer, or worker readiness',()=>{
 const result=assessPaperCloseConvertPrestateGasGate({sampleSource:source('101'),
  feeCarryThrough:source('101'),feeCarryMode:'ephemeral_interval',feeIntervalComplete:true,
  feeAnchorsRechecked:true,sevenStageReplayVerified:false,prospectiveProfilesRegistered:false,
  terminalEnvelopeWorkerReplayVerified:false});
 assert.equal(result.status,'unavailable');
 assert.deepEqual(result.blockers,['seven_stage_owned_fork_replay_unavailable',
  'prospective_prestate_profiles_not_registered','terminal_envelope_worker_replay_unavailable']);
});
