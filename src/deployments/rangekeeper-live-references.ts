import type {RobinhoodClient} from '../client.js';
import {getAddress} from 'viem';
import type {Pool} from 'pg';
import type {RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {contentHash} from './contracts.js';
import type {MarketProfile} from './market-profile.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame} from './paper-preview.js';
import {rangeKeeperPinnedSemanticProofHash} from './rangekeeper-live-review-runtime.js';
import type {RangeKeeperStageReferences} from './rangekeeper-live-campaign.js';
import type {RangeKeeperLiveManagementReviewPayload} from './rangekeeper-live-campaign.js';
import {parseRangeKeeperJson,rangeKeeperJson} from '../strategy/rangekeeper/live-domain.js';
import {readRangeKeeperLiveCampaign} from './rangekeeper-live-campaign-store.js';
import {marketProfileSchema} from './market-profile.js';
import type {LiveJob,LiveOutbox} from './live-wallet-queue.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import {readCommitments,readWalletState} from './live-wallet-store.js';
import {liveWalletCommitmentFingerprint} from './live-wallet-commitment-projection.js';
import {verifyRangeKeeperWalletCode} from '../strategy/rangekeeper/wallet-code.js';

export interface RangeKeeperStageReferenceEvidence {
 kind:'rangekeeper_live_independent_reference_v1';campaignId:string;revision:number;profileHash:string;
 source:{block:string;hash:string;timestamp:number};prices:{price0:string;price1:string;nativePrice:string};
 semanticProofHash:string;referenceProof:Record<string,unknown>;
}
export interface RangeKeeperLiveStageReferences extends RangeKeeperStageReferences {
 evidence:RangeKeeperStageReferenceEvidence;
}
const asSource=(source:RangeKeeperSource)=>({block:String(source.block),hash:source.hash,timestamp:source.timestamp});
const sameSource=(a:{block:string;hash:string;timestamp:number},b:{block:string;hash:string;timestamp:number})=>
 a.block===b.block&&a.hash.toLowerCase()===b.hash.toLowerCase()&&a.timestamp===b.timestamp;

/** Convert a canonical frame into the private semantic evidence consumed by
 * the stage authorizer. Raw fetch-time reference proof hashes are not trusted. */
export function buildRangeKeeperLiveStageReferences(input:{campaignId:string;revision:number;profile:MarketProfile;frame:PaperOpenFrame}):RangeKeeperLiveStageReferences{
 const {profile,frame}=input,source=frame.source;
 if(!frame.referenceEligible||!frame.referenceProof||frame.price0===null||frame.price1===null||frame.nativePrice===null||
  frame.price0<=0n||frame.price1<=0n||frame.nativePrice<=0n)throw new Error('independent_reference_unavailable');
 const profileHash=contentHash(profile),prices={price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice)};
 const semanticProofHash=rangeKeeperPinnedSemanticProofHash({profileHash,source,references:prices,referenceProof:frame.referenceProof});
 const evidence:RangeKeeperStageReferenceEvidence={kind:'rangekeeper_live_independent_reference_v1',campaignId:input.campaignId,
  revision:input.revision,profileHash,source,prices,semanticProofHash,referenceProof:frame.referenceProof};
 return {price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice,proofHash:semanticProofHash,source,evidence};
}

/** Compare fresh pinned feed/proof semantics to evidence produced for one
 * campaign revision. Feed answers, update times, identities and registry
 * evidence remain bound; only `fetchedAt` transport metadata is normalized. */
export function rangeKeeperLiveStageReferencesMatch(input:{campaignId:string;revision:number;profile:MarketProfile;
 expected:RangeKeeperLiveStageReferences;frame:PaperOpenFrame}):boolean{
 try{
  const fresh=buildRangeKeeperLiveStageReferences({campaignId:input.campaignId,revision:input.revision,profile:input.profile,frame:input.frame});
  const evidence=input.expected.evidence as RangeKeeperStageReferenceEvidence;
  const expectedPrices={price0:String(input.expected.price0),price1:String(input.expected.price1),nativePrice:String(input.expected.nativePrice)};
  const evidenceHash=rangeKeeperPinnedSemanticProofHash({profileHash:contentHash(input.profile),source:evidence?.source,
   references:evidence?.prices,referenceProof:evidence?.referenceProof});
  return input.expected.price0===fresh.price0&&input.expected.price1===fresh.price1&&input.expected.nativePrice===fresh.nativePrice&&
   input.expected.proofHash===fresh.proofHash&&sameSource(input.expected.source,fresh.source)&&
   evidence?.kind==='rangekeeper_live_independent_reference_v1'&&evidence.campaignId===input.campaignId&&
   evidence.revision===input.revision&&evidence.profileHash===contentHash(input.profile)&&
   sameSource(evidence.source,input.expected.source)&&contentHash(evidence.prices)===contentHash(expectedPrices)&&
   evidenceHash===input.expected.proofHash&&evidence.semanticProofHash===evidenceHash;
 }catch{return false;}
}

