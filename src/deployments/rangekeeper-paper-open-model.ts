import type {RobinhoodClient} from '../client.js';
import {MAX_TICK,MIN_TICK,sqrtRatioAtTick} from '../backtest/principal.js';
import type {RangeKeeperLimits,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {planRangeKeeper,rawValue} from '../strategy/rangekeeper/planner.js';
import {contentHash,rangeKeeperParameters} from './contracts.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame,type PaperPreviewDraft} from './paper-preview.js';

const WAD=10n**18n;
const nonnegative=(value:bigint)=>value>=0n;

/** The draft schema stores the user-selected width and common limits, while
 * the frozen RangeKeeper kernel needs additional strategy-specific limits.
 * This is supplied by a trusted server-side policy resolver; never by HTTP. */
export interface RangeKeeperPaperKernelPolicy {
 fullWidthSpacings:number;
 limits:RangeKeeperLimits;
 buildId:string;
}

type RangeKeeperPaperDraft=PaperPreviewDraft&{
 strategyId:'rangekeeper_v1';
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string};
 profile:MarketProfile;
};

export interface RangeKeeperPaperOpenModel {
 schemaVersion:1;
 kind:'rangekeeper_paper_open_model';
 status:'unavailable'|'blocked';
 blockingReason:string|null;
 campaignId:string;
 revision:number;
 strategyId:'rangekeeper_v1';
 strategyVersion:'1.0.0';
 draftConfigHash:string;
 kernelPolicyHash:string|null;
 kernelBuildId:string|null;
 profileHash:string;
 source:PaperOpenFrame['source'];
 poolState:{tick:number;sqrtPriceX96:string;poolLiquidity:string};
 reference:{price0:string|null;price1:string|null;nativePrice:string|null;
  eligible:boolean;proofHash:string;reasons:string[]};
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string;
  token0Value:string|null;token1Value:string|null;nativeValue:string|null;
  strategyInventoryValue:string|null;totalAllocatedValue:string|null};
 decision:null|{status:'blocked';reason:string;kernelAction:'wait'|'safety_exit'|'confirm'|'execute';
  kernelReason:string;candidate:null;
  remaining:{action:string;rolling:string;campaign:string;nativeWei:string}};
 execution:{classification:'read_only_hypothetical';fillRecorded:false;
  paidCosts:string|null;modeledOpenCost:string|null;modeledExitReserve:string|null;
  configuredExitReserveWei:string|null;
  feeAccrual:string|null;netNav:string|null;absolutePnl:string|null;passiveAlpha:string|null};
 unavailable:string[];
}

function emptyModel(draft:RangeKeeperPaperDraft,frame:PaperOpenFrame,
 unavailable:string[],kernelPolicyHash:string|null,kernelBuildId:string|null,
 configuredExitReserveWei:string|null):RangeKeeperPaperOpenModel{
 const p=draft.profile.pool,amount0=BigInt(draft.allocation.token0Raw),amount1=BigInt(draft.allocation.token1Raw),
  native=BigInt(draft.allocation.nativeWei);
 const token0Value=frame.price0===null?null:rawValue(amount0,frame.price0,p.decimals0);
 const token1Value=frame.price1===null?null:rawValue(amount1,frame.price1,p.decimals1);
 const nativeValue=frame.nativePrice===null?null:native*frame.nativePrice/WAD;
 const strategyInventoryValue=token0Value===null||token1Value===null?null:token0Value+token1Value;
 const totalAllocatedValue=strategyInventoryValue===null||nativeValue===null?null:strategyInventoryValue+nativeValue;
 return {schemaVersion:1,kind:'rangekeeper_paper_open_model',status:'unavailable',blockingReason:null,
  campaignId:draft.id,revision:draft.revision,
  strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',draftConfigHash:draft.configHash,
  kernelPolicyHash,kernelBuildId,profileHash:draft.profileHash,source:frame.source,
  poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity)},
  reference:{price0:frame.price0===null?null:String(frame.price0),price1:frame.price1===null?null:String(frame.price1),
   nativePrice:frame.nativePrice===null?null:String(frame.nativePrice),eligible:frame.referenceEligible,
   proofHash:frame.referenceProofHash,reasons:[...frame.referenceReasons]},
  allocation:{token0Raw:String(amount0),token1Raw:String(amount1),nativeWei:String(native),
   token0Value:token0Value===null?null:String(token0Value),token1Value:token1Value===null?null:String(token1Value),
   nativeValue:nativeValue===null?null:String(nativeValue),
   strategyInventoryValue:strategyInventoryValue===null?null:String(strategyInventoryValue),
   totalAllocatedValue:totalAllocatedValue===null?null:String(totalAllocatedValue)},
  decision:null,execution:{classification:'read_only_hypothetical',fillRecorded:false,paidCosts:null,
   modeledOpenCost:null,modeledExitReserve:null,configuredExitReserveWei,
   feeAccrual:null,netNav:null,absolutePnl:null,passiveAlpha:null},
  unavailable:[...new Set(unavailable)],
 };
}

