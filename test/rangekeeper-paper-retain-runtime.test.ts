import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRangeKeeperPaperRetainPreview} from '../src/deployments/rangekeeper-paper-retain-runtime.js';

const campaignId='00000000-0000-4000-8000-000000000001';

test('retain preparation fails closed on missing persisted lineage and releases its lease',async()=>{
 let released=0,previewWrites=0;
 const store={
  acquirePaperPreparationLease:async()=>({assertHealthy:async()=>{},retainUntil:()=>{},
   release:async()=>{released++;}}),
  rangeKeeperPaperExitContextSnapshot:async()=>null,
  recordPreview:async()=>{previewWrites++;throw new Error('must not persist');},
 };
 const client={} as never;
 await assert.rejects(prepareRangeKeeperPaperRetainPreview({store:store as never,client,campaignId,
  buildId:'a'.repeat(64),rpcUrl:'http://127.0.0.1:8545'}),
  /rangekeeper_persisted_context_unavailable/);
 assert.equal(released,1);
 assert.equal(previewWrites,0);
});

test('retain preparation releases its lease when snapshot cannot seed canonical reading',async()=>{
 let released=0,snapshotReads=0;
 const store={
  acquirePaperPreparationLease:async()=>({assertHealthy:async()=>{throw new Error('lease_lost');},
   retainUntil:()=>{},release:async()=>{released++;}}),
  rangeKeeperPaperExitContextSnapshot:async()=>{snapshotReads++;return null;},
 };
 await assert.rejects(prepareRangeKeeperPaperRetainPreview({store:store as never,client:{} as never,
  campaignId,buildId:'a'.repeat(64),rpcUrl:'http://127.0.0.1:8545'}),
  /rangekeeper_persisted_context_unavailable/);
 assert.equal(snapshotReads,1);
 assert.equal(released,1);
});
