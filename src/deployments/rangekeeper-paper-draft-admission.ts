import {z} from 'zod';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {rangeKeeperSetupPreflightInput,type RangeKeeperSetupPreflightInput} from './rangekeeper-paper-setup-preflight.js';
import type {PaperSetupProfile} from './paper-setup-preflight.js';
import {allocationSchema,contentHash,draftInput,rangeKeeperLimitsSchema,rangeKeeperParameters,
 rangeKeeperPaperSetupConfigHash,type DraftInput} from './contracts.js';
import {marketProfileSchema} from './market-profile.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import type {RangeKeeperPaperSetupReviewInput} from './rangekeeper-paper-setup-review-cache.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const sourceSchema=z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative()}).strict();
const profileSnapshotSchema=z.object({pool:z.string().regex(/^0x[0-9a-fA-F]{40}$/),fee:z.number().int().positive(),
 tickSpacing:z.number().int().positive(),token0:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 token1:z.string().regex(/^0x[0-9a-fA-F]{40}$/),quoteToken:z.union([z.literal(0),z.literal(1)])}).strict();
const costGroupSchema=z.object({expectedGasUnits:raw,boundGasUnits:raw,expectedWei:raw,boundWei:raw,
 expectedValue:raw,boundValue:raw}).strict();
const retainExitGroupSchema=costGroupSchema.extend({requiredReserveWei:raw});
const reviewedCostsSchema=z.object({status:z.literal('provisional'),
 scope:z.literal('range_keeper_open_and_retain_exit_gas_only'),evidenceClass:z.literal('fork_estimated'),
 pathVersion:z.string().min(1),sizeBand:z.string().regex(/^rk_[0-9a-f]{32}$/),
 profileIds:z.array(z.object({stage:z.string().min(1),id:z.string().min(1),
  version:z.number().int().positive()}).strict()).min(3).max(12),
 marketGasPriceWei:raw,boundGasPriceWei:raw,gasPriceObservedAt:z.iso.datetime({offset:true}),
 nativeReferencePrice:raw,swapFeeAndShortfallValue:raw,open:costGroupSchema,retainExit:retainExitGroupSchema,
 unavailable:z.array(z.string())}).passthrough();
const referencesSchema=z.object({price0:raw,price1:raw,nativePrice:raw,
 proofHash:z.string().regex(/^[0-9a-f]{64}$/),
 proofIdentityHash:z.string().regex(/^[0-9a-f]{64}$/).optional()}).strict();
const rangeSchema=z.object({tickLower:z.number().int(),tickUpper:z.number().int(),centerTick:z.number().int(),
 fullWidthSpacings:z.number().int().positive()}).strict();
const requirementsSchema=z.object({liquidity:raw,token0Raw:raw,token1Raw:raw,referenceValueQuoteRaw:raw,
 budgetResidualQuoteRaw:raw,deployedValueUsdX18:raw,sharePpm:raw,
 sizingConvention:z.literal(
  'maximize_v3_liquidity_under_independent_reference_quote_budget_then_kernel_sized')}).strict();
const reviewSchema=z.object({profileId:z.uuid(),profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 input:z.object({capitalQuoteRaw:raw,fullWidthSpacings:z.number().int().positive(),
  limits:rangeKeeperLimitsSchema}).strict(),
 source:sourceSchema,profile:profileSnapshotSchema,range:rangeSchema,requirements:requirementsSchema,
 references:referencesSchema,costs:reviewedCostsSchema}).strict();

type Review=z.infer<typeof reviewSchema>;
const limitsSchema=rangeKeeperLimitsSchema;
export const rangeKeeperPaperDraftAdmissionInputSchema=z.object({requestId:z.uuid(),reviewId:z.uuid(),
 profileId:z.uuid(),capitalQuoteRaw:raw,fullWidthSpacings:z.number().int().positive(),
 wallet:z.string().min(1).max(128),allocation:allocationSchema,limits:limitsSchema,
 reviewed:reviewSchema}).strict();

export type RangeKeeperPaperDraftAdmissionResult=
 |{status:'draft_created';draftId:string;revision:number;configHash:string;profileId:string;
   replayed:boolean;source:Review['source']|null;range:{tickLower:number;tickUpper:number}|null;
   allocationHash:string;limitations:readonly string[]}
 |{status:'unavailable';draftId:null;revision:null;configHash:null;profileId:string|null;
   missing:readonly string[];limitations:readonly string[]}
 |{status:'reconciliation_required';draftId:null;revision:null;configHash:null;profileId:string;
   reason:'deployment_draft_creation_result_invalid'|'deployment_draft_creation_outcome_unknown';retrySafe:true;
   limitations:readonly string[]}
 |{status:'request_conflict';requestId:string;profileId:string;
   missing:readonly ['draft_request_id_conflict'];limitations:readonly string[]};