function validatePolicy(draft:RangeKeeperPaperDraft,policy:RangeKeeperPaperKernelPolicy|null){
 if(!policy)return {reason:'rangekeeper_full_kernel_policy_unavailable',hash:null};
 if(!policy.buildId)return {reason:'rangekeeper_build_identity_unavailable',hash:null};
 const parsed=rangeKeeperParameters.safeParse(draft.parameters);
 if(!parsed.success)return {reason:'rangekeeper_draft_parameters_invalid',hash:null};
 if(!parsed.data.limits)return {reason:'rangekeeper_common_limits_unavailable',hash:null};
 const limits=policy.limits,configured=parsed.data.limits;
 const shared:[keyof typeof configured,bigint|number][]=[
  ['maxDeploymentValue',limits.maxDeploymentValue],['maxExposurePpm',limits.maxExposurePpm],
  ['maxLossValue',limits.maxLossValue],['maxDrawdownPpm',limits.maxDrawdownPpm],
  ['maxActionCost',limits.maxActionCost],['maxRollingCost',limits.maxRollingCost],
  ['maxCampaignCost',limits.maxCampaignCost],['exitReserveWei',limits.exitReserveWei],
  ['maxSlippageBps',limits.maxSlippageBps],
 ];
 for(const [key,value] of shared)
  if(String(configured[key])!==String(value))return {reason:`rangekeeper_kernel_policy_mismatch:${key}`,hash:null};
 const integerFields=[policy.fullWidthSpacings,limits.fullWidthSpacings,limits.maxDeploymentValue,limits.minDeploymentPpm,
  limits.maxSwapInputValue,limits.maxSwapInputPpm,limits.maxSwapShortfallValue,limits.maxSlippageBps,
  limits.maxActionCost,limits.maxRollingCost,limits.maxCampaignCost,limits.maxExposurePpm,
  limits.maxLossValue,limits.maxDrawdownPpm,limits.maxRecenters,limits.maxLiquiditySharePpm,
  limits.maxObservationGapSeconds,limits.exitReserveWei];
 if(!integerFields.every(value=>typeof value==='number'?Number.isSafeInteger(value):nonnegative(value))||
  policy.fullWidthSpacings!==parsed.data.fullWidthSpacings||
  limits.fullWidthSpacings!==policy.fullWidthSpacings||policy.fullWidthSpacings<=0||
  policy.fullWidthSpacings%2!==0||limits.maxDeploymentValue<=0n||limits.minDeploymentPpm<=0||
  limits.minDeploymentPpm>1_000_000||limits.maxSwapInputValue<=0n||limits.maxSwapInputPpm<=0||
  limits.maxSwapInputPpm>1_000_000||limits.maxSwapShortfallValue<=0n||limits.maxSlippageBps<=0||
  limits.maxSlippageBps>50||limits.maxActionCost<=0n||limits.maxRollingCost<=0n||
  limits.maxCampaignCost<=0n||limits.maxRollingCost>limits.maxCampaignCost||limits.maxExposurePpm<=0||
  limits.maxExposurePpm>1_000_000||limits.maxLiquiditySharePpm<=0||
  limits.maxLossValue<=0n||limits.maxDrawdownPpm<=0||limits.maxDrawdownPpm>1_000_000||
  limits.maxLiquiditySharePpm>1_000_000||limits.maxObservationGapSeconds<30||
  limits.maxObservationGapSeconds>90||limits.exitReserveWei<=0n)
  return {reason:'rangekeeper_kernel_policy_invalid',hash:null};
 const hash=contentHash({marketProfileHash:draft.profileHash,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  parameters:parsed.data,
  fullWidthSpacings:policy.fullWidthSpacings,limits:Object.fromEntries(
   Object.entries(limits).map(([key,value])=>[key,typeof value==='bigint'?String(value):value]))});
 return {reason:null,hash};
}

/** Build a paper-only open decision from an already verified canonical frame.
 * Missing RangeKeeper paper cost evidence is passed into the frozen kernel as
 * null, so the kernel cannot admit a synthetic entry from live gas envelopes. */
