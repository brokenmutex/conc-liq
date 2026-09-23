import {z} from 'zod';
import {USDG} from '../constants.js';
import type {RobinhoodClient} from '../client.js';
import {allocationSchema,contentHash,draftInput,staticParameters,type DraftInput} from '../deployments/contracts.js';
import {referenceProofHash,marketProfileEvidenceSchema,marketProfileSchema} from '../deployments/market-profile.js';
import {verifyCanonicalPaperAnchors} from '../deployments/paper-canonical-anchors.js';
import type {DeploymentStore} from '../deployments/store.js';
import {alignManualRange} from '../strategy/static-manual/planner.js';
import type {PostgresResearchCandidateStore} from './postgres-candidate-store.js';

const uint=z.string().regex(/^(0|[1-9][0-9]*)$/);
const requestSchema=z.object({schemaVersion:z.literal(1),strategyId:z.literal('static_manual_v1'),
 windowSeconds:z.union([z.literal(900),z.literal(3600),z.literal(21600),z.literal(86400),z.literal(604800)]),
 capitalQuoteRaw:uint,range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict()}).strict();
const inputSchema=z.object({profileId:z.uuid(),request:requestSchema,wallet:z.string(),
 allocation:allocationSchema,limits:staticParameters.shape.limits.unwrap()}).strict();
const valueUsd6=(amount:bigint,priceX18:bigint,decimals:number)=>
 amount*priceX18*1_000_000n/(10n**BigInt(decimals)*10n**18n);

export type ResearchDraftBindingResult={status:'draft_created'|'unavailable';draftId:string|null;
 revision:number|null;configHash:string|null;bindingHash:string|null;profileId:string|null;profileHash:string|null;
 source:{block:string;hash:string;timestamp:number}|null;strategyId:'static_manual_v1';
 candidateSource:'caller_supplied_static_request';
 range:{tickLower:number;tickUpper:number}|null;allocationHash:string|null;
 economics:{status:'unavailable';missing:readonly string[]};actionAvailable:false;
 missing:readonly string[];limitations:readonly string[]};

const unavailable=(reason:string,profileId:string|null=null,profileHash:string|null=null,
 source:ResearchDraftBindingResult['source']=null):ResearchDraftBindingResult=>({status:'unavailable',draftId:null,
 revision:null,configHash:null,bindingHash:null,profileId,profileHash,source,strategyId:'static_manual_v1',range:null,
 candidateSource:'caller_supplied_static_request',
 allocationHash:null,economics:{status:'unavailable',missing:['historical_window_replay_unavailable',
  'candidate_fees_and_costs_unavailable','passive_comparison_unavailable']},actionAvailable:false,
 missing:[reason],limitations:['paper_draft_only','no_preview_or_operation_is_created',
  'historical_candidate_economics_remain_unavailable']});

/** Saves a static/manual paper draft whose profile, range, token allocation and
 * revision are linked by the existing deployment store. Its market-profile
 * evidence source is checked against chain data before creation; historical
 * Research economics are explicitly unavailable and are not attached as proof. */