const unavailable=(reason:string,profileId:string|null=null):RangeKeeperPaperDraftAdmissionResult=>({
 status:'unavailable',draftId:null,revision:null,configHash:null,profileId,missing:[reason],
 limitations:['rangekeeper_paper_only','wallet_ownership_and_funding_are_not_verified',
  'no_preview_or_operation_is_created','costs_remain_provisional_fork_estimates']});
const ceilDiv=(n:bigint,d:bigint)=>n===0n?0n:(n+d-1n)/d;
const valueUsdX18=(amount:bigint,priceX18:bigint,decimals:number)=>ceilDiv(amount*priceX18,10n**BigInt(decimals));

/** Selects only the immutable sizing identity from a displayed review. Costs
 * and freshness timestamps are deliberately excluded because they are
 * re-sampled during admission. */
export function rangeKeeperPaperSetupReviewBinding(value:unknown):Review|null{
 if(!value||typeof value!=='object')return null;
 const row=value as Record<string,unknown>;
 if(row.status!=='available'||row.kind!=='rangekeeper_paper_setup_preflight'||row.mode!=='paper'||
  row.strategyId!=='rangekeeper_v1')return null;
 const parsed=reviewSchema.safeParse({profileId:row.profileId,profileHash:row.profileHash,
  input:row.input,source:row.source,profile:row.profile,range:row.range,
  requirements:row.requirements,references:row.references,costs:row.costs});
 return parsed.success?parsed.data:null;
}

const freshPreflightSchema=z.object({status:z.literal('available'),kind:z.literal('rangekeeper_paper_setup_preflight'),
 mode:z.literal('paper'),strategyId:z.literal('rangekeeper_v1'),profileId:z.uuid(),
 input:reviewSchema.shape.input,source:sourceSchema,profile:profileSnapshotSchema,
 range:reviewSchema.shape.range,requirements:reviewSchema.shape.requirements,references:referencesSchema,
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),costs:reviewedCostsSchema}).passthrough();

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
function reviewBindingIdentity(value:Review,useStableProofIdentity:boolean){
 const {costs:_costs,...binding}=value;
 const {references,...rest}=binding;
 if(useStableProofIdentity){
  const {proofHash:_fullProofHash,...stableReferences}=references;
  return {...rest,references:stableReferences};
 }
 const {proofIdentityHash:_optionalStableHash,...legacyReferences}=references;
 return {...rest,references:legacyReferences};
}
function costIdentity(value:unknown){
 const costs=freshPreflightSchema.shape.costs.parse(value);
 return {scope:costs.scope,pathVersion:costs.pathVersion,sizeBand:costs.sizeBand,
  marketGasPriceWei:costs.marketGasPriceWei,boundGasPriceWei:costs.boundGasPriceWei,
  nativeReferencePrice:costs.nativeReferencePrice,profileIds:costs.profileIds,
  open:costs.open,retainExit:costs.retainExit};
}
function costStructureIdentity(value:unknown,stableReferenceIdentity=false){
 const costs=freshPreflightSchema.shape.costs.parse(value);
 // Setup rows are sampled afresh and never registered. Their candidate band
 // includes the full proof hash, including HTTP fetch timestamps. Once the
 // exact source, sizing, limits and stable proof have matched, compare the
 // actual path/stages/gas bounds rather than this transport-dependent band.
 return {scope:costs.scope,pathVersion:costs.pathVersion,
  ...(stableReferenceIdentity?{}:{sizeBand:costs.sizeBand}),
  nativeReferencePrice:costs.nativeReferencePrice,profileIds:costs.profileIds,
  open:{expectedGasUnits:costs.open.expectedGasUnits,boundGasUnits:costs.open.boundGasUnits},
  retainExit:{expectedGasUnits:costs.retainExit.expectedGasUnits,boundGasUnits:costs.retainExit.boundGasUnits}};
}
/** The RangeKeeper modeled cost groups are already aggregated totals (no
 * per-stage breakdown survives past selectRangeKeeperPaperCostProfiles), so
 * coverage only needs the aggregate bound gas units per group, unlike the
 * static path's per-stage replay. */
