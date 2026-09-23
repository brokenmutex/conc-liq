import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash} from '../deployments/market-profile.js';
import {contentHash} from '../deployments/contracts.js';
import {buildResearchCandidateReplay,type ResearchCandidateReplayRequest,type ResearchCandidateReplayResult} from './candidate-replay.js';
import type {PostgresResearchCandidateStore,ResearchPoolProfile} from './postgres-candidate-store.js';

export type ResearchPoolListing={status:'available'|'unavailable';profiles:readonly ResearchPoolProfile[];missing:readonly string[]};

/** Lists only saved market profiles whose content hashes and live indexer
 * registry identity are valid. */
export async function listResearchCandidatePools(store:PostgresResearchCandidateStore):Promise<ResearchPoolListing>{
 try{
  const page=await store.listCurrentProfiles();
  return page.hasMore?{status:'unavailable',profiles:page.profiles,missing:['registry_profile_listing_truncated']}:
   {status:'available',profiles:page.profiles,missing:[]};
 }
 catch{return {status:'unavailable',profiles:[],missing:['registry_profile_listing_unavailable']};}
}

export type ResearchCandidateLoad={status:'unavailable';profileId:string|null;profileHash:string|null;
 replay:ResearchCandidateReplayResult;draftBindingAvailable:false;missing:readonly string[];
 limitations:readonly string[]};

/** Candidate evidence is unavailable until canonical historical pool-state,
 * independent-reference, fee-interval, and scoped-cost readers are connected.
 * This method deliberately does not accept a caller bundle or promote replay
 * output into a trusted result. */
export async function loadResearchCandidate(input:{profileId:string;request:ResearchCandidateReplayRequest;
 store:PostgresResearchCandidateStore;now?:number}):Promise<ResearchCandidateLoad>{
 let saved:Awaited<ReturnType<PostgresResearchCandidateStore['loadCurrentProfile']>>=null;
 try{saved=await input.store.loadCurrentProfile(input.profileId);}catch{}
 const replay=buildResearchCandidateReplay({request:input.request},input.now);
 // Independently recheck the returned bytes at this boundary as defense in
 // depth; store-level verification includes the registry identity transaction.
 const profile=saved?marketProfileSchema.safeParse(saved.profile):null;
 const evidence=saved?marketProfileEvidenceSchema.safeParse(saved.evidence):null;
 const valid=!!saved&&saved.id===input.profileId&&saved.registryEnabled===true&&!!profile?.success&&
  !!evidence?.success&&contentHash(profile.data)===saved.profileHash&&
  referenceProofHash(evidence.data.referenceProof)===evidence.data.references.proofHash;
 return {status:'unavailable',profileId:valid?saved!.id:null,profileHash:valid?saved!.profileHash:null,
  replay,draftBindingAvailable:false,missing:[valid?'canonical_historical_evidence_adapter_unavailable':'registered_market_profile_unavailable'],
  limitations:['no_saved_draft_was_created','wallet_and_strategy_limits_are_not_pinned',
   'deployment_revision_and_candidate_snapshot_are_not_atomically_bound',
   'no_execution_or_preview_is_available']};
}
