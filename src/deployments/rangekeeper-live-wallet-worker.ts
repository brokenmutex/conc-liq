import {contentHash} from './contracts.js';
import type {LiveJob,LiveOutbox,LiveWalletQueue} from './live-wallet-queue.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import type {PilotIntent} from '../live-pilot/journal.js';
import type {Hex} from 'viem';

export type RangeKeeperWorkerStage={stage:string;intent:PilotIntent;plan:unknown};
export type RangeKeeperNextStage={kind:'stage';value:RangeKeeperWorkerStage}|{kind:'complete'};
export interface RangeKeeperLiveWorkerAdapters {
 /** Idempotently create an entry-phase campaign state from its frozen review/allocation before planning. */
 initializeOpeningCampaign(input:{job:LiveJob}):Promise<void>;
 /** Consume an immutable management job into campaign state before preparing or recovering its first stage. */
 prepareManagementCampaign?(input:{job:LiveJob}):Promise<void>;
 /** Rebuild the next action from this campaign's persisted state. Queue authorization is still mandatory. */
 nextStage(input:{job:LiveJob;lastOutbox:LiveOutbox|null}):Promise<RangeKeeperNextStage>;
 /** Idempotent effect reducer keyed by effectId for every accepted stage receipt. */
 advanceCampaignEffect(input:{effectId:string;job:LiveJob;outbox:LiveOutbox}):Promise<void>;
 /** Reread pinned pool/reference proof before using a persisted unsigned intent. */
 verifyPreparedIntent(input:{job:LiveJob;outbox:LiveOutbox}):Promise<boolean>;
 /** Read the frozen, profile-specific observation-gap limit for a campaign. */
 sourceMaxObservationGapSeconds?(input:{job:LiveJob}):Promise<number>;
 /** Persist opening -> holding after finish has verified canonical cleanup. */
 completeOpeningLifecycle(input:{effectId:string;job:LiveJob;finalOutbox:LiveOutbox;cleanup:unknown}):Promise<void>;
 /** Mark a retained close terminal and release its allocation only after queue.finish cleanup proof. */
 completeManagedLifecycle?(input:{effectId:string;job:LiveJob;finalOutbox:LiveOutbox;cleanup:unknown}):Promise<void>;
 /** Replay the post-finish lifecycle effect after a crash between finish and its campaign-state write. */
 recoverFinishedOpenings():Promise<void>;
 /** Recover a close that finished its queue row before its terminal campaign event was committed. */
 recoverFinishedManagement?():Promise<void>;
 /** A source-bound wallet-wide observer may append valuations and enqueue at most one reviewed recenter/retain job. */
 managementObservationReady?():Promise<boolean>;
 observeAndEnqueueManagement?():Promise<void>;
 /** Wait for canonical inclusion/receipt after publishing the already-persisted raw bytes. */
 waitForCanonicalReceipt(input:{job:LiveJob;stage:string;hash:Hex}):Promise<void>;
 /** Return true only when this exact transaction has a receipt in a canonical,
  * sufficiently confirmed block. The queue still performs full receipt attribution. */
 hasCanonicalReceipt?(input:{job:LiveJob;stage:string;hash:Hex}):Promise<boolean>;
 signIntent?(intent:PilotIntent):Promise<Hex>;
 publishRaw?(raw:Hex):Promise<Hex>;
}
export interface RangeKeeperLiveWorkerOptions {
 /** Both gates default closed and must be set independently by a non-production harness. */
 signerEnabled?:boolean;
 publisherEnabled?:boolean;
 leaseMs?:number;
}
export type RangeKeeperWorkerResult=
 |{status:'idle'}|{status:'disabled';jobId:string;reason:'signer_disabled'|'publisher_disabled'}
 |{status:'prepared'|'published'|'reconciled'|'advanced'|'completed';jobId:string;stage?:string;effectId?:string}
 |{status:'blocked';jobId:string;reason:string};

/** A deliberately un-wired orchestration kernel. It has no key loading, RPC
 * sender, or production defaults; callers must explicitly inject both actions. */
