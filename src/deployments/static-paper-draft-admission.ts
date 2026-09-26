import {z} from 'zod';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {paperSetupPreflightInput,type PaperSetupProfile} from './paper-setup-preflight.js';
import {allocationSchema,contentHash,draftInput,staticManualParameters,staticParameters,
 staticPaperLimitsSchema,type DraftInput} from './contracts.js';
import {marketProfileSchema} from './market-profile.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const sourceSchema=z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative()}).strict();
const profileSnapshotSchema=z.object({pool:z.string().regex(/^0x[0-9a-fA-F]{40}$/),fee:z.number().int().positive(),
 tickSpacing:z.number().int().positive(),token0:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 token1:z.string().regex(/^0x[0-9a-fA-F]{40}$/),quoteToken:z.union([z.literal(0),z.literal(1)])}).strict();
const costGroupSchema=z.object({expectedGasUnits:raw,boundGasUnits:raw,expectedWei:raw,boundWei:raw,
 expectedValue:raw,boundValue:raw}).strict();
const reviewedCostsSchema=z.object({status:z.literal('provisional'),scope:z.literal('open_and_close_retain_gas_only'),
 pathVersion:z.string().min(1),sizeBand:z.string().min(1),gasPriceWei:raw,boundGasPriceWei:raw,
 gasPriceObservedAt:z.iso.datetime({offset:true}),nativeReferencePrice:raw,
 stages:z.array(z.object({stage:z.string().min(1),profileId:z.uuid(),version:z.number().int().positive(),
  evidenceClass:z.literal('fork_estimated'),expectedGasUnits:raw,boundGasUnits:raw,
  source:z.record(z.string(),z.unknown())}).strict()).length(6),
 open:costGroupSchema,closeRetain:costGroupSchema,missing:z.array(z.string())}).passthrough();
