import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import type {Hex} from 'viem';
import {RangeKeeperLiveStaleManagementReviewError,createRangeKeeperLiveWalletWorker} from '../src/deployments/rangekeeper-live-wallet-worker.js';
import {RangeKeeperExitConversionUnavailableError,RangeKeeperStaleCandidateError} from '../src/strategy/rangekeeper/live-stage.js';
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
 const calls:string[]=[],retries:number[]=[],prepares:string[]=[],persisted=outbox('signed',`0x${'ab'.repeat(65)}` as Hex);
 const scopedJob={...job,kind} as LiveJob;
 const q={
  claimNext:async()=>({job:scopedJob,leaseToken:'lease',outbox:first}),
  prepareStage:async(_w:unknown,_id:string,_t:string,s:{stage:string;intent:PilotIntent;plan:unknown})=>{prepares.push(s.stage);return outbox('prepared');},
  cancelPrepared:async(_w:unknown,_id:string,stage:string)=>{calls.push(`cancel:${stage}`);},
  recordSigned:async()=>{calls.push('sign-persist');return outbox('signed',persisted.raw);},
  readPersistedRaw:async()=>({raw:persisted.raw!,hash:persisted.hash!,intent}),
  transition:async(_w:unknown,_id:string,_t:string,status:string,_stage?:string,retry?:number)=>{calls.push(`transition:${status}`);if(retry!==undefined)retries.push(retry);},
  renewLease:async()=>{calls.push('renew');},
  yieldAfterConfirmedReceipt:async(_w:unknown,_id:string,stage:string)=>{calls.push(`yield:${stage}`);},
  reconcileStage:async()=>{calls.push('reconcile');return outbox('confirmed');},
  finish:async()=>{calls.push('finish');return {status:'succeeded'};},
 } as unknown as LiveWalletQueue;
  return {queue:q,calls,retries,prepares,persisted,job:scopedJob};
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

 const baseAdapters=(over:Record<string,unknown>={})=>({initializeOpeningCampaign:async()=>{},prepareManagementCampaign:async()=>{},
  verifyPreparedIntent:async()=>true,nextStage:async()=>({kind:'complete' as const}),advanceCampaignEffect:async()=>{},
  completeOpeningLifecycle:async()=>{},recoverFinishedOpenings:async()=>{},waitForCanonicalReceipt:async()=>{},...over}) as any;
 it('cancels an expired unsigned intent so the next turn plans from fresh evidence, with a short retry',async()=>{
  const h=harness(outbox('prepared',null,1),'change_range');let signed=0;
  (h.queue.claimNext as any)=async()=>({job:h.job,leaseToken:'lease',outbox:outbox('prepared',null,1)});
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true},
   adapters:baseAdapters({signIntent:async()=>{signed++;return h.persisted.raw!;}})});
  const result=await worker.execute();assert.equal(result.status,'blocked');assert.equal(signed,0);
  assert(h.calls.includes('cancel:mint'));assert(h.calls.includes('transition:blocked'));assert.deepEqual(h.retries,[5_000]);
 });
 it('blocks a recenter awaiting a fresh plan without preparing a stage or touching the signer',async()=>{
  const h=harness(outbox('confirmed'),'change_range');let signed=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true,publisherEnabled:true},
   adapters:baseAdapters({nextStage:async()=>({kind:'wait',reason:'awaiting_replan'}),signIntent:async()=>{signed++;return h.persisted.raw!;},
    publishRaw:async()=>h.persisted.hash!})});
  const result=await worker.execute();
  assert.deepEqual(result,{status:'blocked',jobId:h.job.id,reason:'awaiting_replan'});
  assert.equal(h.prepares.length,0);assert.equal(signed,0);assert.deepEqual(h.retries,[30_000]);assert(!h.calls.some(c=>c.startsWith('yield:')));
 });
 it('settles a stale post-withdraw candidate into campaign state for a recenter only and never loops on it',async()=>{
  const stale=new RangeKeeperStaleCandidateError('Current swap would leave the approved range');
  const h=harness(outbox('confirmed'),'change_range');let settled=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({nextStage:async()=>{throw stale;},
   settleManagementStage:async({error}:{error:unknown})=>{settled++;assert.equal(error,stale);return {kind:'replan',reason:'stale_recenter_replan'};}})});
  const result=await worker.execute();assert.deepEqual(result,{status:'blocked',jobId:h.job.id,reason:'stale_recenter_replan'});
  assert.equal(settled,1);assert.equal(h.prepares.length,0);
  const closed=harness(outbox('confirmed'),'close_retain');
  const closeWorker=createRangeKeeperLiveWalletWorker({queue:closed.queue,wallet,adapters:baseAdapters({nextStage:async()=>{throw stale;},
   settleManagementStage:async()=>{throw Error('a retained close must not be settled as a recenter');}})});
  const closeResult=await closeWorker.execute();assert.equal(closeResult.status,'blocked');
  assert.equal((closeResult as any).reason,stale.message);
 });
 it('continues the same job as a retained exit after a recenter settles into one',async()=>{
  const h=harness(outbox('confirmed'),'change_range');let calls=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
   nextStage:async()=>{calls++;if(calls===1)throw new RangeKeeperStaleCandidateError('x');return {kind:'stage',value:{stage:'exit-approve',intent,plan:{}}};},
   settleManagementStage:async()=>({kind:'exit',reason:'repriced_mint_exit'})})});
  const result=await worker.execute();assert.equal(calls,2);assert.deepEqual(h.prepares,['exit-approve']);assert.equal(result.status,'disabled');
 });
 it('blocks a withdraw gas or cost bound failure with a clear reason and a slow retry instead of looping',async()=>{
  const h=harness(null,'change_range');
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{blockRetryMs:30_000},adapters:baseAdapters({
   nextStage:async()=>{throw new Error('Stage would invade reserved exit gas');}})});
  const result=await worker.execute();assert.equal(result.status,'blocked');
  assert.match((result as any).reason,/^stage_gas_or_cost_bound_exceeded: Stage would invade reserved exit gas/);
  assert(h.retries[0]!>=120_000,'a deterministic bound is retried slowly');assert.equal(h.prepares.length,0);
  const ordinary=harness(null,'change_range');
  const ordinaryWorker=createRangeKeeperLiveWalletWorker({queue:ordinary.queue,wallet,adapters:baseAdapters({nextStage:async()=>{throw Error('HTTP 503');}})});
  assert.equal((await ordinaryWorker.execute()).status,'blocked');assert.deepEqual(ordinary.retries,[30_000]);
 });
 it('does not let a failed recovery or observation pass stop a claimed exit or crash the loop',async()=>{
  const h=harness(outbox('confirmed'),'close_retain');let observed=0,closed=0;
  (h.queue.finish as any)=async()=>({status:'succeeded',cleanup:{verified:true,custodyState:'closed_empty'}});
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
   recoverFinishedOpenings:async()=>{throw Error('database unavailable');},recoverFinishedManagement:async()=>{throw Error('release failed');},
   managementObservationReady:async()=>true,observeAndEnqueueManagement:async()=>{observed++;throw Error('reference HTTP 503');},
   completeManagedLifecycle:async()=>{closed++;}})});
  const result=await worker.execute();assert.equal(result.status,'completed');assert.equal(observed,1);assert.equal(closed,1);
  assert.deepEqual(result.maintenanceErrors?.map(e=>e.split(':')[0]),['recover_finished_openings','recover_finished_management','management_observation']);
  const idle=harness(null);(idle.queue.claimNext as any)=async()=>null;
  const idleWorker=createRangeKeeperLiveWalletWorker({queue:idle.queue,wallet,adapters:baseAdapters({recoverFinishedOpenings:async()=>{throw Error('x');}})});
  const idleResult=await idleWorker.execute();assert.equal(idleResult.status,'idle');assert.equal(idleResult.maintenanceErrors?.length,1);
 });
 it('rejects a stale frozen management review before any stage exists instead of retrying it',async()=>{
  const h=harness(null,'change_range');
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
   prepareManagementCampaign:async()=>{throw new RangeKeeperLiveStaleManagementReviewError('Management review is stale or another state transition won');}})});
  const result=await worker.execute();assert.equal(result.status,'blocked');assert.match((result as any).reason,/management_review_rejected/);
  assert(h.calls.includes('transition:rejected'));assert(!h.calls.includes('transition:blocked'));
 });
 it('finishes a recenter that returned to holding with no lifecycle handoff, and one that exited as a close',async()=>{
  const holding=harness(outbox('confirmed'),'change_range');let handoffs=0;
  (holding.queue.finish as any)=async()=>({status:'succeeded',cleanup:{verified:true,custodyState:'managed'}});
  const adapters=baseAdapters({completeManagedLifecycle:async()=>{handoffs++;}});
  assert.equal((await createRangeKeeperLiveWalletWorker({queue:holding.queue,wallet,adapters}).execute()).status,'completed');assert.equal(handoffs,0);
  const exited=harness(outbox('confirmed'),'change_range');
  (exited.queue.finish as any)=async()=>({status:'succeeded',cleanup:{verified:true,custodyState:'closed_empty'}});
  assert.equal((await createRangeKeeperLiveWalletWorker({queue:exited.queue,wallet,adapters}).execute()).status,'completed');assert.equal(handoffs,1);
 });
 it('resumes a recenter stage after a restart from persisted bytes without signing or republishing a mined transaction',async()=>{
  const h=harness(outbox('signed',`0x${'ab'.repeat(65)}` as Hex),'change_range');let signed=0,published=0;
  const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{signerEnabled:true,publisherEnabled:true},adapters:baseAdapters({
   signIntent:async()=>{signed++;return `0x${'cd'.repeat(65)}`;},publishRaw:async()=>{published++;return h.persisted.hash!;},
   hasCanonicalReceipt:async()=>true})});
  const result=await worker.execute();assert.equal(result.status,'reconciled');assert.equal(signed,0);assert.equal(published,0);
  assert(h.calls.includes('reconcile'));assert(h.calls.includes('yield:mint'));
 });
 it('re-anchors an aged wallet snapshot before planning a management stage but never for an opening',async()=>{
  const order:string[]=[];
  const mk=(kind:LiveJob['kind'])=>{const h=harness(outbox('confirmed'),kind);
   return {h,worker:createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
    refreshWalletSnapshot:async({job:j}:{job:LiveJob})=>{order.push(`refresh:${j.kind}`);},
    nextStage:async()=>{order.push('next');return {kind:'wait',reason:'wait'};}})})};};
  await mk('change_range').worker.execute();await mk('open').worker.execute();
  assert.deepEqual(order,['refresh:change_range','next','next']);
 });

 describe('convert exit',()=>{
  it('prepares, plans, finishes and closes a convert job through the same management path as a retained close',async()=>{
   const h=harness(outbox('confirmed'),'close_convert');let prepared=0,closed=0,finishDone=false;
   (h.queue.finish as any)=async()=>{finishDone=true;return {status:'succeeded',cleanup:{verified:true,custodyState:'closed_empty'}};};
   const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
    initializeOpeningCampaign:async()=>{throw Error('a convert exit must not initialize a campaign');},
    prepareManagementCampaign:async({job:managed}:{job:LiveJob})=>{prepared++;assert.equal(managed.kind,'close_convert');},
    completeManagedLifecycle:async({job:managed,cleanup}:{job:LiveJob;cleanup:any})=>{assert(finishDone,'close only after the queue cleanup proof');
     assert.equal(managed.kind,'close_convert');assert.equal(cleanup.cleanup.custodyState,'closed_empty');closed++;}})});
   const result=await worker.execute();assert.equal(result.status,'completed');assert.equal(prepared,1);assert.equal(closed,1);
  });
  it('waits for a convert sale that cannot be planned yet, and degrades it to a retained exit the same job continues',async()=>{
   const unavailable=new RangeKeeperExitConversionUnavailableError('Exit pool/reference deviation');
   const h=harness(outbox('confirmed'),'close_convert');let calls=0,settled=0,mode:'wait'|'exit'='wait';
   const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
    nextStage:async()=>{calls++;if(mode==='wait'||calls%2===1)throw unavailable;return {kind:'stage',value:{stage:'exit-cleanup',intent,plan:{}}};},
    settleManagementStage:async({error}:{error:unknown})=>{settled++;assert.equal(error,unavailable);
     return mode==='wait'?{kind:'wait',reason:'convert_swap_unavailable_wait: Exit pool/reference deviation'}:{kind:'exit',reason:'convert_swap_unavailable_retained'};}})});
   let result=await worker.execute();
   assert.deepEqual(result,{status:'blocked',jobId:h.job.id,reason:'convert_swap_unavailable_wait: Exit pool/reference deviation'});
   assert.equal(h.prepares.length,0,'nothing is prepared or signed while the sale cannot be planned');
   mode='exit';calls=0;
   result=await worker.execute();assert.equal(settled,2);assert.deepEqual(h.prepares,['exit-cleanup'],'after the fallback the same job continues with the retained exit stages');
   assert.equal(result.status,'disabled');
  });
  it('does not settle other errors of a convert exit: they stay blocked with their own reason',async()=>{
   const h=harness(outbox('confirmed'),'close_convert');
   const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
    nextStage:async()=>{throw Error('HTTP 503 reference outage');},
    settleManagementStage:async()=>({kind:'unsettled'})})});
   const result=await worker.execute();assert.deepEqual(result,{status:'blocked',jobId:h.job.id,reason:'HTTP 503 reference outage'});
  });
  it('continues a convert exit after a reverted sale only when campaign state degraded to a retained exit',async()=>{
   const run=async(recovered:boolean|undefined)=>{
    const h=harness(outbox('reverted'),'close_convert');const effects:string[]=[];let closed=0,finished=0;
    (h.queue.finish as any)=async()=>{finished++;return {status:'succeeded',cleanup:{verified:true,custodyState:'closed_empty'}};};
    const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,adapters:baseAdapters({
     advanceCampaignEffect:async({effectId}:{effectId:string})=>{effects.push(effectId);},
     ...(recovered===undefined?{}:{revertedStageRecovered:async()=>recovered}),
     completeManagedLifecycle:async()=>{closed++;}})});
    return {result:await worker.execute(),h,effects,closed:()=>closed,finished:()=>finished};
   };
   const blocked=await run(false);
   assert.equal(blocked.result.status,'blocked');assert.equal((blocked.result as any).reason,'canonical_stage_reverted');
   assert.equal(blocked.finished(),0);assert.equal(blocked.closed(),0);
   assert.equal((await run(undefined)).result.status,'blocked','an adapter without the recovery hook never continues past a revert');
   const continued=await run(true);
   assert.equal(continued.result.status,'completed',JSON.stringify(continued.result));
   assert.equal(continued.finished(),1);assert.equal(continued.closed(),1);
   assert.equal(continued.effects.length,2,'the reverted receipt is attributed idempotently by both the revert and continuation turns');
   // A reverted receipt of any other job kind never takes this path, even if an adapter claims recovery.
   const retain=harness(outbox('reverted'),'close_retain');
   const retainWorker=createRangeKeeperLiveWalletWorker({queue:retain.queue,wallet,adapters:baseAdapters({revertedStageRecovered:async()=>true})});
   assert.equal((await retainWorker.execute()).status,'blocked');
  });
  it('re-checks a reverted sale soon after cost attribution instead of waiting out the full lease',async()=>{
   const h=harness(outbox('signed',`0x${'ab'.repeat(65)}` as Hex),'close_convert');
   (h.queue.reconcileStage as any)=async()=>{h.calls.push('reconcile');return outbox('reverted');};
   const worker=createRangeKeeperLiveWalletWorker({queue:h.queue,wallet,options:{publisherEnabled:true},adapters:baseAdapters({
    signIntent:async()=>{throw Error('must not resign');},publishRaw:async()=>h.persisted.hash!})});
   const result=await worker.execute();assert.equal(result.status,'blocked');assert.deepEqual(h.retries,[10_000]);
   const retain=harness(outbox('signed',`0x${'ab'.repeat(65)}` as Hex),'close_retain');
   (retain.queue.reconcileStage as any)=async()=>outbox('reverted');
   await createRangeKeeperLiveWalletWorker({queue:retain.queue,wallet,options:{publisherEnabled:true},adapters:baseAdapters({
    publishRaw:async()=>retain.persisted.hash!})}).execute();
   assert.deepEqual(retain.retries,[],'other job kinds keep their existing retry timing');
  });
 });
});
