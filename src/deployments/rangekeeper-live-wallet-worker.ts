import {contentHash} from './contracts.js';
import type {LiveJob,LiveOutbox,LiveWalletQueue} from './live-wallet-queue.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import type {PilotIntent} from '../live-pilot/journal.js';
import type {Hex} from 'viem';

export type RangeKeeperWorkerStage={stage:string;intent:PilotIntent;plan:unknown};
/** `wait` is a campaign-local condition (awaiting a fresh replan, bounded mint wait): nothing is signed, the job
 * blocks with a short retry and yields the wallet to sibling campaigns meanwhile. */
export type RangeKeeperNextStage={kind:'stage';value:RangeKeeperWorkerStage}|{kind:'complete'}|{kind:'wait';reason:string;retryAfterMs?:number};
/** Outcome of settling a recoverable stage-planning error for a management job. `wait`/`replan` leave the job
 * blocked until fresh evidence exists; `exit` means campaign state became a retained exit the same job continues. */
export type RangeKeeperManagementSettlement={kind:'unsettled'}|{kind:'wait'|'replan'|'exit';reason:string};
/** A frozen management review that can no longer be applied to its campaign. Nothing was signed for it, so the
 * job is rejected and the planner re-plans from fresh evidence. */
export class RangeKeeperLiveStaleManagementReviewError extends Error {
 constructor(message:string){super(message);this.name='RangeKeeperLiveStaleManagementReviewError';}
}
const BOUND_REASON_PREFIX='stage_gas_or_cost_bound_exceeded';
const BOUND_RETRY_MS=120_000;
/** Stable, bounded operator-facing reason for a blocked job. */
export function describeRangeKeeperWorkerError(error:unknown):string{
 const message=error instanceof Error?error.message:'worker_adapter_failed';
 if(/exceeds .*(budget|cost policy|bounded transaction)|invade reserved exit gas|exit gas|native allocation|gas_bound/i.test(message))
  return `${BOUND_REASON_PREFIX}: ${message}`.slice(0,300);
 return message.slice(0,300);
}
export interface RangeKeeperLiveWorkerAdapters {
 /** Idempotently create an entry-phase campaign state from its frozen review/allocation before planning. */
 initializeOpeningCampaign(input:{job:LiveJob}):Promise<void>;
 /** Consume an immutable management job into campaign state before preparing or recovering its first stage. */
 prepareManagementCampaign?(input:{job:LiveJob}):Promise<void>;
 /** Rebuild the next action from this campaign's persisted state. Queue authorization is still mandatory. */
 nextStage(input:{job:LiveJob;lastOutbox:LiveOutbox|null}):Promise<RangeKeeperNextStage>;
 /** Persist a recoverable stale/infeasible stage condition as campaign state so it is never repeated blindly. */
 settleManagementStage?(input:{job:LiveJob;error:unknown}):Promise<RangeKeeperManagementSettlement>;
 /** Re-anchor the persisted whole-wallet snapshot before deriving a new stage when it has aged. No unresolved transaction may exist. */
 refreshWalletSnapshot?(input:{job:LiveJob}):Promise<void>;
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
 /** Retry delay for a blocked job whose condition may clear without operator action. */
 blockRetryMs?:number;
}
export type RangeKeeperWorkerResult=(
 |{status:'idle'}|{status:'disabled';jobId:string;reason:'signer_disabled'|'publisher_disabled'}
 |{status:'prepared'|'published'|'reconciled'|'advanced'|'completed';jobId:string;stage?:string;effectId?:string}
 |{status:'blocked';jobId:string;reason:string}
)&{
 /** Pre-claim maintenance (recovery, automatic management) failures. They never stop queued work from being claimed. */
 maintenanceErrors?:string[];
};

const DEFAULT_BLOCK_RETRY_MS=30_000;
const REVERTED_RETRY_MS=300_000;

/** A deliberately un-wired orchestration kernel. It has no key loading, RPC
 * sender, or production defaults; callers must explicitly inject both actions. */
