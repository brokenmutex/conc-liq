import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import type {RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {contentHash} from './contracts.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import type {LiveCustodyStrategy,PinnedCustodySource} from './live-custody-snapshot.js';

const CONFIRMATIONS=64,MAX_SOURCE_AGE_SECONDS=180,UINT=/^(0|[1-9][0-9]*)$/;
type ReferenceEvidence={kind:'live_independent_reference_evidence';status:'available'|'unavailable';
 targetStrategyId:LiveCustodyStrategy|null;profileHash:string|null;referencePolicyHash:string|null;
 source:{block:string;hash:string;timestamp:number;confirmed:boolean}|null;
 validUntil:number|null;
 references:{token0:string|null;token1:string|null;native:string|null;reference0:string;reference1:string;
  nativeReference:string;numeraire:string;proofHash:string|null}|null;
 reasons:string[];missing:string[];actionAvailable:false};

function unavailable(strategy:LiveCustodyStrategy|null,profileHash:string|null,policyHash:string|null,
 source:PinnedCustodySource|null,reason:string,reasons:string[]=[]):ReferenceEvidence{
 return {kind:'live_independent_reference_evidence',status:'unavailable',targetStrategyId:strategy,
  profileHash,referencePolicyHash:policyHash,source:source?{block:String(source.block),hash:source.hash,
   timestamp:source.timestamp,confirmed:false}:null,validUntil:null,references:null,reasons,
  missing:[reason,...reasons],actionAvailable:false};
}
function normalizeProof(value:unknown):unknown{
 return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?String(item):item));
}

/** Re-read independent references against the saved profile at one pinned,
 * confirmed source. This only supplies valuation provenance to a diagnostic
 * preflight; it never treats the result as execution admission. */
export async function readLiveIndependentReferenceEvidence(input:{client:RobinhoodClient;
 targetStrategyId:unknown;profile:unknown;profileHash:unknown;source:PinnedCustodySource}):Promise<ReferenceEvidence>{
 const strategy:LiveCustodyStrategy|null=input.targetStrategyId==='static_manual_v1'||input.targetStrategyId==='rangekeeper_v1'?
  input.targetStrategyId as LiveCustodyStrategy:null;
 const parsed=marketProfileSchema.safeParse(input.profile),profile:MarketProfile|null=parsed.success?parsed.data:null;
 const profileHash=typeof input.profileHash==='string'?input.profileHash:null;
 const policyHash=profile?contentHash(profile.referencePolicy):null,source=input.source;
 if(!strategy)return unavailable(strategy,profileHash,policyHash,source,'target_strategy_unsupported');
 if(!profile)return unavailable(strategy,profileHash,policyHash,source,'saved_market_profile_invalid');
 if(!profileHash||contentHash(profile)!==profileHash)
  return unavailable(strategy,profileHash,policyHash,source,'saved_market_profile_hash_mismatch');
 if(profile.pool.chainId!==ROBINHOOD_CHAIN_ID)
  return unavailable(strategy,profileHash,policyHash,source,'reference_profile_chain_mismatch');
 if(!source||source.block<0n||!Number.isSafeInteger(source.timestamp)||source.timestamp<0||
  !/^0x[0-9a-f]{64}$/i.test(source.hash))
  return unavailable(strategy,profileHash,policyHash,null,'pinned_reference_source_invalid');
 try{
  const [chainId,latest,pinned]=await Promise.all([
   input.client.getChainId(),input.client.getBlock(),input.client.getBlock({blockNumber:source.block}),
  ]);
  if(chainId!==ROBINHOOD_CHAIN_ID)return unavailable(strategy,profileHash,policyHash,source,'reference_chain_id_mismatch');
  if(latest.number<source.block+BigInt(CONFIRMATIONS))
   return unavailable(strategy,profileHash,policyHash,source,'reference_source_not_confirmed');
  const sourceAge=Math.floor(Date.now()/1000)-source.timestamp;
  if(sourceAge<0||sourceAge>MAX_SOURCE_AGE_SECONDS)
   return unavailable(strategy,profileHash,policyHash,source,'reference_source_stale');
  if(!pinned.hash||pinned.hash.toLowerCase()!==source.hash.toLowerCase()||Number(pinned.timestamp)!==source.timestamp)
   return unavailable(strategy,profileHash,policyHash,source,'reference_source_identity_mismatch');
  const rangeSource:RangeKeeperSource={block:source.block,hash:source.hash as `0x${string}`,timestamp:source.timestamp};
  const mark=await readRangeKeeperReferences(input.client,rangeSource,profile);
  const sourceTime=Math.floor(Date.parse(mark.source.timestamp)/1000);
  if(mark.source.block!==String(source.block)||mark.source.hash.toLowerCase()!==source.hash.toLowerCase()||
   sourceTime!==source.timestamp)
   return unavailable(strategy,profileHash,policyHash,source,'reference_mark_source_mismatch',mark.reasons);
  const after=await input.client.getBlock({blockNumber:source.block});
  if(!after.hash||after.hash.toLowerCase()!==source.hash.toLowerCase()||Number(after.timestamp)!==source.timestamp)
   return unavailable(strategy,profileHash,policyHash,source,'reference_source_changed_during_read',mark.reasons);
  if(!mark.eligible||!mark.price0||!mark.price1||!mark.nativePrice||
   mark.price0<=0n||mark.price1<=0n||mark.nativePrice<=0n)
   return unavailable(strategy,profileHash,policyHash,source,'independent_reference_policy_unavailable',mark.reasons);
  const completedAge=Math.floor(Date.now()/1000)-source.timestamp;
  if(completedAge<0||completedAge>MAX_SOURCE_AGE_SECONDS)
   return unavailable(strategy,profileHash,policyHash,source,'reference_source_stale_after_read',mark.reasons);
  const proofHash=referenceProofHash(normalizeProof(mark.proof));
  if(!/^[0-9a-f]{64}$/.test(proofHash))
   return unavailable(strategy,profileHash,policyHash,source,'reference_proof_hash_invalid');
  return {kind:'live_independent_reference_evidence',status:'available',targetStrategyId:strategy,
   profileHash,referencePolicyHash:policyHash,
   source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp,confirmed:true},
   validUntil:source.timestamp+MAX_SOURCE_AGE_SECONDS,
   references:{token0:String(mark.price0),token1:String(mark.price1),native:String(mark.nativePrice),
    reference0:profile.pool.reference0,reference1:profile.pool.reference1,
    nativeReference:profile.pool.nativeReference,numeraire:profile.pool.numeraire,proofHash},
   reasons:[],missing:[],actionAvailable:false};
 }catch{
  return unavailable(strategy,profileHash,policyHash,source,'independent_reference_read_unavailable');
 }
}

export function isCanonicalPositiveReferenceAmount(value:unknown):value is string{
 return typeof value==='string'&&UINT.test(value)&&BigInt(value)>0n;
}