export async function readRangeKeeperLiveStageReferences(input:{client:RobinhoodClient;campaignId:string;revision:number;
 profile:MarketProfile;source:RangeKeeperSource}):Promise<RangeKeeperLiveStageReferences>{
 const frame=await readCanonicalPaperOpenFrame(input.client,input.profile,asSource(input.source));
 if(!sameSource(frame.source,asSource(input.source)))throw new Error('pinned_reference_source_changed');
 return buildRangeKeeperLiveStageReferences({campaignId:input.campaignId,revision:input.revision,profile:input.profile,frame});
}

export async function verifyRangeKeeperLiveStageReferences(input:{client:RobinhoodClient;campaignId:string;revision:number;
 profile:MarketProfile;expected:RangeKeeperLiveStageReferences}):Promise<boolean>{
 try{
  const frame=await readCanonicalPaperOpenFrame(input.client,input.profile,input.expected.source);
  return rangeKeeperLiveStageReferencesMatch({...input,frame});
 }catch{return false;}
}

/** Recheck a prepared, unsigned stage against its immutable fork authorization
 * and the campaign's current persisted profile/allocation before signing. */
export function createRangeKeeperLivePreparedIntentVerifier(input:{pool:Pool;client:RobinhoodClient;wallet:LiveWalletIdentity;now?:()=>number}){
 return async(args:{job:LiveJob;outbox:LiveOutbox}):Promise<boolean>=>{
  try{
   const {job,outbox}=args;
   if(!['open','change_range','close_retain'].includes(job.kind)||
    job.status==='succeeded'||job.status==='rejected'||job.status==='cancelled')return false;
   const row=(await input.pool.query<any>(`SELECT authorization_json,authorization_hash,source_block,source_hash,source_timestamp,
    campaign_id,revision,allocation_id,profile_hash,config_hash,allocation_hash
    FROM deployment_live_stage_authorizations WHERE job_id=$1 AND stage=$2 AND chain_id=$3 AND wallet=$4`,
    [job.id,outbox.stage,input.wallet.chainId,input.wallet.address.toLowerCase()])).rows[0];
   if(!row)return false;
   const authorization=row.authorization_json as any,e=authorization;
   if(contentHash(e)!==row.authorization_hash||e?.kind!=='rangekeeper_live_owned_stage_v1'||e?.status!=='success'||
    e.campaignId!==job.campaignId||e.revision!==job.revision||e.stage!==outbox.stage||
    e.allocationId!==job.allocationId||e.profileId===undefined||e.buildId!==job.buildId||
    e.profileHash!==row.profile_hash||e.allocationHash!==row.allocation_hash||
    e.configHash!==row.config_hash||!Number.isSafeInteger(e.expiresAt)||e.expiresAt<= (input.now??Date.now)())return false;
   const source={block:String(e.source?.block),hash:String(e.source?.hash),timestamp:Number(e.source?.timestamp)};
   const beforeSource=(outbox.before as any)?.wallet?.source;
   if(source.block!==outbox.intent.sourceBlock||source.hash.toLowerCase()!==outbox.intent.sourceHash.toLowerCase()||
    source.block!==String(row.source_block)||source.hash.toLowerCase()!==String(row.source_hash).toLowerCase()||
    source.timestamp!==Number(row.source_timestamp)||!beforeSource||String(beforeSource.block)!==source.block||
    String(beforeSource.hash).toLowerCase()!==source.hash.toLowerCase()||Number(beforeSource.timestamp)!==source.timestamp||
    e.nonce!==outbox.intent.nonce||e.gasUnitsBound!==outbox.intent.gas||e.maxFeePerGasWei!==outbox.intent.maxFeePerGas||
    e.priorityFeePerGasWei!==outbox.intent.maxPriorityFeePerGas)return false;
   if(e.exitSpendAllowed!==(job.kind==='close_retain'))return false;
   const persistedAuthorization=(outbox.before as any)?.authorization;
   if(persistedAuthorization&&contentHash(persistedAuthorization)!==row.authorization_hash)return false;
   const campaign=await readRangeKeeperLiveCampaign(input.pool,{...input.wallet,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
   if(campaign.profileHash!==e.profileHash||campaign.allocation.allocationHash!==e.allocationHash||
    campaign.allocation.allocationId!==e.allocationId||campaign.configHash.slice(2)!==e.configHash)return false;
   if(job.kind==='open'){
    if(campaign.status!=='opening')return false;
   }else{
    if(campaign.status!=='active'||contentHash(job.payload)!==job.payloadHash)return false;
    const management=parseRangeKeeperJson<RangeKeeperLiveManagementReviewPayload>(job.payload);
    if(management.operationKind!==job.kind||management.campaignId!==job.campaignId||management.revision!==job.revision||
     management.allocationId!==job.allocationId)return false;
    const transitionId=contentHash({kind:'rangekeeper_management_transition',jobId:job.id,reviewHash:contentHash(job.payload)});
    const transitionPayload={schemaVersion:1,kind:'rangekeeper_live_management_transition_v1',jobId:job.id,
     operationKind:job.kind,reviewHash:contentHash(job.payload),source:management.source};
    const transition=(await input.pool.query<any>(`SELECT kind,before_state_hash,after_state_hash,sequence,payload_hash
     FROM deployment_live_runtime_events WHERE campaign_id=$1 AND revision=$2 AND effect_id=$3`,
     [job.campaignId,job.revision,transitionId])).rows[0];
    if(!transition||transition.kind!=='mark'||transition.before_state_hash!==management.runtimeStateHash||
     Number(transition.sequence)!==management.stateRevision+1||transition.payload_hash!==contentHash(transitionPayload)||
     !/^[0-9a-f]{64}$/.test(transition.after_state_hash))return false;
    const current=campaign.state;
    if(!current)return false;
    if(job.kind==='change_range'){
     if(current.phase!=='recenter'&&current.phase!=='holding')return false;
    }else if(current.phase!=='exit'||current.desired!=='stopped'||current.exitMode!=='retain')return false;
   }
   const walletState=await readWalletState(input.pool,input.wallet),commitments=await readCommitments(input.pool,input.wallet),before=outbox.before as any;
   if(walletState.status!=='available'||!walletState.source||walletState.generation!==Number(before.walletGeneration)||
    walletState.source.block!==source.block||walletState.source.hash.toLowerCase()!==source.hash.toLowerCase()||
    walletState.source.timestamp!==source.timestamp||walletState.nonce!==String(outbox.intent.nonce)||
    walletState.pendingNonce!==String(outbox.intent.nonce)||walletState.commitmentsHash!==liveWalletCommitmentFingerprint(commitments))return false;
   const [canonicalNonce,pendingNonce]=await Promise.all([
    input.client.getTransactionCount({address:getAddress(job.wallet),blockNumber:BigInt(source.block)}),
    input.client.getTransactionCount({address:getAddress(job.wallet),blockTag:'pending'}),
   ]);
   if(canonicalNonce!==outbox.intent.nonce||pendingNonce!==outbox.intent.nonce)return false;
   await verifyRangeKeeperWalletCode(input.client,{block:BigInt(source.block),hash:source.hash as `0x${string}`,timestamp:source.timestamp},
    getAddress(job.wallet),campaign.config);
   const profile=marketProfileSchema.parse(campaign.profile),referenceEvidence=e.referenceEvidence as RangeKeeperStageReferenceEvidence;
   if(!referenceEvidence||referenceEvidence.kind!=='rangekeeper_live_independent_reference_v1')return false;
   const expected:RangeKeeperLiveStageReferences={price0:BigInt(referenceEvidence.prices.price0),price1:BigInt(referenceEvidence.prices.price1),
    nativePrice:BigInt(referenceEvidence.prices.nativePrice),proofHash:e.referenceProofHash,source:referenceEvidence.source,evidence:referenceEvidence};
   if(!await verifyRangeKeeperLiveStageReferences({client:input.client,campaignId:job.campaignId,revision:job.revision,profile,expected}))return false;
   return true;
  }catch{return false;}
 };
}