function reviewedCostsCoverFreshGasQuote(value:Review['costs'],freshGasPrice:bigint):boolean{
 try{
  const capturedPrice=BigInt(value.marketGasPriceWei),capturedBoundPrice=BigInt(value.boundGasPriceWei),
   nativePrice=BigInt(value.nativeReferencePrice),expectedBoundPrice=(capturedPrice*5n+3n)/4n;
  if(capturedPrice<=0n||nativePrice<=0n||freshGasPrice<=0n||capturedBoundPrice!==expectedBoundPrice||
   freshGasPrice>capturedBoundPrice)return false;
  for(const model of [value.open,value.retainExit]){
   const boundGas=BigInt(model.boundGasUnits);
   if(boundGas<=0n||boundGas*freshGasPrice>BigInt(model.boundWei))return false;
  }
  return true;
 }catch{return false;}
}

/** Re-runs canonical sizing and creates a RangeKeeper paper draft only when
 * the browser's reviewed source/profile/range/allocation still matches
 * exactly. Mirrors createStaticPaperDraftFromSetup; the differences are the
 * RangeKeeper cost shape (aggregated, not per-stage) and that limits are
 * re-validated by replaying resolveRangeKeeperPaperPolicy rather than by
 * static's flat field checks, since the kernel's acceptance rules (the
 * minDeploymentPpm floor coverage requirement in particular) are not
 * expressible as independent field bounds. */
