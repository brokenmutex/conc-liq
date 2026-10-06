import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {parseRangeKeeperJson,rangeKeeperJson,type RangeKeeperLiveState,type RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {contentHash} from './contracts.js';
import {readRangeKeeperLiveCampaign} from './rangekeeper-live-campaign-store.js';
import {assertConvertConversionEvidence,assertRangeKeeperLiveCampaignBuildCompatible,deriveRangeKeeperLiveManagementTransition,type RangeKeeperLiveCampaign,type RangeKeeperLiveManagementReviewPayload,
 deriveRangeKeeperLiveClosedState,type RangeKeeperStageReferences} from './rangekeeper-live-campaign.js';
import {lookupLiveJobByRequest,readReview,readWalletState,recordReview,type LiveWalletIdentity} from './live-wallet-store.js';

export type RangeKeeperLiveClosePreviewKind='rangekeeper_live_retain_preview'|'rangekeeper_live_convert_preview';
export interface RangeKeeperLiveManagementPreview {
 kind:RangeKeeperLiveClosePreviewKind;mode:'live';strategyId:'rangekeeper_v1';status:'indicative'|'unavailable';
 trustedPreviewSaved:boolean;previewId:string|null;contentDigest:string|null;expectedRevision:number;expiresAt:string|null;
 source:RangeKeeperLiveManagementReviewPayload['source']|null;position:unknown;costs:unknown;missing:string[];
 actionAvailable:boolean;operationAcceptanceAvailable:boolean;executionEligible:false;
}
export interface RangeKeeperLiveManagementReviewInput {
 wallet:LiveWalletIdentity;campaign:RangeKeeperLiveCampaign;operationKind:'close_retain'|'close_convert'|'change_range';
 source:{block:string;hash:string;timestamp:number};snapshot:RangeKeeperSnapshot;references:RangeKeeperStageReferences;
 position:unknown;decision:{reason:string;observationHash:string};candidate:RangeKeeperCandidate|null;policy:RangeKeeperState|null;
 costs:unknown;missing?:readonly string[];expiresAt:number;
}
export interface RangeKeeperLiveManagementQueueInput extends LiveWalletIdentity {
 campaignId:string;revision:number;allocationId:string;reviewId:string;kind:'change_range'|'close_retain'|'close_convert';
 /** Exact JSON-safe payload read from the immutable review row. Decode markers
  * only for validation; passing decoded BigInts to the queue breaks its JSON hash. */
 payload:unknown;buildId:string;idempotencyKey:string;requestDigest:string;
}
const previewKindFor=(operationKind:'close_retain'|'close_convert'|'change_range'):RangeKeeperLiveClosePreviewKind=>
 operationKind==='close_convert'?'rangekeeper_live_convert_preview':'rangekeeper_live_retain_preview';
const unavailable=(campaign:RangeKeeperLiveCampaign,missing:string[],kind:RangeKeeperLiveClosePreviewKind='rangekeeper_live_retain_preview'):RangeKeeperLiveManagementPreview=>({
 kind,mode:'live',strategyId:'rangekeeper_v1',status:'unavailable',trustedPreviewSaved:false,
 previewId:null,contentDigest:null,expectedRevision:campaign.revision,expiresAt:null,source:null,position:null,costs:null,
 missing:[...new Set(missing)],actionAvailable:false,operationAcceptanceAvailable:false,executionEligible:false,
});
const sameSource=(a:any,b:any)=>String(a?.block)===String(b?.block)&&String(a?.hash).toLowerCase()===String(b?.hash).toLowerCase()&&
 Number(a?.timestamp)===Number(b?.timestamp);
const validHash=(s:unknown)=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
const jsonSafe=(value:unknown)=>JSON.parse(rangeKeeperJson(value));
function validBoundCost(value:unknown,source:{block:string;hash:string;timestamp:number}):boolean{
 const c=value as any;if(!c||c.status!=='estimated'||c.provenance!=='owned_fork_allocated_lifecycle_v1'||!sameSource(c.source,source))return false;
 const gas=c.gasWei??c.stageGasWei??c.actionGasWei,cost=c.gasValueUsdX18??c.costValue??c.actionCostValue;
 return typeof gas==='string'&&/^[1-9][0-9]*$/.test(gas)&&typeof cost==='string'&&/^[1-9][0-9]*$/.test(cost);
}
export function parseRangeKeeperLiveManagementReviewPayload(value:unknown):RangeKeeperLiveManagementReviewPayload{
 const parsed=parseRangeKeeperJson<RangeKeeperLiveManagementReviewPayload>(value);
 assert(parsed&&parsed.schemaVersion===1&&parsed.kind==='rangekeeper_live_management_review'&&
  (parsed.operationKind==='close_retain'||parsed.operationKind==='close_convert'||parsed.operationKind==='change_range'),
  'Invalid persisted live management review');
 return parsed;
}

/** Persist an immutable management review for an existing allocation. The
 * supplied verifier must reread canonical pool/wallet/NFT/reference evidence;
 * this method never refreshes the wallet snapshot or reserves capital. */
export async function recordRangeKeeperLiveManagementReview(pool:Pool,input:RangeKeeperLiveManagementReviewInput,
 deps:{buildId:string;verifyPinned:(campaign:RangeKeeperLiveCampaign,payload:RangeKeeperLiveManagementReviewPayload)=>Promise<boolean>;
  now?:()=>number}):Promise<RangeKeeperLiveManagementPreview>{
 const missing=[...(input.missing??[])];
 try{
  const {campaign:c,wallet}=input;
  assert(c.state&&c.stateHash&&c.status==='active','Campaign runtime is not in active management state');
  assert(input.operationKind==='close_retain'||input.operationKind==='close_convert'||input.operationKind==='change_range');
  assert(c.state.phase==='holding'&&c.state.activeTokenId!==null,'Management review requires a held position');
  assert(wallet.chainId===4663&&wallet.address.toLowerCase()===c.wallet.toLowerCase(),'Management wallet identity mismatch');
  assert(input.references.source.block===input.source.block&&input.references.source.hash.toLowerCase()===input.source.hash.toLowerCase()&&
   input.references.source.timestamp===input.source.timestamp&&input.references.proofHash.length===64,'Reference evidence source mismatch');
  assert(sameSource(input.source,input.snapshot.source),'Pool snapshot source mismatch');
  assert(validHash(input.decision.observationHash),'Management decision observation hash is malformed');
  assert(Number.isSafeInteger(input.expiresAt)&&(deps.now??Date.now)()<input.expiresAt*1000,'Management review is expired');
  if(input.operationKind==='change_range')assert(input.candidate?.kind==='recenter'&&input.policy,'Recenter candidate/policy missing');
  else assert(input.candidate===null,'A close cannot include a replacement candidate');
  if(!validBoundCost(input.costs,input.source))missing.push('owned_fork_management_cost_unavailable');
  if(input.operationKind==='close_convert')assertConvertConversionEvidence(input.costs,c.config.pool,c.config.limits);
  if(missing.length) return unavailable(c,missing,previewKindFor(input.operationKind));
  const state=await readWalletState(pool,wallet);
  assert(state.status==='available'&&state.source&&state.commitmentsHash&&state.snapshotHash,'Persisted wallet inventory is unavailable');
  assert(state.source.block===input.source.block&&state.source.hash.toLowerCase()===input.source.hash.toLowerCase()&&
   state.source.timestamp===input.source.timestamp,'Wallet inventory source differs from management review');
  assert(state.nonce!==null&&state.nonce===state.pendingNonce&&String(input.snapshot.nonce)===state.nonce,
   'Canonical/pending nonce is not settled');
  assert(Number.isSafeInteger(c.allocation.sourceGeneration)&&c.allocation.sourceGeneration>0&&
   c.allocation.sourceGeneration<=state.generation,'Campaign allocation generation is invalid');
  // The review binds to the build running now. Cross-build compatibility is decided by what determines behaviour: the
  // profile and config hashes, the strategy/state versions and whether the persisted state parses under this build.
  const profileHash=contentHash(c.profile),buildId=deps.buildId;
  assert(profileHash===c.profileHash,'Registered profile changed');
  assertRangeKeeperLiveCampaignBuildCompatible(c);
  const payload:RangeKeeperLiveManagementReviewPayload={schemaVersion:1,kind:'rangekeeper_live_management_review',mode:'live',
   strategyId:'rangekeeper_v1',operationKind:input.operationKind,campaignId:c.id,revision:c.revision,allocationId:c.allocation.allocationId,
   profileId:c.profileId,profileHash:c.profileHash,configHash:c.configHash.slice(2),buildId,campaignBuildId:c.state.buildId,runtimeStateHash:c.stateHash,
   stateRevision:c.stateRevision,wallet:{address:state.address,generation:state.generation,commitmentsHash:state.commitmentsHash,nonce:state.nonce},
   source:input.source,snapshot:input.snapshot,reference:{proofHash:input.references.proofHash,price0:String(input.references.price0),
    price1:String(input.references.price1),nativePrice:String(input.references.nativePrice),evidence:input.references.evidence},position:input.position,
   decision:input.decision,candidate:input.candidate,policy:input.policy,costs:input.costs,expiresAt:input.expiresAt};
  // Persist bigint-heavy frozen state through the same marker codec as runtime
  // events, so PostgreSQL JSONB and review hashes remain deterministic.
  const persistedPayload=jsonSafe(payload) as RangeKeeperLiveManagementReviewPayload;
  deriveRangeKeeperLiveManagementTransition(c,parseRangeKeeperJson<RangeKeeperLiveManagementReviewPayload>(persistedPayload));
  assert(await deps.verifyPinned(c,parseRangeKeeperLiveManagementReviewPayload(persistedPayload)),
   'Pinned management proof could not be revalidated');
  const reviewId=randomUUID(),payloadHash=contentHash(persistedPayload);
  await recordReview(pool,{...wallet,reviewId,payload:persistedPayload,payloadHash,buildId,source:input.source,expiresAt:new Date(input.expiresAt*1000),
   walletGeneration:state.generation,commitmentsHash:state.commitmentsHash});
  return {kind:previewKindFor(input.operationKind),mode:'live',strategyId:'rangekeeper_v1',status:'indicative',trustedPreviewSaved:true,
   previewId:reviewId,contentDigest:payloadHash,expectedRevision:c.revision,expiresAt:new Date(input.expiresAt*1000).toISOString(),
   source:input.source,position:input.position,costs:input.costs,missing:[],actionAvailable:true,
   operationAcceptanceAvailable:true,executionEligible:false};
 }catch(error){
  const message=error instanceof Error?error.message:'live_management_review_unavailable';
  return unavailable(input.campaign,[message],previewKindFor(input.operationKind));
 }
}

export type RangeKeeperLiveManagementAdmissionResult=
 |{status:'queued';campaignId:string;jobId:string;allocationId?:string;replayed:boolean;executionEligible:false;
   reason:'rangekeeper_live_execution_unavailable'}
 |{status:'unavailable';missing:readonly string[];actionAvailable:false;executionEligible:false}
 |{status:'request_conflict';requestId:string;missing:readonly ['live_request_id_conflict'];executionEligible:false};

/** Consume a frozen management review into the existing wallet-wide queue.
 * The same idempotency key/digest replays the same job; no allocation rows are
 * added and the original setup review is never treated as an approval. */
export async function enqueueRangeKeeperLiveManagementReview(input:{wallet:LiveWalletIdentity;campaignId:string;previewId:string;
 contentDigest:string;expectedRevision:number;idempotencyKey:string;expectedOperationKind?:'close_retain'|'close_convert'|'change_range'},deps:{pool:Pool;buildId:string;now?:()=>number;
 verifyPinned:(campaign:RangeKeeperLiveCampaign,payload:RangeKeeperLiveManagementReviewPayload)=>Promise<boolean>;
 /** Convert exits only: re-validate the sale against a freshly read canonical source (pool within the reference policy and
  * a quote within the shortfall limit) before queueing. Absent, a convert admission fails closed. */
 verifyConvertFresh?:(campaign:RangeKeeperLiveCampaign,payload:RangeKeeperLiveManagementReviewPayload)=>Promise<boolean>;
 enqueue:(job:RangeKeeperLiveManagementQueueInput)=>Promise<{campaignId:string;jobId:string;allocationId?:string;replayed:boolean;status:string}>}):Promise<
 RangeKeeperLiveManagementAdmissionResult&{requestDigest?:string;reviewId?:string;contentDigest?:string}>{
 const unavailableResult=(...missing:string[]):RangeKeeperLiveManagementAdmissionResult=>({status:'unavailable',
  missing:[...new Set(missing)],actionAvailable:false,executionEligible:false});
 try{
  assert(/^0x[0-9a-fA-F]{40}$/.test(input.wallet.address)&&input.wallet.chainId===4663);
  assert(/^[0-9a-f]{64}$/.test(input.contentDigest)&&/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey));
  // A convert request is bound to its operation kind, so a retain request key can never replay as a convert (or back).
  const requestDigest=contentHash({kind:'rangekeeper_live_management_request_v1',campaignId:input.campaignId,
   expectedRevision:input.expectedRevision,previewId:input.previewId,contentDigest:input.contentDigest,
   ...(input.expectedOperationKind==='close_convert'?{operationKind:'close_convert'}:{})});
  const prior=await lookupLiveJobByRequest(deps.pool,{...input.wallet,requestId:input.idempotencyKey,requestDigest});
  if(prior)return {status:'queued',campaignId:prior.campaignId,jobId:prior.jobId,allocationId:prior.allocationId,
   replayed:true,executionEligible:false,reason:'rangekeeper_live_execution_unavailable',requestDigest};
  const review=await readReview(deps.pool,{...input.wallet,reviewId:input.previewId});assert(review,'Management preview not found');
  assert(contentHash(review.payload)===review.payloadHash&&review.payloadHash===input.contentDigest,'Management preview digest changed');
  const payload=parseRangeKeeperLiveManagementReviewPayload(review.payload);
  assert(payload.kind==='rangekeeper_live_management_review'&&payload.campaignId===input.campaignId&&
   payload.revision===input.expectedRevision&&(!input.expectedOperationKind||payload.operationKind===input.expectedOperationKind)&&
   payload.expiresAt*1000>(deps.now??Date.now)(),
   'Management preview is stale, expired, or bound to another campaign');
  assert(review.buildId===deps.buildId&&payload.buildId===deps.buildId,'Runtime build changed after management preview');
  const campaign=await readRangeKeeperLiveCampaign(deps.pool,{...input.wallet,campaignId:input.campaignId,revision:input.expectedRevision});
  assert(campaign.stateHash===payload.runtimeStateHash&&campaign.stateRevision===payload.stateRevision&&
   campaign.allocation.allocationId===payload.allocationId,'Campaign changed after management preview');
  const state=await readWalletState(deps.pool,input.wallet);
  assert(state.status==='available'&&state.generation===payload.wallet.generation&&state.commitmentsHash===payload.wallet.commitmentsHash&&
   state.source&&sameSource(state.source,payload.source)&&state.nonce===payload.wallet.nonce&&state.pendingNonce===payload.wallet.nonce,
   'Wallet changed after management preview');
  deriveRangeKeeperLiveManagementTransition(campaign,payload);
  assert(await deps.verifyPinned(campaign,payload),'Management preview canonical evidence could not be revalidated');
  if(payload.operationKind==='close_convert')
   assert(deps.verifyConvertFresh&&await deps.verifyConvertFresh(campaign,payload),
    'Convert exit could not be re-validated against a fresh canonical source');
  const result=await deps.enqueue({...input.wallet,campaignId:campaign.id,revision:campaign.revision,allocationId:campaign.allocation.allocationId,
   reviewId:review.reviewId,kind:payload.operationKind,payload:review.payload,buildId:deps.buildId,idempotencyKey:input.idempotencyKey,requestDigest});
  return {status:'queued',campaignId:result.campaignId,jobId:result.jobId,allocationId:result.allocationId,
   replayed:result.replayed,executionEligible:false,reason:'rangekeeper_live_execution_unavailable',requestDigest,
   reviewId:review.reviewId,contentDigest:review.payloadHash};
 }catch(error){
  const message=error instanceof Error?error.message:'live_management_admission_unavailable';
  if(message.includes('IDEMPOTENCY_CONFLICT'))return {status:'request_conflict',requestId:input.idempotencyKey,
   missing:['live_request_id_conflict'],executionEligible:false};
  return unavailableResult(message);
 }
}

