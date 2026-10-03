import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import type {Hex} from 'viem';
import {createRangeKeeperLiveWalletWorker} from '../src/deployments/rangekeeper-live-wallet-worker.js';
import type {LiveJob,LiveOutbox,LiveWalletQueue} from '../src/deployments/live-wallet-queue.js';
import type {PilotIntent} from '../src/live-pilot/journal.js';

const intent={operator:'0x0000000000000000000000000000000000000001',chainId:4663,nonce:4,sourceBlock:'100',sourceHash:`0x${'1'.repeat(64)}`,deadline:9999999999} as unknown as PilotIntent;
const job={id:'job-1',chainId:4663,wallet:intent.operator,campaignId:'campaign-1',revision:1,allocationId:'allocation-1',reviewId:'review-1',
 kind:'open',status:'reconciling',priority:0,payload:{candidate:{expiresAt:Math.floor(Date.now()/1000)-1},policy:{config:{limits:{maxObservationGapSeconds:180}}}},payloadHash:'a'.repeat(64),buildId:'b'.repeat(64),idempotencyKey:'request',requestDigest:'c'.repeat(64),leaseToken:null,leaseUntil:null,attempt:1,resumeStage:'mint'} as LiveJob;
const outbox=(status:LiveOutbox['status'],raw:Hex|null=null,sourceTimestamp=Math.floor(Date.now()/1000),expiresAt?:number):LiveOutbox=>({jobId:job.id,stage:'mint',intent,plan:{},before:{wallet:{source:{block:intent.sourceBlock,hash:intent.sourceHash,timestamp:sourceTimestamp}},
 ...(expiresAt===undefined?{}:{authorization:{expiresAt}})},nonce:'4',status,raw,hash:raw?`0x${'2'.repeat(64)}`:null,
 receipt:status==='confirmed'||status==='reverted'?{receiptHash:'d'.repeat(64)}:null,effects:null,cleanup:null});
const wallet={chainId:4663 as const,address:intent.operator};
function harness(first:LiveOutbox|null,kind:LiveJob['kind']='open'){
 const calls:string[]=[],persisted=outbox('signed',`0x${'ab'.repeat(65)}` as Hex);
 const scopedJob={...job,kind} as LiveJob;
 const q={
  claimNext:async()=>({job:scopedJob,leaseToken:'lease',outbox:first}),
  prepareStage:async(_w:unknown,_id:string,_t:string,s:{stage:string;intent:PilotIntent;plan:unknown})=>outbox('prepared'),
  recordSigned:async()=>{calls.push('sign-persist');return outbox('signed',persisted.raw);},
  readPersistedRaw:async()=>({raw:persisted.raw!,hash:persisted.hash!,intent}),
  transition:async(_w:unknown,_id:string,_t:string,status:string)=>{calls.push(`transition:${status}`);},
  renewLease:async()=>{calls.push('renew');},
  yieldAfterConfirmedReceipt:async(_w:unknown,_id:string,stage:string)=>{calls.push(`yield:${stage}`);},
  reconcileStage:async()=>{calls.push('reconcile');return outbox('confirmed');},
  finish:async()=>{calls.push('finish');return {status:'succeeded'};},
 } as unknown as LiveWalletQueue;
  return {queue:q,calls,persisted,job:scopedJob};
}