export function createRangeKeeperLiveWalletWorker(input:{queue:LiveWalletQueue;wallet:LiveWalletIdentity;
 adapters:RangeKeeperLiveWorkerAdapters;options?:RangeKeeperLiveWorkerOptions}){
 const opts=input.options??{};
 const execute=async():Promise<RangeKeeperWorkerResult>=>{
  await input.adapters.recoverFinishedOpenings();
  await input.adapters.recoverFinishedManagement?.();
  if(input.adapters.managementObservationReady&&input.adapters.observeAndEnqueueManagement&&
   await input.adapters.managementObservationReady())await input.adapters.observeAndEnqueueManagement();
  const claim=await input.queue.claimNext(input.wallet,opts.leaseMs??300_000);
  if(!claim)return {status:'idle'};
  const {job,leaseToken}=claim;
  let outbox=claim.outbox;
  let finished=false;
  try{
   if(job.kind!=='open'&&job.kind!=='change_range'&&job.kind!=='close_retain'){
    await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox?.stage??undefined);
    return {status:'blocked',jobId:job.id,reason:'followup_operation_worker_unavailable'};
   }
   if(job.kind==='open')await input.adapters.initializeOpeningCampaign({job});
   else {
    if(!input.adapters.prepareManagementCampaign){
     await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox?.stage??undefined);
     return {status:'blocked',jobId:job.id,reason:'management_job_preparation_unavailable'};
    }
    await input.adapters.prepareManagementCampaign({job});
   }
   if(outbox?.status==='reverted'){
    const receiptHash=(outbox.receipt as any)?.receiptHash;
    if(typeof receiptHash!=='string'||!/^[0-9a-f]{64}$/.test(receiptHash))throw new Error('reverted_receipt_hash_missing');
    const effectId=contentHash({jobId:job.id,stage:outbox.stage,receiptHash});
    await input.adapters.advanceCampaignEffect({effectId,job,outbox});
    await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox.stage);
    return {status:'blocked',jobId:job.id,reason:'canonical_stage_reverted'};
   }
   if(outbox?.status==='confirmed'){
    const receiptHash=(outbox.receipt as any)?.receiptHash;
    if(typeof receiptHash!=='string'||! /^[0-9a-f]{64}$/.test(receiptHash))throw new Error('confirmed_receipt_hash_missing');
    const effectId=contentHash({jobId:job.id,stage:outbox.stage,receiptHash});
    await input.adapters.advanceCampaignEffect({effectId,job,outbox});
    // A lifecycle handoff is allowed only for an OPEN operation after the queue's
    // canonical cleanup proof. The store callback is idempotent by effectId.
    const next=await input.adapters.nextStage({job,lastOutbox:outbox});
    if(next.kind==='complete'){
     const cleanup=await input.queue.finish(input.wallet,job.id,leaseToken);
     finished=true;
     const lifecycleEffectId=contentHash({kind:`rangekeeper_${job.kind}_cleanup_complete`,jobId:job.id,stage:outbox.stage,receiptHash});
     if(job.kind==='open')await input.adapters.completeOpeningLifecycle({effectId:lifecycleEffectId,job,finalOutbox:outbox,cleanup});
     else if(job.kind==='close_retain'){
      if(!input.adapters.completeManagedLifecycle)throw new Error('retained_close_lifecycle_unavailable');
      await input.adapters.completeManagedLifecycle({effectId:lifecycleEffectId,job,finalOutbox:outbox,cleanup});
     }
     return {status:'completed',jobId:job.id,effectId:lifecycleEffectId};
    }
    outbox=await input.queue.prepareStage(input.wallet,job.id,leaseToken,next.value);
   }
   if(!outbox){
    const next=await input.adapters.nextStage({job,lastOutbox:null});
    if(next.kind==='complete')throw new Error('open_job_cannot_complete_without_verified_stage');
    outbox=await input.queue.prepareStage(input.wallet,job.id,leaseToken,next.value);
   }
   // Only a newly persisted authorized intent may be signed. Recovery of signed
   // bytes uses readPersistedRaw and never calls the signer again.
   if(outbox.status==='prepared'){
    if(opts.signerEnabled!==true||!input.adapters.signIntent)return {status:'disabled',jobId:job.id,reason:'signer_disabled'};
    const before=outbox.before as any,source=before?.wallet?.source,authorization=before?.authorization;
    const maxGap=input.adapters.sourceMaxObservationGapSeconds?
     await input.adapters.sourceMaxObservationGapSeconds({job}):
     (job.payload as any)?.policy?.config?.limits?.maxObservationGapSeconds;
    const nowMs=Date.now(),nowSeconds=Math.floor(nowMs/1000);
    if(!source||typeof source.timestamp!=='number'||String(source.block)!==outbox.intent.sourceBlock||
      String(source.hash).toLowerCase()!==outbox.intent.sourceHash.toLowerCase()||!Number.isSafeInteger(maxGap)||maxGap<=0||
      source.timestamp>nowSeconds||nowSeconds-source.timestamp>maxGap||
      (authorization?.expiresAt!==undefined&&(!Number.isSafeInteger(authorization.expiresAt)||authorization.expiresAt<=nowMs))||
      !await input.adapters.verifyPreparedIntent({job,outbox})){
     await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox.stage);
     return {status:'blocked',jobId:job.id,reason:'persisted_unsigned_intent_expired_or_source_changed'};
    }
    await input.queue.renewLease(input.wallet,job.id,leaseToken,opts.leaseMs??300_000);
    const raw=await input.adapters.signIntent(outbox.intent);
    await input.queue.recordSigned(input.wallet,job.id,outbox.stage,leaseToken,raw);
   }
   const persisted=await input.queue.readPersistedRaw(input.wallet,job.id,outbox.stage);
   if(!persisted)throw new Error('persisted_signed_transaction_missing');
   // A publisher may have accepted the raw transaction before the worker lost
   // its acknowledgement. Check canonical inclusion first to avoid getting stuck
   // retrying a mined transaction that now fails with already-known/nonce-too-low.
   const alreadyCanonical=await input.adapters.hasCanonicalReceipt?.({job,stage:outbox.stage,hash:persisted.hash})??false;
   if(!alreadyCanonical){
    if(opts.publisherEnabled!==true||!input.adapters.publishRaw)return {status:'disabled',jobId:job.id,reason:'publisher_disabled'};
    await input.queue.transition(input.wallet,job.id,leaseToken,'confirming',outbox.stage);
    await input.queue.renewLease(input.wallet,job.id,leaseToken,opts.leaseMs??300_000);
    const publishedHash=await input.adapters.publishRaw(persisted.raw);
    if(publishedHash.toLowerCase()!==persisted.hash.toLowerCase())throw new Error('publisher_hash_differs_from_persisted_raw');
    await input.adapters.waitForCanonicalReceipt({job,stage:outbox.stage,hash:persisted.hash});
   }
   const reconciled=await input.queue.reconcileStage(input.wallet,job.id,outbox.stage,leaseToken);
   const receiptHash=(reconciled.receipt as any)?.receiptHash;
   if(typeof receiptHash!=='string'||! /^[0-9a-f]{64}$/.test(receiptHash))throw new Error('canonical_receipt_hash_missing');
   const effectId=contentHash({jobId:job.id,stage:reconciled.stage,receiptHash});
   await input.adapters.advanceCampaignEffect({effectId,job,outbox:reconciled});
   if(reconciled.status!=='confirmed'){
    await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',reconciled.stage);
    return {status:'blocked',jobId:job.id,reason:'canonical_stage_reverted_after_cost_attribution'};
   }
   await input.queue.yieldAfterConfirmedReceipt(input.wallet,job.id,reconciled.stage,leaseToken);
   return {status:'reconciled',jobId:job.id,stage:reconciled.stage,effectId};
  }catch(error){
   const message=error instanceof Error?error.message:'worker_adapter_failed';
   if(!finished)try{await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox?.stage);}catch{}
   return {status:'blocked',jobId:job.id,reason:message};
  }
 };
 return {execute};
}
