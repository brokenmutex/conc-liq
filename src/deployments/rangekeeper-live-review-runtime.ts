import {DEPLOYMENT_SCHEMA_VERSION} from '../storage/compatibility.js';
import type {Pool} from 'pg';
import {contentHash} from './contracts.js';
import {applyWalletSnapshotInTransaction,readCommitments,recordReview,readWalletState,withLiveWalletTransaction,
 type LiveWalletIdentity,type LiveWalletSnapshotInput,type LiveWalletState} from './live-wallet-store.js';
import {liveWalletCommitmentFingerprint} from './live-wallet-commitment-projection.js';
import {recordRangeKeeperNftCustodySnapshotInTransaction,type CompleteRangeKeeperNftEvidence,type RangeKeeperNftPosition} from './rangekeeper-live-campaign-store.js';
import {recordRangeKeeperLiveSetupReview,type RangeKeeperLiveReviewPayload,type RangeKeeperLiveReviewAdmissionResult} from './rangekeeper-live-review-admission.js';

const VOLATILE_REFERENCE_KEYS=new Set(['fetchedAt']);
function semantic(value:unknown):unknown{
 if(Array.isArray(value))return value.map(semantic);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>)
  .filter(([key])=>!VOLATILE_REFERENCE_KEYS.has(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,semantic(v)]));
 if(typeof value==='bigint')return value.toString();
 return value;
}
/** Stable semantic identity retains feed identity, oracle answers, timestamps,
 * round, registry and proof values; only the fetch-time `fetchedAt` marker is omitted. */
export function rangeKeeperPinnedSemanticIdentity(input:{profileHash:string;source:unknown;references:unknown;referenceProof:unknown}):string{
 const refs=input.references&&typeof input.references==='object'?Object.fromEntries(Object.entries(input.references as Record<string,unknown>)
  .filter(([key])=>key!=='proofHash'&&key!=='semanticProofHash')):input.references;
 return contentHash({profileHash:input.profileHash,source:semantic(input.source),references:semantic(refs),proof:semantic(input.referenceProof)});
}
/** Value persisted in the server review; the full source-bound proof stays on
 * the server and is never exposed as signing material or client authority. */
export const rangeKeeperPinnedSemanticProofHash=rangeKeeperPinnedSemanticIdentity;
export async function revalidateRangeKeeperPinnedSemanticHash(input:{expectedSemanticProofHash:string;
 profileHash:string;source:{block:string;hash:string;timestamp:number};freshProfileHash:string;
 freshSource:{block:string;hash:string;timestamp:number};freshReferences:unknown;freshReferenceProof:unknown;
 verifyCanonical:(source:{block:string;hash:string;timestamp:number})=>Promise<void>}):Promise<boolean>{
 if(input.profileHash!==input.freshProfileHash||input.source.block!==input.freshSource.block||
  input.source.hash.toLowerCase()!==input.freshSource.hash.toLowerCase()||input.source.timestamp!==input.freshSource.timestamp)return false;
 try{await input.verifyCanonical(input.source);}catch{return false;}
 return input.expectedSemanticProofHash===rangeKeeperPinnedSemanticProofHash({profileHash:input.freshProfileHash,
  source:input.freshSource,references:input.freshReferences,referenceProof:input.freshReferenceProof});
}
export async function revalidateRangeKeeperPinnedReferences(input:{
 frozen:{profileHash:string;source:{block:string;hash:string;timestamp:number};references:unknown;referenceProof:unknown};
 fresh:{profileHash:string;source:{block:string;hash:string;timestamp:number};references:unknown;referenceProof:unknown};
 verifyCanonical:(source:{block:string;hash:string;timestamp:number})=>Promise<void>;
}):Promise<{status:'valid';semanticIdentity:string}|{status:'unavailable';reason:'pinned_source_changed'|'reference_semantics_changed'}>{
 const a=input.frozen.source,b=input.fresh.source;
 if(input.frozen.profileHash!==input.fresh.profileHash||a.block!==b.block||a.hash.toLowerCase()!==b.hash.toLowerCase()||a.timestamp!==b.timestamp)
  return {status:'unavailable',reason:'pinned_source_changed'};
 try{await input.verifyCanonical(a);}catch{return {status:'unavailable',reason:'pinned_source_changed'};}
 const before=rangeKeeperPinnedSemanticIdentity(input.frozen),after=rangeKeeperPinnedSemanticIdentity(input.fresh);
 return before===after?{status:'valid',semanticIdentity:before}:{status:'unavailable',reason:'reference_semantics_changed'};
}