const referencesSchema=z.object({price0:raw,price1:raw,nativePrice:raw,
 proofHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const reviewSchema=z.object({profileId:z.uuid(),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 input:z.object({capitalQuoteRaw:raw,halfWidthTicks:z.number().int().positive(),
  limits:staticPaperLimitsSchema.optional()}).strict(),
 source:sourceSchema,profile:profileSnapshotSchema,
 range:z.object({centerTick:z.number().int(),centerAnchorTick:z.number().int(),
  halfWidthTicks:z.number().int().positive(),tickLower:z.number().int(),tickUpper:z.number().int(),
  fullWidthTicks:z.number().int().positive(),lowerPriceQuotePerBaseX18:raw,
  upperPriceQuotePerBaseX18:raw}).strict(),
 requirements:z.object({liquidity:raw,token0Raw:raw,token1Raw:raw,referenceValueQuoteRaw:raw,
  budgetResidualQuoteRaw:raw,
  sizingConvention:z.literal('maximize_v3_liquidity_under_independent_reference_quote_budget')}).strict(),
 references:referencesSchema,costs:reviewedCostsSchema
}).strict();
const limitsSchema=staticParameters.shape.limits.unwrap();
export const staticPaperDraftAdmissionInputSchema=z.object({requestId:z.uuid(),profileId:z.uuid(),capitalQuoteRaw:raw,
 halfWidthTicks:z.number().int().positive(),wallet:z.string().min(1).max(128),
 allocation:allocationSchema,limits:limitsSchema,reviewed:reviewSchema}).strict();

type Review=z.infer<typeof reviewSchema>;
type CostGroup={expectedGasUnits:string;boundGasUnits:string;expectedWei:string;boundWei:string;
 expectedValue:string;boundValue:string};
type AvailablePreflight={status:'available';kind:'paper_setup_preflight';mode:'paper';
 strategyId:'static_manual_v1';profileId:string;input:{capitalQuoteRaw:string;halfWidthTicks:number};
 profileHash:string;source:Review['source'];profile:Review['profile'];range:Review['range'];requirements:Review['requirements'];
 references:Review['references'];
 costs:{status:'provisional';scope:'open_and_close_retain_gas_only';pathVersion:string;sizeBand:string;
  gasPriceWei:string;boundGasPriceWei:string;gasPriceObservedAt:string;nativeReferencePrice:string;
  stages:{stage:string;profileId:string;version:number;evidenceClass:string;expectedGasUnits:string;
   boundGasUnits:string;source:Record<string,unknown>}[];open:CostGroup;closeRetain:CostGroup;missing:string[]}};

export type StaticPaperDraftAdmissionResult=
 |{status:'draft_created';draftId:string;revision:number;configHash:string;profileId:string;
   replayed:boolean;source:Review['source']|null;range:{tickLower:number;tickUpper:number}|null;allocationHash:string;
   limitations:readonly string[]}
 |{status:'unavailable';draftId:null;revision:null;configHash:null;profileId:string|null;
   missing:readonly string[];limitations:readonly string[]}
 |{status:'reconciliation_required';draftId:null;revision:null;configHash:null;profileId:string;
   reason:'deployment_draft_creation_result_invalid'|'deployment_draft_creation_outcome_unknown';retrySafe:true;
   limitations:readonly string[]}
 |{status:'request_conflict';requestId:string;profileId:string;
   missing:readonly ['draft_request_id_conflict'];limitations:readonly string[]};

const unavailable=(reason:string,profileId:string|null=null):StaticPaperDraftAdmissionResult=>({
 status:'unavailable',draftId:null,revision:null,configHash:null,profileId,missing:[reason],
 limitations:['static_manual_paper_only','wallet_ownership_and_funding_are_not_verified',
  'no_preview_or_operation_is_created','costs_remain_provisional_fork_estimates']});
const ceilDiv=(n:bigint,d:bigint)=>n===0n?0n:(n+d-1n)/d;
const valueUsdX18=(amount:bigint,priceX18:bigint,decimals:number)=>
 ceilDiv(amount*priceX18,10n**BigInt(decimals));

/** Selects only the immutable sizing identity from a displayed preflight.
 * Costs and freshness timestamps are deliberately excluded because they are
 * re-sampled during admission. */
export function staticPaperSetupReviewBinding(value:unknown):Review|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(row.status!=='available'||row.kind!=='paper_setup_preflight'||row.mode!=='paper'||
  row.strategyId!=='static_manual_v1')return null;
 const parsed=reviewSchema.safeParse({profileId:row.profileId,profileHash:row.profileHash,
  input:row.input,source:row.source,profile:row.profile,range:row.range,
  requirements:row.requirements,references:row.references,costs:row.costs});
 return parsed.success?parsed.data:null;
}

/** Re-runs canonical sizing and creates a paper draft only when the browser's
 * reviewed source/profile/range/allocation still matches exactly. */
export async function createStaticPaperDraftFromSetup(rawInput:unknown,deps:{
 runPreflight:(input:z.infer<typeof paperSetupPreflightInput>,
  pinnedSource:Review['source'])=>Promise<unknown>;
 loadProfile:(id:string)=>Promise<PaperSetupProfile|null>;
 findDraftRequest:(requestId:string,input:DraftInput)=>Promise<null|
  {status:'conflict'}|{status:'found';id:string;revision:number;configHash:string}>;
 createDraftWithRequestId:(requestId:string,input:DraftInput)=>Promise<
  {status:'conflict'}|{status:'created'|'replayed';id:string;revision:number;configHash:string}>;
 now?:()=>number;
}):Promise<StaticPaperDraftAdmissionResult>{
 const inputParsed=staticPaperDraftAdmissionInputSchema.safeParse(rawInput);
 if(!inputParsed.success)return unavailable('setup_draft_input_invalid');
 const input=inputParsed.data;
 let requested;
 try{requested=paperSetupPreflightInput.parse({profileId:input.profileId,
  capitalQuoteRaw:input.capitalQuoteRaw,halfWidthTicks:input.halfWidthTicks,limits:input.limits});}
 catch{return unavailable('setup_draft_input_invalid',input.profileId);}
 const config=staticManualParameters.safeParse({halfWidthTicks:input.halfWidthTicks,limits:input.limits});
 if(!config.success)return unavailable('static_manual_limits_invalid',input.profileId);
 let draft:DraftInput;
 try{draft=draftInput.parse({mode:'paper',chainId:ROBINHOOD_CHAIN_ID,wallet:input.wallet,
  marketProfileId:input.profileId,strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:input.allocation,config:config.data});}
 catch{return unavailable('static_manual_draft_schema_rejected',input.profileId);}
 let existing:Awaited<ReturnType<typeof deps.findDraftRequest>>;
 try{existing=await deps.findDraftRequest(input.requestId,draft);}
 catch{return unavailable('draft_request_lookup_unavailable',input.profileId);}
 if(existing?.status==='conflict')return {status:'request_conflict',requestId:input.requestId,
  profileId:input.profileId,missing:['draft_request_id_conflict'],
  limitations:['request_id_is_already_bound_to_different_saved_draft','no_preflight_or_mutation_attempted']};
 if(existing?.status==='found')return {status:'draft_created',draftId:existing.id,revision:existing.revision,
  configHash:existing.configHash,profileId:input.profileId,replayed:true,source:null,range:null,
  allocationHash:contentHash(input.allocation),limitations:['existing_matching_draft_replayed',
   'reviewed_source_not_replayed_from_store','wallet_ownership_and_funding_are_not_verified',
   'no_preview_or_operation_is_created']};
 let preflightRaw:unknown;
 try{preflightRaw=await deps.runPreflight(requested,input.reviewed.source);}
 catch{return unavailable('canonical_setup_preflight_failed',input.profileId);}
 const reviewed=staticPaperSetupReviewBinding(preflightRaw),fresh=freshPreflightSchema.safeParse(preflightRaw);
 if(!reviewed||!fresh.success)return unavailable('fresh_canonical_setup_preflight_unavailable',input.profileId);
 if(contentHash(reviewWithoutCostTime(reviewed))!==contentHash(reviewWithoutCostTime(input.reviewed))||
  reviewed.profileId!==input.profileId||reviewed.input.capitalQuoteRaw!==input.capitalQuoteRaw||
  reviewed.input.halfWidthTicks!==input.halfWidthTicks)
  return unavailable('setup_review_binding_stale',input.profileId);
 const now=(deps.now??Date.now)();
 if(!freshTimestamp(reviewed.source.timestamp,now,180_000)||
  !freshTimestampMs(Date.parse(input.reviewed.costs.gasPriceObservedAt),now,180_000)||
  !freshTimestamp(fresh.data.source.timestamp,now,180_000)||
  !freshTimestampMs(Date.parse(fresh.data.costs.gasPriceObservedAt),now,180_000))
  return unavailable('setup_review_evidence_expired',input.profileId);
 try{
  if(contentHash(costIdentity(input.reviewed.costs))!==contentHash(costIdentity(fresh.data.costs)))
   return unavailable('setup_cost_evidence_changed_since_review',input.profileId);
 }catch{return unavailable('setup_draft_input_invalid',input.profileId);}
 if(input.allocation.token0Raw!==reviewed.requirements.token0Raw||
  input.allocation.token1Raw!==reviewed.requirements.token1Raw)
  return unavailable('setup_allocation_does_not_match_fresh_preflight',input.profileId);

 let registered:PaperSetupProfile|null;
 try{registered=await deps.loadProfile(input.profileId);}catch{return unavailable('registered_market_profile_unavailable',input.profileId);}
 if(!registered||registered.id!==input.profileId)return unavailable('registered_market_profile_unavailable',input.profileId);
 const profile=marketProfileSchema.safeParse(registered.profile);
 if(!profile.success||contentHash(profile.data)!==registered.profileHash||
  registered.profileHash!==reviewed.profileHash)
  return unavailable('registered_market_profile_integrity',input.profileId);
 const pool=profile.data.pool;
 if(pool.pool.toLowerCase()!==reviewed.profile.pool.toLowerCase()||
  pool.token0.toLowerCase()!==reviewed.profile.token0.toLowerCase()||
  pool.token1.toLowerCase()!==reviewed.profile.token1.toLowerCase()||
  pool.fee!==reviewed.profile.fee||pool.tickSpacing!==reviewed.profile.tickSpacing||
  pool.quoteToken!==(reviewed.profile.quoteToken))
  return unavailable('registered_profile_changed_since_preflight',input.profileId);

 const limits=config.data.limits;
 if(!limits)return unavailable('static_manual_limits_missing',input.profileId);
 const positiveRaw=['maxDeploymentValue','minDeploymentValue','maxLossValue','maxActionCost',
  'maxRollingCost','maxCampaignCost','exitReserveWei'] as const;
 if(positiveRaw.some(field=>BigInt(limits[field])<=0n)||limits.maxExposurePpm<=0||
  limits.maxDrawdownPpm<=0||limits.maxSlippageBps<=0||
  BigInt(limits.minDeploymentValue)>BigInt(limits.maxDeploymentValue)||
  BigInt(limits.maxActionCost)>BigInt(limits.maxRollingCost))
  return unavailable('static_manual_limits_inconsistent',input.profileId);

 const costs=fresh.data.costs,openBound=BigInt(costs.open.boundValue),
  closeBound=BigInt(costs.closeRetain.boundValue),openBoundWei=BigInt(costs.open.boundWei),
  closeBoundWei=BigInt(costs.closeRetain.boundWei),nativeWei=BigInt(input.allocation.nativeWei),
  exitReserve=BigInt(limits.exitReserveWei),
  deployedUsdX18=valueUsdX18(BigInt(input.allocation.token0Raw),BigInt(fresh.data.references.price0),pool.decimals0)+
   valueUsdX18(BigInt(input.allocation.token1Raw),BigInt(fresh.data.references.price1),pool.decimals1);
 if(deployedUsdX18<BigInt(limits.minDeploymentValue)||deployedUsdX18>BigInt(limits.maxDeploymentValue))
  return unavailable('allocation_outside_deployment_value_limits',input.profileId);
 if(openBound>BigInt(limits.maxActionCost)||openBound>BigInt(limits.maxRollingCost)||
  openBound+closeBound>BigInt(limits.maxCampaignCost))
  return unavailable('provisional_cost_exceeds_static_limits',input.profileId);
 const requiredNative=openBoundWei+(exitReserve>closeBoundWei?exitReserve:closeBoundWei);
 if(nativeWei<requiredNative)return unavailable('native_allocation_below_cost_and_exit_reserve',input.profileId);

 let created:Awaited<ReturnType<typeof deps.createDraftWithRequestId>>;
 try{created=await deps.createDraftWithRequestId(input.requestId,draft);}
 catch{return {status:'reconciliation_required',draftId:null,revision:null,configHash:null,
  profileId:input.profileId,reason:'deployment_draft_creation_outcome_unknown',retrySafe:true,
  limitations:['draft_store_call_failed_with_outcome_unknown',
   'do_not_retry_until_saved_campaign_state_is_reconciled']};}
 if(created?.status==='conflict')return {status:'request_conflict',requestId:input.requestId,
  profileId:input.profileId,missing:['draft_request_id_conflict'],
  limitations:['request_id_is_already_bound_to_different_saved_draft','no_new_draft_created']};
 if(!created||!['created','replayed'].includes(created.status)||
  !z.uuid().safeParse(created.id).success||!Number.isSafeInteger(created.revision)||
  created.revision<=0||!/^[0-9a-f]{64}$/.test(created.configHash))
  return {status:'reconciliation_required',draftId:null,revision:null,configHash:null,
   profileId:input.profileId,reason:'deployment_draft_creation_result_invalid',retrySafe:true,
   limitations:['draft_creation_call_resolved_but_returned_binding_is_invalid',
    'do_not_retry_until_saved_campaign_state_is_reconciled']};
 return {status:'draft_created',draftId:created.id,revision:created.revision,configHash:created.configHash,
  replayed:created.status==='replayed',
  profileId:input.profileId,source:fresh.data.source,
  range:{tickLower:reviewed.range.tickLower,tickUpper:reviewed.range.tickUpper},
  allocationHash:contentHash(input.allocation),
  limitations:['paper_draft_only','wallet_ownership_and_funding_are_not_verified',
   'policy_limits_are_stored_but_no_open_operation_is_created','provisional_costs_are_not_paid_costs']};
}

const freshPreflightSchema=z.object({status:z.literal('available'),kind:z.literal('paper_setup_preflight'),
 mode:z.literal('paper'),strategyId:z.literal('static_manual_v1'),profileId:z.uuid(),
 input:reviewSchema.shape.input,source:sourceSchema,profile:profileSnapshotSchema,
 range:reviewSchema.shape.range,requirements:reviewSchema.shape.requirements,
 references:referencesSchema,
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 costs:reviewedCostsSchema
}).passthrough();

function freshTimestamp(timestamp:number,now:number,maxAgeMs:number){
 if(!Number.isSafeInteger(timestamp)||timestamp<0)return false;
 const age=now-timestamp*1000;
 return age>=0&&age<=maxAgeMs;
}
function freshTimestampMs(timestamp:number,now:number,maxAgeMs:number){
 if(!Number.isSafeInteger(timestamp)||timestamp<0)return false;
 const age=now-timestamp;
 return age>=0&&age<=maxAgeMs;
}
function reviewWithoutCostTime(value:Review){
 const {costs:_costs,...binding}=value;
 return binding;
}
function costIdentity(value:unknown){
 const costs=freshPreflightSchema.shape.costs.parse(value);
 return {scope:costs.scope,pathVersion:costs.pathVersion,sizeBand:costs.sizeBand,
  gasPriceWei:costs.gasPriceWei,boundGasPriceWei:costs.boundGasPriceWei,
  nativeReferencePrice:costs.nativeReferencePrice,
  stages:costs.stages.map(stage=>({stage:stage.stage,profileId:stage.profileId,version:stage.version,
   evidenceClass:stage.evidenceClass,expectedGasUnits:stage.expectedGasUnits,
   boundGasUnits:stage.boundGasUnits,source:stage.source})),
  open:costs.open,closeRetain:costs.closeRetain};
}