export async function buildRangeKeeperPaperOpenModel(draft:RangeKeeperPaperDraft,frame:PaperOpenFrame,
 policy:RangeKeeperPaperKernelPolicy|null,now=Date.now()):Promise<RangeKeeperPaperOpenModel>{
 if(draft.strategyId!=='rangekeeper_v1')throw Error('rangekeeper_paper_strategy_mismatch');
 const unavailable:string[]=[];
 if(!frame.referenceProof||referenceProofHash(frame.referenceProof)!==frame.referenceProofHash)
  unavailable.push('canonical_reference_proof_unavailable');
 const tickValid=Number.isSafeInteger(frame.tick)&&frame.tick>=MIN_TICK&&frame.tick<=MAX_TICK;
 let tickPriceValid=false;
 if(tickValid&&frame.sqrtPriceX96>0n){
  const lower=sqrtRatioAtTick(frame.tick);
  tickPriceValid=frame.tick===MAX_TICK?frame.sqrtPriceX96===lower:
   frame.sqrtPriceX96>=lower&&frame.sqrtPriceX96<sqrtRatioAtTick(frame.tick+1);
 }
 if(!tickPriceValid||frame.poolLiquidity<0n)unavailable.push('canonical_pool_state_unavailable');
 if(!/^0x[0-9a-fA-F]{64}$/.test(frame.source.hash)||
  !/^(0|[1-9][0-9]*)$/.test(frame.source.block)||!Number.isSafeInteger(frame.source.timestamp)||
  frame.source.timestamp<0)unavailable.push('canonical_source_identity_unavailable');
 const age=Math.floor(now/1000)-frame.source.timestamp;
 if(age<0||age>180)unavailable.push('canonical_source_stale');
 const resolved=validatePolicy(draft,policy);
 if(resolved.reason)unavailable.push(resolved.reason);
 const draftParameters=rangeKeeperParameters.safeParse(draft.parameters);
 if(draftParameters.success){
  // These draft controls have no counterpart in the frozen kernel contract.
  // Keep the preview unavailable until their admission mapping is explicit.
  if(draftParameters.data.limits&&draftParameters.data.limits.minDeploymentValue!=='0')
   unavailable.push('rangekeeper_min_deployment_value_mapping_unavailable');
  if(draftParameters.data.limits?.expiryAt)
   unavailable.push('rangekeeper_expiry_mapping_unavailable');
 }
 if(!frame.referenceEligible||frame.price0===null||frame.price0<=0n||
  frame.price1===null||frame.price1<=0n||frame.nativePrice===null||frame.nativePrice<=0n)
  unavailable.push('independent_reference_unavailable');
 if(unavailable.length)return emptyModel(draft,frame,unavailable,resolved.hash,
  policy?.buildId??null,policy?String(policy.limits.exitReserveWei):null);

 const selected=policy!,limits=selected.limits,p=draft.profile.pool;
 const token0=BigInt(draft.allocation.token0Raw),token1=BigInt(draft.allocation.token1Raw),native=BigInt(draft.allocation.nativeWei);
 const strategyValue=rawValue(token0,frame.price0!,p.decimals0)+rawValue(token1,frame.price1!,p.decimals1);
 const kernelHash=`0x${resolved.hash}` as `0x${string}`;
 const state:RangeKeeperState={schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  configHash:kernelHash,buildId:selected.buildId,lastEligible:null,exit:null,confirmation:null};
 const decision=await planRangeKeeper({state,limits,spacing:p.tickSpacing,decimals0:p.decimals0,
  decimals1:p.decimals1,quoteToken:p.quoteToken,maxPoolDeviationPpm:draft.profile.referencePolicy.maxPoolDeviationPpm,
  observation:{block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
   timestamp:frame.source.timestamp,tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical',
   wallet0:token0,wallet1:token1,released0:0n,released1:0n,nativeWei:native,
   requiredExitReserveWei:null,price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice,
   position:null,pending:false,entryAllowed:true,safeExitRequired:false,
   // Kernel preview readiness only; no transaction or paper fill is accepted here.
   executionReady:true,
   liquiditySharePpm:null,actionCost:null,actionGasWei:null,reservedCost:0n,rollingSpentCost:0n,
   campaignSpentCost:0n,campaignStartValue:strategyValue,highWaterValue:strategyValue,recenters:0},
  quote:async()=>{throw Error('rangekeeper_paper_quote_not_used_without_cost_admission');},
  simulate:async()=>false,
 });
 unavailable.push('rangekeeper_paper_action_cost_profile_unavailable',
  'rangekeeper_paper_exit_reserve_evidence_unavailable',
  'rangekeeper_paper_exact_candidate_simulation_unavailable',
  'rangekeeper_paper_fee_capture_unavailable',
  'rangekeeper_paper_execution_delay_and_failure_unmodeled');
 const model=emptyModel(draft,frame,unavailable,resolved.hash,selected.buildId,
  String(limits.exitReserveWei));
 const blockingReason=decision.reason==='complete_action_cost_unavailable'?
  'rangekeeper_paper_action_cost_profile_unavailable':
  decision.reason==='complete_exit_reserve_unavailable'?
   'rangekeeper_paper_exit_reserve_evidence_unavailable':`rangekeeper_kernel_gate:${decision.reason}`;
 model.status='blocked';model.blockingReason=blockingReason;
 model.decision={status:'blocked',reason:blockingReason,kernelAction:decision.action,
  kernelReason:decision.reason,candidate:null,
  remaining:{action:String(decision.remaining.action),rolling:String(decision.remaining.rolling),
   campaign:String(decision.remaining.campaign),nativeWei:String(decision.remaining.nativeWei)}};
 return model;
}

/** Canonical read-only wrapper for new paper drafts. The client is public and
 * the underlying frame reader only performs confirmed-block calls. */
export async function readCanonicalRangeKeeperPaperOpenModel(client:RobinhoodClient,
 draft:RangeKeeperPaperDraft,policy:RangeKeeperPaperKernelPolicy|null,now=Date.now()){
 const frame=await readCanonicalPaperOpenFrame(client,draft.profile);
 return buildRangeKeeperPaperOpenModel(draft,frame,policy,now);
}
