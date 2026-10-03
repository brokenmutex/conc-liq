import {POSITION_MANAGER_WALLET_TRANSFER_SCHEMA_VERSION} from '../storage/compatibility.js';
import {DeploymentConflict} from './store.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import type {LiveWorkerReadiness} from './live-worker-readiness.js';
import type {RangeKeeperLiveReviewAdmissionResult} from './rangekeeper-live-review-admission.js';

/** Review persistence needs no new environment key: unset follows the schema
 * (on only when the exact v14 wallet-scoped schema and a valid operator wallet
 * were proven at startup), '0' always disables, and '1' keeps the earlier
 * explicit behaviour, whose runtime still fails closed below v14. */
export const resolveLiveReviewPersistence=(flag:'0'|'1'|undefined,liveSchemaReady:boolean):boolean=>
 flag==='0'?false:flag==='1'?true:liveSchemaReady;

export interface LiveCommandRuntime {
 retainPreview(campaignId:string):Promise<unknown>;
 retainOperation(campaignId:string,body:{previewId:string;contentDigest:string;expectedRevision:number;
  idempotencyKey:string}):Promise<RangeKeeperLiveReviewAdmissionResult>;
}

/** Command-side live surface. It reads the supervised worker's readiness proof
 * and, only on the proven v14 schema, queues reviewed retained exits through the
 * composed runtime. It never holds a signer or publisher and runs no DDL; below
 * v14 every callback reports a specific unavailable reason instead of throwing. */
export function createLiveCommandWiring(input:{schemaVersion:number;walletIdentity:LiveWalletIdentity|null;
 readiness:(wallet:LiveWalletIdentity)=>Promise<LiveWorkerReadiness>;createRuntime:()=>LiveCommandRuntime;
 onRuntimeFailure?:(error:unknown)=>void}){
 const schemaUnavailable=input.schemaVersion!==POSITION_MANAGER_WALLET_TRANSFER_SCHEMA_VERSION;
 let runtime:LiveCommandRuntime|null=null,failed=false;
 if(input.walletIdentity&&!schemaUnavailable){
  // Composition only; the caller supplies no execution and no management.
  try{runtime=input.createRuntime();}
  catch(error){failed=true;try{input.onRuntimeFailure?.(error);}catch{/* diagnostics never change availability */}}
 }
 const unavailableReason=schemaUnavailable?'live_runtime_or_wallet_history_schema_unavailable':
  !input.walletIdentity?'server_operator_wallet_address_invalid':
  failed?'live_retain_runtime_unavailable':null;
 const workerReadiness=async():Promise<LiveWorkerReadiness>=>{
  if(!input.walletIdentity||schemaUnavailable)
   return {ready:false,missing:[unavailableReason!]};
  try{return await input.readiness(input.walletIdentity);}
  catch{return {ready:false,missing:['live_worker_readiness_probe_failed']};}
 };
 let previewBusy=false;
 const retainPreview=async(campaignId:string)=>{
  if(!runtime)return {kind:'rangekeeper_live_retain_preview',mode:'live',strategyId:'rangekeeper_v1',
   status:'unavailable',trustedPreviewSaved:false,previewId:null,contentDigest:null,expectedRevision:0,expiresAt:null,
   source:null,position:null,costs:null,missing:[unavailableReason],actionAvailable:false,
   operationAcceptanceAvailable:false,executionEligible:false};
  // One owned fork at a time, as for the live setup review. This is per
  // request and releases at once, so a later exit attempt is never locked out.
  if(previewBusy)throw new DeploymentConflict('rangekeeper_live_retain_preview_busy');
  previewBusy=true;
  try{return await runtime.retainPreview(campaignId);}finally{previewBusy=false;}
 };
 const retainAdmission=async(campaignId:string,body:Parameters<LiveCommandRuntime['retainOperation']>[1]):
  Promise<RangeKeeperLiveReviewAdmissionResult>=>runtime?runtime.retainOperation(campaignId,body):
  {status:'unavailable',missing:[unavailableReason!],actionAvailable:false,executionEligible:false};
 return {workerReadiness,retainPreview,retainAdmission,runtimeAvailable:runtime!==null,unavailableReason};
}