export function createRangeKeeperLiveWalletWorker(input:{queue:LiveWalletQueue;wallet:LiveWalletIdentity;
 adapters:RangeKeeperLiveWorkerAdapters;options?:RangeKeeperLiveWorkerOptions}){
 const opts=input.options??{};
 const blockRetryMs=opts.blockRetryMs??DEFAULT_BLOCK_RETRY_MS;
 const execute=async():Promise<RangeKeeperWorkerResult>=>{
  const maintenance:string[]=[];
  // Recovery and observation are best effort: a failure there must not prevent an existing job (for example a
  // sibling campaign's retained exit) from being claimed, and must not crash a supervising process loop.
  const guarded=async(name:string,run:()=>Promise<unknown>)=>{
   try{await run();}catch(error){maintenance.push(`${name}:${describeRangeKeeperWorkerError(error)}`);}
  };
  await guarded('recover_finished_openings',()=>input.adapters.recoverFinishedOpenings());
  await guarded('recover_finished_management',async()=>{await input.adapters.recoverFinishedManagement?.();});
  if(input.adapters.managementObservationReady&&input.adapters.observeAndEnqueueManagement)
   await guarded('management_observation',async()=>{
    if(await input.adapters.managementObservationReady!())await input.adapters.observeAndEnqueueManagement!();
   });
  const done=(result:RangeKeeperWorkerResult):RangeKeeperWorkerResult=>maintenance.length?{...result,maintenanceErrors:maintenance}:result;
  const claim=await input.queue.claimNext(input.wallet,opts.leaseMs??300_000);
  if(!claim)return done({status:'idle'});
  const {job,leaseToken}=claim;
  let outbox=claim.outbox;
  let finished=false;
  const block=async(reason:string,stage?:string,retryAfterMs=blockRetryMs):Promise<RangeKeeperWorkerResult>=>{
   await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',stage,retryAfterMs);
   return done({status:'blocked',jobId:job.id,reason});
  };
  try{
   if(job.kind!=='open'&&job.kind!=='change_range'&&job.kind!=='close_retain'){
    await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox?.stage??undefined);
    return done({status:'blocked',jobId:job.id,reason:'followup_operation_worker_unavailable'});
   }
   if(job.kind==='open')await input.adapters.initializeOpeningCampaign({job});
   else {
    if(!input.adapters.prepareManagementCampaign){
     await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox?.stage??undefined);
     return done({status:'blocked',jobId:job.id,reason:'management_job_preparation_unavailable'});
    }
    await input.adapters.prepareManagementCampaign({job});
   }
   // Plan the next stage. A recoverable stale/infeasible recenter condition is settled into campaign state
   // (never repeating a completed withdrawal or swap) instead of looping on the same failure.
   const planNext=async(last:LiveOutbox|null):Promise<RangeKeeperNextStage>=>{
    if(job.kind!=='open')await input.adapters.refreshWalletSnapshot?.({job});
    try{return await input.adapters.nextStage({job,lastOutbox:last});}
    catch(error){
     const settle=job.kind==='change_range'?input.adapters.settleManagementStage:undefined;
     if(!settle)throw error;
     const settled=await settle({job,error});
     if(settled.kind==='wait'||settled.kind==='replan')return {kind:'wait',reason:settled.reason};
     if(settled.kind==='exit')return input.adapters.nextStage({job,lastOutbox:last});
     throw error;
    }
   };
   if(outbox?.status==='reverted'){
    const receiptHash=(outbox.receipt as any)?.receiptHash;
    if(typeof receiptHash!=='string'||!/^[0-9a-f]{64}$/.test(receiptHash))throw new Error('reverted_receipt_hash_missing');
    const effectId=contentHash({jobId:job.id,stage:outbox.stage,receiptHash});
    await input.adapters.advanceCampaignEffect({effectId,job,outbox});
    return block('canonical_stage_reverted',outbox.stage,REVERTED_RETRY_MS);
   }
   if(outbox?.status==='confirmed'){
    const receiptHash=(outbox.receipt as any)?.receiptHash;
    if(typeof receiptHash!=='string'||! /^[0-9a-f]{64}$/.test(receiptHash))throw new Error('confirmed_receipt_hash_missing');
    const effectId=contentHash({jobId:job.id,stage:outbox.stage,receiptHash});
    await input.adapters.advanceCampaignEffect({effectId,job,outbox});
    // A lifecycle handoff is allowed only after the queue's canonical cleanup proof. Opening and retained
    // closes (including a recenter that settled into a retained exit) hand off; the store callback is idempotent by effectId.
    const next=await planNext(outbox);
    if(next.kind==='wait')return block(next.reason,outbox.stage,next.retryAfterMs);
    if(next.kind==='complete'){
     const cleanup=await input.queue.finish(input.wallet,job.id,leaseToken);
     finished=true;
     const lifecycleEffectId=contentHash({kind:`rangekeeper_${job.kind}_cleanup_complete`,jobId:job.id,stage:outbox.stage,receiptHash});
     const custodyState=((cleanup as any)?.cleanup??cleanup as any)?.custodyState;
     if(job.kind==='open')await input.adapters.completeOpeningLifecycle({effectId:lifecycleEffectId,job,finalOutbox:outbox,cleanup});
     else if(job.kind==='close_retain'||job.kind==='change_range'&&custodyState==='closed_empty'){
      if(!input.adapters.completeManagedLifecycle)throw new Error('retained_close_lifecycle_unavailable');
      await input.adapters.completeManagedLifecycle({effectId:lifecycleEffectId,job,finalOutbox:outbox,cleanup});
     }
     return done({status:'completed',jobId:job.id,effectId:lifecycleEffectId});
    }
    outbox=await input.queue.prepareStage(input.wallet,job.id,leaseToken,next.value);
   }
   if(!outbox){
    const next=await planNext(null);
    if(next.kind==='wait')return block(next.reason,undefined,next.retryAfterMs);
    if(next.kind==='complete')throw new Error('open_job_cannot_complete_without_verified_stage');
    outbox=await input.queue.prepareStage(input.wallet,job.id,leaseToken,next.value);
   }
   // Only a newly persisted authorized intent may be signed. Recovery of signed
   // bytes uses readPersistedRaw and never calls the signer again.
   if(outbox.status==='prepared'){
    if(opts.signerEnabled!==true||!input.adapters.signIntent)return done({status:'disabled',jobId:job.id,reason:'signer_disabled'});
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
     // An unsigned intent was never handed to a publisher, so its nonce is free. Cancel it so the next turn derives a
     // fresh stage from current canonical evidence instead of retrying an expired proposal forever.
     await input.queue.cancelPrepared(input.wallet,job.id,outbox.stage,leaseToken);
     return block('persisted_unsigned_intent_expired_or_source_changed',outbox.stage,5_000);
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
    if(opts.publisherEnabled!==true||!input.adapters.publishRaw)return done({status:'disabled',jobId:job.id,reason:'publisher_disabled'});
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
    return done({status:'blocked',jobId:job.id,reason:'canonical_stage_reverted_after_cost_attribution'});
   }
   await input.queue.yieldAfterConfirmedReceipt(input.wallet,job.id,reconciled.stage,leaseToken);
   return done({status:'reconciled',jobId:job.id,stage:reconciled.stage,effectId});
  }catch(error){
   const message=describeRangeKeeperWorkerError(error);
   // Nothing was signed for a stale frozen review: reject it so the planner re-plans from fresh evidence.
   if(error instanceof RangeKeeperLiveStaleManagementReviewError&&!outbox){
    try{await input.queue.transition(input.wallet,job.id,leaseToken,'rejected');
     return done({status:'blocked',jobId:job.id,reason:`management_review_rejected: ${message}`});}catch{/* fall through to a plain block */}
   }
   // A deterministic gas/cost bound fails identically on every retry, and each retry costs an owned-fork simulation:
   // keep the job blocked with a clear reason and retry slowly (fees and budgets can change) instead of looping.
   const retryMs=message.startsWith(BOUND_REASON_PREFIX)?Math.max(blockRetryMs,BOUND_RETRY_MS):blockRetryMs;
   if(!finished)try{await input.queue.transition(input.wallet,job.id,leaseToken,'blocked',outbox?.stage,retryMs);}catch{}
   return done({status:'blocked',jobId:job.id,reason:message});
  }
 };
 return {execute};
}