describe('RangeKeeper live wallet worker kernel',()=>{
 it('recovers and republishes the exact persisted raw without signing again',async()=>{
  const h=harness(outbox('blocked',`0x${'ab'.repeat(65)}` as Hex));let signed=0,published='';
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true,publisherEnabled:true},adapters:{
   initializeOpeningCampaign:async()=>{},
   verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'complete'}),signIntent:async()=>{signed++;return `0x${'cd'.repeat(65)}` as Hex;},
   publishRaw:async raw=>{published=raw;return h.persisted.hash!;},waitForCanonicalReceipt:async()=>{},
   advanceCampaignEffect:async({effectId})=>{h.calls.push(`effect:${effectId}`);},
   completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'reconciled');assert.equal(signed,0);
  assert.equal(published,h.persisted.raw);assert(h.calls.includes('reconcile'));assert(h.calls.some(c=>c.startsWith('effect:')));
  assert(h.calls.includes('yield:mint'),'A confirmed stage yields its lease for immediate continuation');
  assert(h.calls.includes('renew'),'lease is renewed before persisted raw publication');
 });
 it('reconciles an already canonical receipt without publisher access',async()=>{
  const h=harness(outbox('signed',`0x${'ab'.repeat(65)}` as Hex));let publisherCalls=0,waitCalls=0,receiptChecks=0,effects=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:{
   initializeOpeningCampaign:async()=>{},verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'complete'}),signIntent:async()=>{throw Error('must not resign');},
   publishRaw:async()=>{publisherCalls++;throw Error('canonical transaction must not be republished');},
   hasCanonicalReceipt:async({hash})=>{receiptChecks++;assert.equal(hash,h.persisted.hash);return true;},
   waitForCanonicalReceipt:async()=>{waitCalls++;},advanceCampaignEffect:async()=>{effects++;},
   completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'reconciled');
  assert.equal(receiptChecks,1);assert.equal(publisherCalls,0);assert.equal(waitCalls,0);
  assert.equal(effects,1);assert(h.calls.includes('reconcile'));
  assert(h.calls.includes('yield:mint'));
 });
 it('signs only a prepared persisted intent and will not publish with the publisher gate closed',async()=>{
  const h=harness(outbox('prepared'));let signedIntent:PilotIntent|null=null,published=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true},adapters:{
   initializeOpeningCampaign:async()=>{},
   verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'stage',value:{stage:'mint',intent,plan:{}}}),
   signIntent:async value=>{signedIntent=value;return h.persisted.raw!;},publishRaw:async()=>{published++;return h.persisted.hash!;},
   waitForCanonicalReceipt:async()=>{},advanceCampaignEffect:async()=>{},
   completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'disabled');assert.equal(signedIntent,intent);
  assert.equal(published,0);assert(h.calls.includes('sign-persist'));
 });
 it('defaults both execution gates closed',async()=>{
  const h=harness(outbox('prepared'));let signerCalls=0,publisherCalls=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:{
   initializeOpeningCampaign:async()=>{},
   verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'stage',value:{stage:'mint',intent,plan:{}}}),
   signIntent:async()=>{signerCalls++;return h.persisted.raw!;},publishRaw:async()=>{publisherCalls++;return h.persisted.hash!;},
   waitForCanonicalReceipt:async()=>{},advanceCampaignEffect:async()=>{},
   completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.deepEqual(result,{status:'disabled',jobId:job.id,reason:'signer_disabled'});
  assert.equal(signerCalls,0);assert.equal(publisherCalls,0);
 });
 it('refuses a stale persisted unsigned source before invoking signer',async()=>{
  const h=harness(outbox('prepared',null,1));let signerCalls=0;
  (h.queue.claimNext as any)=async()=>({job,leaseToken:'lease',outbox:outbox('prepared',null,1)});
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true},adapters:{
   initializeOpeningCampaign:async()=>{},verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'stage',value:{stage:'mint',intent,plan:{}}}),
   signIntent:async()=>{signerCalls++;return h.persisted.raw!;},publishRaw:async()=>h.persisted.hash!,
   waitForCanonicalReceipt:async()=>{},advanceCampaignEffect:async()=>{},completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'blocked');assert.equal(signerCalls,0);
  assert(h.calls.includes('transition:blocked'));
 });
 it('loads the frozen campaign gap for management payloads without setup policy config',async()=>{
  const h=harness(outbox('prepared',null,Math.floor(Date.now()/1000)),'change_range');let gapReads=0,signerCalls=0;
  const managementJob={...h.job,payload:{kind:'rangekeeper_live_management_review',policy:{lastEligible:{block:'100'}}}} as LiveJob;
  (h.queue.claimNext as any)=async()=>({job:managementJob,leaseToken:'lease',outbox:outbox('prepared',null,Math.floor(Date.now()/1000))});
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true},adapters:{
   initializeOpeningCampaign:async()=>{},prepareManagementCampaign:async()=>{},
   sourceMaxObservationGapSeconds:async()=>{gapReads++;return 180;},verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'stage',value:{stage:'mint',intent,plan:{}}}),
   signIntent:async()=>{signerCalls++;return h.persisted.raw!;},publishRaw:async()=>h.persisted.hash!,
   waitForCanonicalReceipt:async()=>{},advanceCampaignEffect:async()=>{},completeOpeningLifecycle:async()=>{},
   recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.deepEqual(result,{status:'disabled',jobId:managementJob.id,reason:'publisher_disabled'});
  assert.equal(gapReads,1);assert.equal(signerCalls,1);
 });
 it('refuses an expired persisted stage capability even if the source is recent',async()=>{
  const h=harness(outbox('prepared',null,Math.floor(Date.now()/1000),Date.now()-1));let signerCalls=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true},adapters:{
   initializeOpeningCampaign:async()=>{},verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'stage',value:{stage:'mint',intent,plan:{}}}),
   signIntent:async()=>{signerCalls++;return h.persisted.raw!;},publishRaw:async()=>h.persisted.hash!,waitForCanonicalReceipt:async()=>{},
   advanceCampaignEffect:async()=>{},completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'blocked');assert.equal(signerCalls,0);
 });
 it('attributes a canonical reverted receipt before blocking the campaign',async()=>{
  const h=harness(outbox('signed',`0x${'ab'.repeat(65)}` as Hex)),effects:string[]=[];
  (h.queue.reconcileStage as any)=async()=>{h.calls.push('reconcile');return outbox('reverted');};
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{publisherEnabled:true},adapters:{
   initializeOpeningCampaign:async()=>{},verifyPreparedIntent:async()=>true,nextStage:async()=>({kind:'complete'}),
   signIntent:async()=>{throw Error('must not resign');},publishRaw:async()=>h.persisted.hash!,waitForCanonicalReceipt:async()=>{},
   advanceCampaignEffect:async({effectId})=>{effects.push(effectId);},completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'blocked');assert.equal(effects.length,1);
  assert(h.calls.includes('transition:blocked'));
  assert(!h.calls.some(c=>c.startsWith('yield:')),'A reverted receipt must retain blocked ownership');
 });
 it('prepares an admitted change-range campaign before recovering its receipt stages',async()=>{
  const h=harness(outbox('confirmed'), 'change_range');let prepared=0,effects=0,finished=0;
  (h.queue.finish as any)=async()=>{finished++;return {status:'succeeded',cleanup:{verified:true}};};
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:{
   initializeOpeningCampaign:async()=>{throw Error('management must not initialize a new campaign');},
   prepareManagementCampaign:async({job:managed})=>{prepared++;assert.equal(managed.kind,'change_range');},
   verifyPreparedIntent:async()=>true,nextStage:async()=>({kind:'complete'}),
   advanceCampaignEffect:async()=>{effects++;},completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
   completeManagedLifecycle:async()=>{throw Error('change-range must return to holding, not close the allocation');},
   waitForCanonicalReceipt:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'completed');assert.equal(prepared,1);assert.equal(effects,1);
  assert.equal(finished,1);
 });
 it('closes and releases only after the retained-exit cleanup succeeds',async()=>{
  const h=harness(outbox('confirmed'),'close_retain');let closed=0,prepared=0,finishDone=false;
  (h.queue.finish as any)=async()=>{finishDone=true;return {status:'succeeded',cleanup:{verified:true,custodyState:'closed_empty'}};};
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:{
   initializeOpeningCampaign:async()=>{throw Error('retained close must not initialize a new campaign');},
   prepareManagementCampaign:async({job:managed})=>{prepared++;assert.equal(managed.kind,'close_retain');},
   verifyPreparedIntent:async()=>true,nextStage:async()=>({kind:'complete'}),advanceCampaignEffect:async()=>{},
   completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},waitForCanonicalReceipt:async()=>{},
   completeManagedLifecycle:async({job:managed,cleanup})=>{assert(finishDone);assert.equal(managed.kind,'close_retain');
    assert.equal((cleanup as any).cleanup.custodyState,'closed_empty');closed++;},
  }});
  const result=await worker.execute();assert.equal(result.status,'completed');assert.equal(prepared,1);assert.equal(closed,1);
 });
 it('fails closed for unsupported pause/convert jobs without management authorization',async()=>{
  const h=harness(null,'pause');let planned=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:{
   initializeOpeningCampaign:async()=>{},nextStage:async()=>{planned++;return {kind:'complete'};},
   advanceCampaignEffect:async()=>{},verifyPreparedIntent:async()=>true,completeOpeningLifecycle:async()=>{},
   recoverFinishedOpenings:async()=>{},waitForCanonicalReceipt:async()=>{},
  }});
  const result=await worker.execute();assert.equal(result.status,'blocked');assert.equal(planned,0);
  assert(h.calls.includes('transition:blocked'));
 });
 it('runs the optional automatic-management observer only after recovery and before claiming queued work',async()=>{
  const h=harness(null),order:string[]=[];
  (h.queue.claimNext as any)=async()=>{order.push('claim');return null;};
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:{
   initializeOpeningCampaign:async()=>{},nextStage:async()=>({kind:'complete'}),advanceCampaignEffect:async()=>{},
   verifyPreparedIntent:async()=>true,completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{order.push('recover');},
   recoverFinishedManagement:async()=>{order.push('recover-management');},managementObservationReady:async()=>{order.push('ready');return true;},
   observeAndEnqueueManagement:async()=>{order.push('observe');},waitForCanonicalReceipt:async()=>{},
  }});
  assert.deepEqual(await worker.execute(),{status:'idle'});
  assert.deepEqual(order,['recover','recover-management','ready','observe','claim']);
 });
 it('does not run the automatic-management observer when durable work is unresolved',async()=>{
  const h=harness(null),order:string[]=[];(h.queue.claimNext as any)=async()=>{order.push('claim');return null;};
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:{
   initializeOpeningCampaign:async()=>{},nextStage:async()=>({kind:'complete'}),advanceCampaignEffect:async()=>{},
   verifyPreparedIntent:async()=>true,completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},
   managementObservationReady:async()=>false,observeAndEnqueueManagement:async()=>{order.push('observe');},
   waitForCanonicalReceipt:async()=>{},
  }});
  assert.deepEqual(await worker.execute(),{status:'idle'});assert.deepEqual(order,['claim']);
 });
});