export async function createRangeKeeperPaperDraftFromSetup(rawInput:unknown,deps:{
 runPreflight:(input:RangeKeeperSetupPreflightInput,pinnedSource:Review['source'])=>Promise<unknown>;
 loadProfile:(id:string)=>Promise<PaperSetupProfile|null>;
 findDraftRequest:(requestId:string,input:DraftInput)=>Promise<null|
  {status:'conflict'}|{status:'found';id:string;revision:number;configHash:string}>;
 lookupCapturedReview:(input:RangeKeeperPaperSetupReviewInput)=>{costs:Record<string,unknown>}|null;
 createDraftWithRequestId:(requestId:string,input:DraftInput)=>Promise<
  {status:'conflict'}|{status:'created'|'replayed';id:string;revision:number;configHash:string}>;
 now?:()=>number;
}):Promise<RangeKeeperPaperDraftAdmissionResult>{
 const inputParsed=rangeKeeperPaperDraftAdmissionInputSchema.safeParse(rawInput);
 if(!inputParsed.success)return unavailable('setup_draft_input_invalid');
 const input=inputParsed.data;
 let requested:RangeKeeperSetupPreflightInput;
 try{requested=rangeKeeperSetupPreflightInput.parse({profileId:input.profileId,
  capitalQuoteRaw:input.capitalQuoteRaw,fullWidthSpacings:input.fullWidthSpacings,limits:input.limits});}
 catch{return unavailable('setup_draft_input_invalid',input.profileId);}
 const config=rangeKeeperParameters.safeParse({fullWidthSpacings:input.fullWidthSpacings,limits:input.limits});
 if(!config.success)return unavailable('rangekeeper_limits_invalid',input.profileId);
 let draft:DraftInput;
 try{draft=draftInput.parse({mode:'paper',chainId:ROBINHOOD_CHAIN_ID,wallet:input.wallet,
  marketProfileId:input.profileId,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:input.allocation,config:config.data});}
 catch{return unavailable('rangekeeper_draft_schema_rejected',input.profileId);}
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
 const captured=deps.lookupCapturedReview({reviewId:input.reviewId,profileId:input.profileId,
  capitalQuoteRaw:input.capitalQuoteRaw,fullWidthSpacings:input.fullWidthSpacings,limits:input.limits,
  reviewed:input.reviewed as unknown as Record<string,unknown>});
 if(!captured)return unavailable('setup_review_cache_miss',input.profileId);
 let preflightRaw:unknown;
 try{preflightRaw=await deps.runPreflight(requested,input.reviewed.source);}
 catch{return unavailable('canonical_setup_preflight_failed',input.profileId);}
 const reviewed=rangeKeeperPaperSetupReviewBinding(preflightRaw),fresh=freshPreflightSchema.safeParse(preflightRaw);
 if(!reviewed||!fresh.success){
  const result=unavailable('fresh_canonical_setup_preflight_unavailable',input.profileId);
  const detail=z.object({status:z.literal('unavailable'),missing:z.array(
   z.string().regex(/^[a-z0-9_:,-]{1,160}$/)).max(12)}).safeParse(preflightRaw);
  return detail.success&&result.status==='unavailable'?
   {...result,missing:[...result.missing,...detail.data.missing]}:result;
 }
 const useStableProofIdentity=!!input.reviewed.references.proofIdentityHash;
 if(contentHash(reviewBindingIdentity(reviewed,useStableProofIdentity))!==
  contentHash(reviewBindingIdentity(input.reviewed,useStableProofIdentity))||
  reviewed.profileId!==input.profileId||reviewed.input.capitalQuoteRaw!==input.capitalQuoteRaw||
  reviewed.input.fullWidthSpacings!==input.fullWidthSpacings||
  contentHash(reviewed.input.limits)!==contentHash(requested.limits))
  return unavailable('setup_review_binding_stale',input.profileId);
 const now=(deps.now??Date.now)();
 if(!freshTimestamp(reviewed.source.timestamp,now,180_000)||
  !freshTimestampMs(Date.parse(input.reviewed.costs.gasPriceObservedAt),now,180_000)||
  !freshTimestamp(fresh.data.source.timestamp,now,180_000)||
  !freshTimestampMs(Date.parse(fresh.data.costs.gasPriceObservedAt),now,180_000))
  return unavailable('setup_review_evidence_expired',input.profileId);
 let approvedCosts:Review['costs'];
 try{
  approvedCosts=reviewedCostsSchema.parse(captured.costs);
  if(contentHash(costIdentity(input.reviewed.costs))!==contentHash(costIdentity(approvedCosts)))
   return unavailable('setup_review_cache_miss',input.profileId);
  if(contentHash(costStructureIdentity(approvedCosts,useStableProofIdentity))!==
   contentHash(costStructureIdentity(fresh.data.costs,useStableProofIdentity)))
   return unavailable('setup_cost_evidence_changed_since_review',input.profileId);
  if(!reviewedCostsCoverFreshGasQuote(approvedCosts,BigInt(fresh.data.costs.marketGasPriceWei)))
   return unavailable('setup_gas_price_exceeds_reviewed_bound',input.profileId);
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
  pool.quoteToken!==reviewed.profile.quoteToken)
  return unavailable('registered_profile_changed_since_preflight',input.profileId);

 const limits=config.data.limits;
 if(!limits)return unavailable('rangekeeper_limits_missing',input.profileId);
 // Re-validate the submitted limits the same way the open kernel will, by
 // replaying its own resolver — not by re-deriving its acceptance rules here.
 const syntheticDraft:RangeKeeperPaperDraft={id:input.profileId,revision:1,profile:profile.data,
  profileHash:registered.profileHash,
  configHash:rangeKeeperPaperSetupConfigHash({fullWidthSpacings:input.fullWidthSpacings,limits}),
  strategyId:'rangekeeper_v1',parameters:{fullWidthSpacings:input.fullWidthSpacings,limits},
  allocation:{token0Raw:'0',token1Raw:'0',nativeWei:'0'}};
 const resolved=resolveRangeKeeperPaperPolicy(syntheticDraft,'0'.repeat(64));
 if(!resolved.policy||resolved.unavailable.length)
  return unavailable(resolved.unavailable.join(',')||'rangekeeper_limits_inconsistent',input.profileId);
 if(BigInt(limits.maxActionCost)>BigInt(limits.maxRollingCost))
  return unavailable('rangekeeper_limits_inconsistent',input.profileId);

 const costs=approvedCosts,openBound=BigInt(costs.open.boundValue),retainBound=BigInt(costs.retainExit.boundValue),
  openBoundWei=BigInt(costs.open.boundWei),retainRequiredReserve=BigInt(costs.retainExit.requiredReserveWei),
  nativeWei=BigInt(input.allocation.nativeWei),exitReserve=BigInt(limits.exitReserveWei),
  deployedUsdX18=valueUsdX18(BigInt(input.allocation.token0Raw),BigInt(fresh.data.references.price0),pool.decimals0)+
   valueUsdX18(BigInt(input.allocation.token1Raw),BigInt(fresh.data.references.price1),pool.decimals1);
 if(deployedUsdX18<BigInt(limits.minDeploymentValue)||deployedUsdX18>BigInt(limits.maxDeploymentValue))
  return unavailable('allocation_outside_deployment_value_limits',input.profileId);
 if(openBound>BigInt(limits.maxActionCost)||openBound>BigInt(limits.maxRollingCost)||
  openBound+retainBound>BigInt(limits.maxCampaignCost))
  return unavailable('provisional_cost_exceeds_rangekeeper_limits',input.profileId);
 const requiredReserve=exitReserve>retainRequiredReserve?exitReserve:retainRequiredReserve,
  requiredNative=openBoundWei+requiredReserve;
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