export async function admitRangeKeeperLiveManagement(input:{wallet:LiveWalletIdentity;campaignId:string;previewId:string;
 contentDigest:string;expectedRevision:number;idempotencyKey:string},deps:Parameters<typeof enqueueRangeKeeperLiveManagementReview>[1],
 operationKind:'close_retain'|'close_convert'='close_retain'){
 const result=await enqueueRangeKeeperLiveManagementReview({...input,expectedOperationKind:operationKind},deps);
 if(result.status==='queued'){
  const {reviewId,contentDigest,requestDigest,...publicResult}=result;return publicResult;
 }
 return result;
}

export interface RangeKeeperLiveManagementObservation {
 source:RangeKeeperLiveManagementReviewInput['source'];snapshot:RangeKeeperSnapshot;references:RangeKeeperStageReferences;
 position:unknown;decision:RangeKeeperLiveManagementReviewInput['decision'];costs:unknown;missing?:readonly string[];
 candidate?:RangeKeeperCandidate|null;policy?:RangeKeeperState|null;expiresAt:number;positionFeeEvidence?:unknown|null;
}
/** Server composition for campaign-addressed management reviews. The observer
 * is injected from the existing canonical wallet/reference runtime; this
 * module only freezes and admits its evidence through the existing ledger. */
export function createRangeKeeperLiveManagementRuntime(input:{pool:Pool;wallet:LiveWalletIdentity;buildId:string;
 persistReviews?:boolean;observe:(campaign:RangeKeeperLiveCampaign)=>Promise<RangeKeeperLiveManagementObservation>;
 /** Observation priced as a convert exit (withdraw plus sale of the non-quote leg into the quote token). */
 observeConvert?:(campaign:RangeKeeperLiveCampaign)=>Promise<RangeKeeperLiveManagementObservation>;
 verifyPinned:(campaign:RangeKeeperLiveCampaign,payload:RangeKeeperLiveManagementReviewPayload)=>Promise<boolean>;
 verifyConvertFresh?:(campaign:RangeKeeperLiveCampaign,payload:RangeKeeperLiveManagementReviewPayload)=>Promise<boolean>;
 enqueue:(job:RangeKeeperLiveManagementQueueInput)=>Promise<{campaignId:string;jobId:string;allocationId?:string;replayed:boolean;status:string}>;now?:()=>number}){
 const closePreview=async(campaignId:string,operationKind:'close_retain'|'close_convert'):Promise<RangeKeeperLiveManagementPreview>=>{
  const kind=previewKindFor(operationKind),observe=operationKind==='close_convert'?input.observeConvert:input.observe;
  let campaign:RangeKeeperLiveCampaign;
  try{campaign=await readRangeKeeperLiveCampaign(input.pool,{...input.wallet,campaignId});}
  catch{return {kind,mode:'live',strategyId:'rangekeeper_v1',status:'unavailable',
   trustedPreviewSaved:false,previewId:null,contentDigest:null,expectedRevision:0,expiresAt:null,source:null,position:null,costs:null,
   missing:['live_campaign_unavailable'],actionAvailable:false,operationAcceptanceAvailable:false,executionEligible:false};}
  if(input.persistReviews!==true)return unavailable(campaign,['live_management_review_persistence_disabled'],kind);
  if(!observe)return unavailable(campaign,['live_convert_exit_unavailable'],kind);
  try{
   const observation=await observe(campaign);
   return recordRangeKeeperLiveManagementReview(input.pool,{wallet:input.wallet,campaign,operationKind,
    source:observation.source,snapshot:observation.snapshot,references:observation.references,position:observation.position,
    decision:observation.decision,candidate:null,policy:null,costs:observation.costs,missing:observation.missing,
    expiresAt:observation.expiresAt},{buildId:input.buildId,verifyPinned:input.verifyPinned,now:input.now});
  }catch(error){return unavailable(campaign,[error instanceof Error?error.message:'live_management_observation_unavailable'],kind);}
 };
 const closeOperation=async(campaignId:string,body:{previewId:string;contentDigest:string;expectedRevision:number;idempotencyKey:string},
  operationKind:'close_retain'|'close_convert')=>{
  if(input.persistReviews!==true)return {status:'unavailable' as const,missing:['live_management_review_persistence_disabled'],
   actionAvailable:false as const,executionEligible:false as const};
  return admitRangeKeeperLiveManagement({wallet:input.wallet,campaignId,...body},{pool:input.pool,buildId:input.buildId,
   verifyPinned:input.verifyPinned,verifyConvertFresh:input.verifyConvertFresh,enqueue:input.enqueue,now:input.now},operationKind);
 };
 return {
  retainPreview:(campaignId:string)=>closePreview(campaignId,'close_retain'),
  retainOperation:(campaignId:string,body:{previewId:string;contentDigest:string;expectedRevision:number;idempotencyKey:string})=>
   closeOperation(campaignId,body,'close_retain'),
  convertPreview:(campaignId:string)=>closePreview(campaignId,'close_convert'),
  convertOperation:(campaignId:string,body:{previewId:string;contentDigest:string;expectedRevision:number;idempotencyKey:string})=>
   closeOperation(campaignId,body,'close_convert'),
 };
}

/** Construct the terminal event state after queue cleanup has independently
 * proved the retain-only operation complete. */
export function closedStateAfterRetain(state:RangeKeeperLiveState,source:RangeKeeperLiveManagementReviewPayload['source']):RangeKeeperLiveState{
 return deriveRangeKeeperLiveClosedState(state,source);
}