export type RangeKeeperSnapshotObservation={snapshot:LiveWalletSnapshotInput;complete:boolean;missing:readonly string[];
 nft:{positionManager:string;completeEvidence:CompleteRangeKeeperNftEvidence;positions:RangeKeeperNftPosition[];retiredEmptyTokenIds:string[];
  campaignId?:string;allocationId?:string;allocatedTokenIds?:string[]}};
export interface RangeKeeperReviewRuntimeResult {status:'persisted'|'read_only'|'unavailable';state:LiveWalletState|null;missing:readonly string[]}

/** Runtime factory for explicit, read-only snapshot/review work. It does not
 * initialize schemas and deliberately refuses refresh while any raw action is
 * unresolved, so snapshot generations cannot invalidate signed recovery. */
export function createRangeKeeperLiveReviewRuntime(input:{pool:Pool;wallet:LiveWalletIdentity;buildId:string;requireIdleQueue?:boolean;
 observeWallet:()=>Promise<RangeKeeperSnapshotObservation>;verifyCanonical:(source:LiveWalletSnapshotInput['source'])=>Promise<void>;
 now?:()=>number}){
 const readSchemaVersion=async()=>{
  const r=await input.pool.query<{version:number}>('SELECT max(version)::int AS version FROM schema_migrations');
  return Number(r.rows[0]?.version??0);
 };
 const refreshSnapshot=async():Promise<RangeKeeperReviewRuntimeResult>=>{
  let version:number;try{version=await readSchemaVersion();}catch{return {status:'read_only',state:null,missing:['schema_version_unavailable']};}
  if(version<12)return {status:'read_only',state:null,missing:['live_wallet_v12_required_for_snapshot_persistence']};
  if(version>DEPLOYMENT_SCHEMA_VERSION)return {status:'unavailable',state:null,missing:['unsupported_live_wallet_schema_version']};
  let state:LiveWalletState|null=null;
  try{state=await readWalletState(input.pool,input.wallet);}catch{return {status:'read_only',state:null,missing:['live_wallet_schema_unavailable']};}
  if(version===12)return {status:'read_only',state,missing:['live_runtime_v13_required_for_nft_snapshot_persistence']};
  let observation:RangeKeeperSnapshotObservation;
  try{observation=await input.observeWallet();}catch{return {status:'unavailable',state,missing:['canonical_wallet_snapshot_unavailable']};}
  if(!observation.complete)return {status:'unavailable',state,missing:[...new Set(observation.missing.length?observation.missing:['canonical_wallet_snapshot_incomplete'])]};
  try{await input.verifyCanonical(observation.snapshot.source);}catch{return {status:'unavailable',state,missing:['wallet_snapshot_source_changed']};}
  const next=observation.snapshot;
  try{return await withLiveWalletTransaction(input.pool,input.wallet,async client=>{
   if(input.requireIdleQueue===true){
    const idle=(await client.query<any>(`SELECT
     NOT EXISTS(SELECT 1 FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2
      AND status IN('queued','preflighting','executing','confirming','reconciling','blocked')) AND
     NOT EXISTS(SELECT 1 FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2 AND lease_until>clock_timestamp()) AND
     NOT EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE chain_id=$1 AND wallet=$2
      AND (status IN('prepared','signed','blocked') OR (signed_raw IS NOT NULL AND canonical_receipt_json IS NULL))) AS ready`,
     [input.wallet.chainId,input.wallet.address.toLowerCase()])).rows[0]?.ready;
    if(idle!==true)return {status:'unavailable' as const,state:await readWalletState(client,input.wallet),missing:['persisted_live_queue_has_priority']};
   }
   const pending=await client.query<{count:string}>(`SELECT count(*)::text AS count FROM deployment_live_stage_outbox
    WHERE chain_id=$1 AND wallet=$2 AND status IN('prepared','signed','blocked')`,[input.wallet.chainId,input.wallet.address.toLowerCase()]);
   if(BigInt(pending.rows[0]?.count??'0')>0n)return {status:'unavailable' as const,state:await readWalletState(client,input.wallet),missing:['persisted_live_action_recovery_has_priority']};
   await input.verifyCanonical(next.source);
   state=await readWalletState(client,input.wallet);
   if(state.status==='available'&&state.source&&state.nonce===next.nonce&&state.pendingNonce===next.pendingNonce&&
    state.nativeBalanceWei===next.nativeBalanceWei&&state.commitmentsHash===next.commitmentsHash&&
    state.source.block===next.source.block&&state.source.hash.toLowerCase()===next.source.hash.toLowerCase()&&
    state.source.timestamp===next.source.timestamp&&contentHash(state.tokens)===contentHash(next.tokens.map(t=>({...t,address:t.address.toLowerCase()})).sort((a,b)=>a.address.localeCompare(b.address))))
    await recordRangeKeeperNftCustodySnapshotInTransaction(client,{...input.wallet,positionManager:observation.nft.positionManager,
     source:next.source,completeEvidence:observation.nft.completeEvidence,positions:observation.nft.positions,
     retiredEmptyTokenIds:observation.nft.retiredEmptyTokenIds,campaignId:observation.nft.campaignId,
     allocationId:observation.nft.allocationId,allocatedTokenIds:observation.nft.allocatedTokenIds});
   else{
    state=await applyWalletSnapshotInTransaction(client,next);
    await recordRangeKeeperNftCustodySnapshotInTransaction(client,{...input.wallet,positionManager:observation.nft.positionManager,
     source:next.source,completeEvidence:observation.nft.completeEvidence,positions:observation.nft.positions,
     retiredEmptyTokenIds:observation.nft.retiredEmptyTokenIds,campaignId:observation.nft.campaignId,
     allocationId:observation.nft.allocationId,allocatedTokenIds:observation.nft.allocatedTokenIds});
   }
   // NFT custody rows are part of the persisted wallet commitment view. Rebind
   // the snapshot only after their canonical evidence has been recorded, under
   // the same wallet lock; this never changes balances or NFT attribution.
   const persistedCommitmentsHash=liveWalletCommitmentFingerprint(await readCommitments(client,input.wallet));
   if(state.commitmentsHash!==persistedCommitmentsHash){
    state=await applyWalletSnapshotInTransaction(client,{...next,commitmentsHash:persistedCommitmentsHash});
   }
   return {status:'persisted' as const,state,missing:state.status==='available'?[]:['wallet_snapshot_persisted_blocked']};
  });}catch{return {status:'unavailable',state,missing:['wallet_snapshot_persistence_failed']};}
 };
 const persistReview=async(reviewId:string,payload:unknown):Promise<RangeKeeperLiveReviewAdmissionResult>=>{
  let version:number;try{version=await readSchemaVersion();}catch{return {status:'unavailable',missing:['schema_version_unavailable'],actionAvailable:false,executionEligible:false};}
  if(version<12)return {status:'unavailable',missing:['live_wallet_v12_required_for_review_persistence'],actionAvailable:false,executionEligible:false};
  if(version>DEPLOYMENT_SCHEMA_VERSION)return {status:'unavailable',missing:['unsupported_live_wallet_schema_version'],actionAvailable:false,executionEligible:false};
  const parsed=payload as RangeKeeperLiveReviewPayload;
  const semanticHash=(parsed?.references as Record<string,unknown>|undefined)?.semanticProofHash;
  const payloadBuild=(parsed?.binding as Record<string,unknown>|undefined)?.buildId;
  if(typeof semanticHash!=='string'||! /^[0-9a-f]{64}$/.test(semanticHash))
   return {status:'unavailable',missing:['review_reference_semantic_identity_missing'],actionAvailable:false,executionEligible:false};
  if(payloadBuild!==input.buildId)return {status:'unavailable',missing:['review_build_identity_changed'],actionAvailable:false,executionEligible:false};
  try{await input.verifyCanonical(parsed.source);}catch{return {status:'unavailable',missing:['review_source_changed'],actionAvailable:false,executionEligible:false};}
  return recordRangeKeeperLiveSetupReview({wallet:input.wallet.address,reviewId,payload},{
   readWalletState:async wallet=>{
    const state=await readWalletState(input.pool,{...input.wallet,address:wallet});
    return {wallet:state.address,generation:String(state.generation),status:state.status,source:state.source,
     snapshotHash:state.snapshotHash,commitmentsHash:state.commitmentsHash,nonce:state.nonce,pendingNonce:state.pendingNonce,
     nativeBalanceWei:state.nativeBalanceWei,tokens:state.tokens};
   },
   recordReview:async row=>{await recordReview(input.pool,{...input.wallet,address:row.wallet,reviewId:row.reviewId,payload:row.payload,
    payloadHash:row.reviewHash,buildId:row.buildId,source:row.source,expiresAt:row.expiresAt,
    walletGeneration:Number(row.walletGeneration),commitmentsHash:row.commitmentsHash});},
   now:input.now,
  });
 };
 return {refreshSnapshot,persistReview};
}