export async function createStaticResearchDraft(input:unknown,deps:{
 researchStore:PostgresResearchCandidateStore;deploymentStore:DeploymentStore;client:RobinhoodClient;
},now=Date.now()):Promise<ResearchDraftBindingResult>{
 const parsed=inputSchema.safeParse(input);
 if(!parsed.success)return unavailable('research_draft_input_invalid');
 const value=parsed.data,allocation=allocationSchema.parse(value.allocation);
 let saved:Awaited<ReturnType<PostgresResearchCandidateStore['loadCurrentProfile']>>=null;
 try{saved=await deps.researchStore.loadCurrentProfile(value.profileId);}catch{}
 if(!saved||saved.id!==value.profileId||!saved.registryEnabled)
  return unavailable('registered_market_profile_unavailable');
 const profile=marketProfileSchema.safeParse(saved.profile),evidence=marketProfileEvidenceSchema.safeParse(saved.evidence);
 if(!profile.success||!evidence.success||contentHash(profile.data)!==saved.profileHash||
  referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
  return unavailable('registered_market_profile_integrity',saved.id,saved.profileHash);
 const p=profile.data.pool,q=p.quoteToken===0?{address:p.token0,decimals:p.decimals0}:
  {address:p.token1,decimals:p.decimals1};
 if(q.address.toLowerCase()!==USDG.toLowerCase()||q.decimals!==6)
  return unavailable('unsupported_research_quote_unit',saved.id,saved.profileHash,evidence.data.source);
 let aligned;
 try{aligned=alignManualRange(value.request.range.tickLower,value.request.range.tickUpper,p.tickSpacing);}
 catch{return unavailable('candidate_range_invalid',saved.id,saved.profileHash,evidence.data.source);}
 if(aligned.rounded)return unavailable('candidate_range_not_tick_aligned',saved.id,saved.profileHash,evidence.data.source);
 const amount0=BigInt(allocation.token0Raw),amount1=BigInt(allocation.token1Raw);
 const allocationValue=valueUsd6(amount0,BigInt(evidence.data.references.price0),p.decimals0)+
  valueUsd6(amount1,BigInt(evidence.data.references.price1),p.decimals1);
 if(allocationValue!==BigInt(value.request.capitalQuoteRaw))
  return unavailable('allocation_does_not_match_profile_source_capital',saved.id,saved.profileHash,evidence.data.source);
 if(allocationValue<BigInt(value.limits.minDeploymentValue)||
  allocationValue>BigInt(value.limits.maxDeploymentValue)||
  BigInt(allocation.nativeWei)<BigInt(value.limits.exitReserveWei))
  return unavailable('allocation_outside_saved_strategy_limits',saved.id,saved.profileHash,evidence.data.source);
 const sourceAge=now-evidence.data.source.timestamp*1000;
 if(sourceAge<0||sourceAge>180_000)
  return unavailable('registered_profile_reference_source_stale',saved.id,saved.profileHash,evidence.data.source);
 try{await verifyCanonicalPaperAnchors(deps.client,p.chainId,[evidence.data.source]);}
 catch{return unavailable('registered_profile_source_not_canonical',saved.id,saved.profileHash,evidence.data.source);}
 const draft= draftInput.parse({mode:'paper',chainId:p.chainId,wallet:value.wallet,
  marketProfileId:saved.id,strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation,config:{tickLower:aligned.tickLower,tickUpper:aligned.tickUpper,limits:value.limits}}) as DraftInput;
 let created:{id:string;revision:number;configHash:string};
 try{created=await deps.deploymentStore.createDraft(draft) as typeof created;}
 catch{return unavailable('deployment_draft_store_rejected',saved.id,saved.profileHash,evidence.data.source);}
 let readback;
 try{readback=await deps.deploymentStore.paperDraft(created.id);}
 catch{return { ...unavailable('created_draft_readback_unavailable',saved.id,saved.profileHash,evidence.data.source),
  draftId:created.id,revision:created.revision,configHash:created.configHash};}
 const allocationHash=contentHash(allocation),parameters=staticParameters.safeParse(readback.parameters),
  storedAllocation=allocationSchema.safeParse(readback.allocation);
 let allocationMatches=false;
 try{allocationMatches=storedAllocation.success&&contentHash(storedAllocation.data)===allocationHash;}catch{}
 if(!parameters.success||!storedAllocation.success||!allocationMatches||readback.id!==created.id||
  readback.revision!==created.revision||readback.strategyId!=='static_manual_v1'||
  readback.profileHash!==saved.profileHash||readback.configHash!==created.configHash||
  parameters.data.tickLower!==aligned.tickLower||parameters.data.tickUpper!==aligned.tickUpper)
  return {...unavailable('created_draft_binding_readback_mismatch',saved.id,saved.profileHash,evidence.data.source),
   draftId:created.id,revision:created.revision,configHash:created.configHash,allocationHash};
 const bindingHash=contentHash({campaignId:created.id,revision:created.revision,configHash:created.configHash,
  profileId:saved.id,profileHash:saved.profileHash,source:evidence.data.source,
  range:{tickLower:aligned.tickLower,tickUpper:aligned.tickUpper},allocationHash});
 return {status:'draft_created',draftId:created.id,revision:created.revision,configHash:created.configHash,bindingHash,
  profileId:saved.id,profileHash:saved.profileHash,source:evidence.data.source,strategyId:'static_manual_v1',
  candidateSource:'caller_supplied_static_request',
  range:{tickLower:aligned.tickLower,tickUpper:aligned.tickUpper},allocationHash,
  economics:{status:'unavailable',missing:['historical_window_replay_unavailable',
   'candidate_fees_and_costs_unavailable','passive_comparison_unavailable']},actionAvailable:false,
  missing:['historical_window_replay_unavailable','candidate_fees_and_costs_unavailable',
   'passive_comparison_unavailable','candidate_request_window_is_not_part_of_deployment_revision'],
  limitations:['paper_draft_only','deployment_profile_range_allocation_and_revision_are_pinned',
   'binding_hash_is_recomputable_from_saved_draft_and_registered_profile',
   'range_and_capital_come_from_caller_request_not_historical_candidate_output',
   'draft_does_not_claim_candidate_economics','no_preview_or_operation_is_created']};
}
