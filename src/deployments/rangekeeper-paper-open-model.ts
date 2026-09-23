import type {RobinhoodClient} from '../client.js';
import {MAX_TICK,MIN_TICK,sqrtRatioAtTick} from '../backtest/principal.js';
import type {RangeKeeperCandidate,RangeKeeperLimits,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {planRangeKeeper,rawValue} from '../strategy/rangekeeper/planner.js';
import {contentHash,rangeKeeperParameters} from './contracts.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame,type PaperPreviewDraft} from './paper-preview.js';
import {modelRangeKeeperPaperCosts,rangeKeeperPaperCandidateHash,
 rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand,selectRangeKeeperPaperCostProfiles,
 type RangeKeeperPaperCandidateScope,type RangeKeeperPaperGasProfileReader,
 type RangeKeeperPaperModeledCosts} from './rangekeeper-paper-cost.js';
import type {PaperGasProfileRow} from './paper-cost.js';

const WAD=10n**18n;
const PPM=1_000_000n;

type RangeKeeperPaperDraft=PaperPreviewDraft&{
 strategyId:'rangekeeper_v1';
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string};
 profile:MarketProfile;
};

interface ResolvedRangeKeeperPaperPolicy {
 limits:RangeKeeperLimits;
 buildId:string;
 policyHash:string;
 mapping:{minimumDeployment:'covered_by_kernel_ppm_floor'|'unsupported';
  expiry:'not_configured'|'unsupported'};
}

type PolicyResolution={policy:ResolvedRangeKeeperPaperPolicy|null;unavailable:string[]};

type SerializableCandidate={
 kind:'entry'|'recenter';range:{tickLower:number;tickUpper:number};
 swap:null|{token:0|1;amountIn:string;quotedOut:string;minOut:string;priceAfter:string;
  feeValue:string;shortfallValue:string};
 amount0Desired:string;amount1Desired:string;amount0Min:string;amount1Min:string;
 liquidity:string;deployedValue:string;sourceBlock:string;sourceHash:string;expiresAt:number;
};

export interface RangeKeeperPaperOpenModel {
 schemaVersion:1;
 kind:'rangekeeper_paper_open_model';
 status:'unavailable'|'blocked'|'indicative';
 blockingReason:string|null;
 campaignId:string;
 revision:number;
 strategyId:'rangekeeper_v1';
 strategyVersion:'1.0.0';
 draftConfigHash:string;
 kernelPolicyHash:string|null;
 kernelBuildId:string|null;
 policyMapping:{minimumDeployment:'covered_by_kernel_ppm_floor'|'unsupported'|'unresolved';
  expiry:'not_configured'|'unsupported'|'unresolved'};
 profileHash:string;
 source:PaperOpenFrame['source'];
 poolState:{tick:number;sqrtPriceX96:string;poolLiquidity:string};
 reference:{price0:string|null;price1:string|null;nativePrice:string|null;
  eligible:boolean;proofHash:string;proof:Record<string,unknown>|null;reasons:string[]};
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string;
  token0Value:string|null;token1Value:string|null;nativeValue:string|null;
  strategyInventoryValue:string|null;totalAllocatedValue:string|null};
 candidate:SerializableCandidate|null;
 candidateHash:string|null;
 decision:null|{status:'blocked'|'indicative';reason:string;
  kernelAction:'wait'|'safety_exit'|'confirm'|'execute'|null;kernelReason:string|null;
  requiresSecondObservation:boolean;
  remaining:{action:string;rolling:string;campaign:string;nativeWei:string}|null};
 costs:RangeKeeperPaperModeledCosts|null;
 actionAvailable:false;
 execution:{classification:'read_only_hypothetical';fillRecorded:false;
  paidCosts:string|null;modeledOpenCost:string|null;modeledOpenCostBound:string|null;
  modeledRetainExitCost:string|null;modeledExitReserve:string|null;
  configuredExitReserveWei:string|null;feeAccrual:string|null;netNav:string|null;
  absolutePnl:string|null;passiveAlpha:string|null};
 unavailable:string[];
}

function serializeCandidate(candidate:RangeKeeperCandidate|null):SerializableCandidate|null{
 if(!candidate)return null;
 return {kind:candidate.kind,range:candidate.range,
  swap:candidate.swap?{token:candidate.swap.token,amountIn:String(candidate.swap.amountIn),
   quotedOut:String(candidate.swap.quotedOut),minOut:String(candidate.swap.minOut),
   priceAfter:String(candidate.swap.priceAfter),feeValue:String(candidate.swap.feeValue),
   shortfallValue:String(candidate.swap.shortfallValue)}:null,
  amount0Desired:String(candidate.amount0Desired),amount1Desired:String(candidate.amount1Desired),
  amount0Min:String(candidate.amount0Min),amount1Min:String(candidate.amount1Min),
  liquidity:String(candidate.liquidity),deployedValue:String(candidate.deployedValue),
  sourceBlock:String(candidate.sourceBlock),sourceHash:candidate.sourceHash,expiresAt:candidate.expiresAt};
}

function resolvePolicy(draft:RangeKeeperPaperDraft,buildId:string):PolicyResolution{
 const unavailable:string[]=[];
 if(!/^[a-f0-9]{64}$/.test(buildId))unavailable.push('rangekeeper_runtime_build_identity_unavailable');
 const parsed=rangeKeeperParameters.safeParse(draft.parameters);
 if(!parsed.success)return {policy:null,unavailable:[...unavailable,'rangekeeper_draft_parameters_invalid']};
 if(!parsed.data.limits)return {policy:null,unavailable:[...unavailable,'rangekeeper_draft_limits_unavailable']};
 if(contentHash(draft.profile)!==draft.profileHash)
  unavailable.push('rangekeeper_persisted_profile_hash_mismatch');
 const draftConfig={...parsed.data,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1};
 if(contentHash(draftConfig)!==draft.configHash)
  unavailable.push('rangekeeper_persisted_draft_config_hash_mismatch');
 const input=parsed.data,common=input.limits!;
 const draftWidth=(draft.parameters as {fullWidthSpacings?:unknown}).fullWidthSpacings;
 const kernelWidth=input.fullWidthSpacings;
 if(typeof draftWidth!=='number'||draftWidth!==kernelWidth)
  unavailable.push('rangekeeper_width_mapping_mismatch');
 const limits:RangeKeeperLimits={
  fullWidthSpacings:kernelWidth,
  maxDeploymentValue:BigInt(common.maxDeploymentValue),minDeploymentPpm:common.minDeploymentPpm,
  maxSwapInputValue:BigInt(common.maxSwapInputValue),maxSwapInputPpm:common.maxSwapInputPpm,
  maxSwapShortfallValue:BigInt(common.maxSwapShortfallValue),maxSlippageBps:common.maxSlippageBps,
  maxActionCost:BigInt(common.maxActionCost),maxRollingCost:BigInt(common.maxRollingCost),
  maxCampaignCost:BigInt(common.maxCampaignCost),maxExposurePpm:common.maxExposurePpm,
  maxLossValue:BigInt(common.maxLossValue),maxDrawdownPpm:common.maxDrawdownPpm,
  maxRecenters:common.maxRecenters,maxLiquiditySharePpm:common.maxLiquiditySharePpm,
  maxObservationGapSeconds:common.maxObservationGapSeconds,exitReserveWei:BigInt(common.exitReserveWei),
 };
 const kernelMin=limits.maxDeploymentValue*BigInt(limits.minDeploymentPpm)/PPM;
 const minimumDeployment=BigInt(common.minDeploymentValue)<=kernelMin?
  'covered_by_kernel_ppm_floor' as const:'unsupported' as const;
 if(minimumDeployment==='unsupported')unavailable.push('rangekeeper_min_deployment_value_not_enforced_by_kernel');
 const expiry=common.expiryAt?'unsupported' as const:'not_configured' as const;
 if(expiry==='unsupported')unavailable.push('rangekeeper_expiry_management_not_supported_by_open_kernel');
 if(limits.fullWidthSpacings!==draftWidth)
  unavailable.push('rangekeeper_width_mapping_mismatch');
 if(limits.maxRollingCost>limits.maxCampaignCost||limits.maxDeploymentValue<=0n||
  limits.maxActionCost<=0n||limits.exitReserveWei<=0n||limits.minDeploymentPpm<=0||
  limits.minDeploymentPpm>1_000_000||limits.maxSwapInputValue<=0n||limits.maxSwapInputPpm<=0||
  limits.maxSwapInputPpm>1_000_000||limits.maxSwapShortfallValue<=0n||limits.maxSlippageBps<=0||
  limits.maxSlippageBps>50||limits.maxExposurePpm<=0||limits.maxExposurePpm>1_000_000||
  limits.maxLossValue<=0n||limits.maxDrawdownPpm<=0||limits.maxDrawdownPpm>1_000_000||
  limits.maxLiquiditySharePpm<=0||limits.maxLiquiditySharePpm>1_000_000||
  limits.maxObservationGapSeconds<30||limits.maxObservationGapSeconds>90)
  unavailable.push('rangekeeper_resolved_kernel_policy_invalid');
 if(unavailable.length)return {policy:null,unavailable};
 const policyHash=contentHash({draftConfigHash:draft.configHash,profileHash:draft.profileHash,
  strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',limits:Object.fromEntries(
   Object.entries(limits).map(([key,value])=>[key,typeof value==='bigint'?String(value):value]))});
 return {policy:{limits,buildId,policyHash,mapping:{minimumDeployment,expiry}},unavailable};
}

function emptyModel(draft:RangeKeeperPaperDraft,frame:PaperOpenFrame,unavailable:string[],
 resolution:PolicyResolution):RangeKeeperPaperOpenModel{
 const p=draft.profile.pool,amount0=BigInt(draft.allocation.token0Raw),amount1=BigInt(draft.allocation.token1Raw),
  native=BigInt(draft.allocation.nativeWei);
 const token0Value=frame.price0===null||frame.price0<=0n?null:rawValue(amount0,frame.price0,p.decimals0);
 const token1Value=frame.price1===null||frame.price1<=0n?null:rawValue(amount1,frame.price1,p.decimals1);
 const nativeValue=frame.nativePrice===null||frame.nativePrice<=0n?null:native*frame.nativePrice/WAD;
 const strategyInventoryValue=token0Value===null||token1Value===null?null:token0Value+token1Value;
 const totalAllocatedValue=strategyInventoryValue===null||nativeValue===null?null:strategyInventoryValue+nativeValue;
 return {schemaVersion:1,kind:'rangekeeper_paper_open_model',status:'unavailable',blockingReason:null,
  campaignId:draft.id,revision:draft.revision,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  draftConfigHash:draft.configHash,kernelPolicyHash:resolution.policy?.policyHash??null,
  kernelBuildId:resolution.policy?.buildId??null,
  policyMapping:resolution.policy?.mapping??{minimumDeployment:'unresolved',expiry:'unresolved'},
  profileHash:draft.profileHash,source:frame.source,
  poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity)},
  reference:{price0:frame.price0===null?null:String(frame.price0),price1:frame.price1===null?null:String(frame.price1),
   nativePrice:frame.nativePrice===null?null:String(frame.nativePrice),eligible:frame.referenceEligible,
   proofHash:frame.referenceProofHash,proof:frame.referenceProof??null,reasons:[...frame.referenceReasons]},
  allocation:{token0Raw:String(amount0),token1Raw:String(amount1),nativeWei:String(native),
   token0Value:token0Value===null?null:String(token0Value),token1Value:token1Value===null?null:String(token1Value),
   nativeValue:nativeValue===null?null:String(nativeValue),
   strategyInventoryValue:strategyInventoryValue===null?null:String(strategyInventoryValue),
   totalAllocatedValue:totalAllocatedValue===null?null:String(totalAllocatedValue)},
  candidate:null,candidateHash:null,decision:null,costs:null,actionAvailable:false,
  execution:{classification:'read_only_hypothetical',fillRecorded:false,paidCosts:null,
   modeledOpenCost:null,modeledOpenCostBound:null,modeledRetainExitCost:null,modeledExitReserve:null,
   configuredExitReserveWei:resolution.policy?String(resolution.policy.limits.exitReserveWei):null,
   feeAccrual:null,netNav:null,absolutePnl:null,passiveAlpha:null},
  unavailable:[...new Set(unavailable)],
 };
}

function invalidFrameReason(frame:PaperOpenFrame,now:number){
 const reasons:string[]=[];
 if(!frame.referenceProof||referenceProofHash(frame.referenceProof)!==frame.referenceProofHash)
  reasons.push('canonical_reference_proof_unavailable');
 const tickValid=Number.isSafeInteger(frame.tick)&&frame.tick>=MIN_TICK&&frame.tick<=MAX_TICK;
 let tickPriceValid=false;
 if(tickValid&&frame.sqrtPriceX96>0n){
  const lower=sqrtRatioAtTick(frame.tick);
  tickPriceValid=frame.tick===MAX_TICK?frame.sqrtPriceX96===lower:
   frame.sqrtPriceX96>=lower&&frame.sqrtPriceX96<sqrtRatioAtTick(frame.tick+1);
 }
 if(!tickPriceValid||frame.poolLiquidity<0n)reasons.push('canonical_pool_state_unavailable');
 if(!/^0x[0-9a-fA-F]{64}$/.test(frame.source.hash)||
  !/^(0|[1-9][0-9]*)$/.test(frame.source.block)||!Number.isSafeInteger(frame.source.timestamp)||
  frame.source.timestamp<0)reasons.push('canonical_source_identity_unavailable');
 const age=Math.floor(now/1000)-frame.source.timestamp;
 if(age<0||age>180)reasons.push('canonical_source_stale');
 if(!frame.referenceEligible||frame.price0===null||frame.price0<=0n||
  frame.price1===null||frame.price1<=0n||frame.nativePrice===null||frame.nativePrice<=0n)
  reasons.push('independent_reference_unavailable');
 return reasons;
}

function block(model:RangeKeeperPaperOpenModel,reason:string,kernelReason:string|null=null,
 kernelAction:'wait'|'safety_exit'|'confirm'|'execute'|null=null){
 model.status='blocked';model.blockingReason=reason;
 model.decision={status:'blocked',reason,kernelAction,kernelReason,requiresSecondObservation:false,remaining:null};
 model.unavailable=[...new Set([...model.unavailable,reason])];
 return model;
}

export interface BuildRangeKeeperPaperOpenInput {
 client:RobinhoodClient;
 draft:RangeKeeperPaperDraft;
 frame:PaperOpenFrame;
 buildId:string;
 gasProfiles?:readonly PaperGasProfileRow[];
 readGasProfiles?:RangeKeeperPaperGasProfileReader;
 marketGasPriceWei:bigint|null;
 marketGasPriceObservedAt:number|null;
 now?:number;
}

/** Build the first-observation open preview using the exact RangeKeeper kernel.
 * Candidate discovery is internal only: no candidate is returned until both
 * candidate-bound open and retain-exit profiles validate at this pool/source. */
export async function buildRangeKeeperPaperOpenModel(input:BuildRangeKeeperPaperOpenInput):Promise<RangeKeeperPaperOpenModel>{
 const {draft,frame}=input,now=input.now??Date.now();
 if(draft.strategyId!=='rangekeeper_v1')throw Error('rangekeeper_paper_strategy_mismatch');
 const policy=resolvePolicy(draft,input.buildId),unavailable=[...policy.unavailable,...invalidFrameReason(frame,now)];
 if(unavailable.length)return emptyModel(draft,frame,unavailable,policy);
 if(input.marketGasPriceWei===null||input.marketGasPriceWei<=0n||input.marketGasPriceObservedAt===null||
  now-input.marketGasPriceObservedAt<0||now-input.marketGasPriceObservedAt>30_000)
  return emptyModel(draft,frame,['rangekeeper_current_gas_price_unavailable'],policy);
 const resolved=policy.policy!,limits=resolved.limits,p=draft.profile.pool;
 const token0=BigInt(draft.allocation.token0Raw),token1=BigInt(draft.allocation.token1Raw),
  native=BigInt(draft.allocation.nativeWei);
 const strategyValue=rawValue(token0,frame.price0!,p.decimals0)+rawValue(token1,frame.price1!,p.decimals1);
 const state:RangeKeeperState={schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  configHash:`0x${resolved.policyHash}` as `0x${string}`,buildId:resolved.buildId,
  lastEligible:null,exit:null,confirmation:null};
 const source={block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
  timestamp:frame.source.timestamp};
 const chain=new RangeKeeperChain(input.client,p);
 const quote=async(token:0|1,amount:bigint)=>chain.quote(source,token,amount,frame.price0!,frame.price1!);
 const observation={block:source.block,hash:source.hash,timestamp:source.timestamp,tick:frame.tick,
  sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical' as const,wallet0:token0,wallet1:token1,
  released0:0n,released1:0n,nativeWei:native,requiredExitReserveWei:limits.exitReserveWei,
  price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice,position:null,pending:false,
  entryAllowed:true,safeExitRequired:false,executionReady:true,liquiditySharePpm:0,
  actionCost:limits.maxActionCost,actionGasWei:0n,reservedCost:0n,rollingSpentCost:0n,
  campaignSpentCost:0n,campaignStartValue:strategyValue,highWaterValue:strategyValue,recenters:0};
 const kernelInput={state,observation,limits,spacing:p.tickSpacing,decimals0:p.decimals0,
  decimals1:p.decimals1,quoteToken:p.quoteToken,
  maxPoolDeviationPpm:draft.profile.referencePolicy.maxPoolDeviationPpm,quote,
  // Candidate discovery is not accepted or persisted. The evidence-bound
  // second pass below is the only pass whose candidate can be returned.
  simulate:async()=>true};
 const probe=await planRangeKeeper(kernelInput);
 if(!probe.candidate){
  const model=emptyModel(draft,frame,[],policy);
  return block(model,'rangekeeper_kernel_candidate_unavailable',probe.reason,probe.action);
 }
 const candidate=probe.candidate,denominator=frame.poolLiquidity+candidate.liquidity;
 if(denominator<=0n)return emptyModel(draft,frame,['rangekeeper_pool_liquidity_share_unavailable'],policy);
 const share=candidate.liquidity*PPM/denominator;
 if(share>BigInt(limits.maxLiquiditySharePpm))
  return emptyModel(draft,frame,['rangekeeper_liquidity_share_limit'],policy);
 const candidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
  profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
  referenceProofHash:frame.referenceProofHash,candidate});
 const scope:RangeKeeperPaperCandidateScope={poolAddress:p.pool,profileHash:draft.profileHash,
  candidateHash,deployedValue:candidate.deployedValue,sharePpm:share,
  range:candidate.range,swapKind:candidate.swap?'direct_pool_exact_input':'none'};
 const pathVersion=rangeKeeperPaperPathVersion(candidate),sizeBand=rangeKeeperPaperSizeBand(pathVersion,scope);
 let gasProfiles=input.gasProfiles??[];
 if(input.readGasProfiles){
  try{gasProfiles=[...await input.readGasProfiles({poolAddress:p.pool,pathVersion,sizeBand})];}
  catch{
   const model=emptyModel(draft,frame,[],policy);
   return block(model,'rangekeeper_scoped_cost_lookup_unavailable',null,null);
  }
 }
 const selected=selectRangeKeeperPaperCostProfiles({candidate,scope,source:frame.source,
  rows:gasProfiles,now});
 if(selected.status!=='available'){
  const model=emptyModel(draft,frame,[],policy);
  return block(model,selected.reason,kernelReasonFromProfileSelection(selected),null);
 }
 let costs:RangeKeeperPaperModeledCosts;
 try{costs=modelRangeKeeperPaperCosts({profiles:selected,limits,nativePrice:frame.nativePrice!,
  marketGasPriceWei:input.marketGasPriceWei,
  swapFeeAndShortfallValue:candidate.swap?candidate.swap.feeValue+candidate.swap.shortfallValue:0n,now});}
 catch(error){
  const model=emptyModel(draft,frame,[],policy);
  return block(model,error instanceof Error?error.message:'rangekeeper_paper_cost_model_unavailable');
 }
 const finalObservation={...observation,actionCost:BigInt(costs.open.boundValue),
  actionGasWei:BigInt(costs.open.boundWei),
  requiredExitReserveWei:BigInt(costs.retainExit.requiredReserveWei),liquiditySharePpm:Number(share)};
 const final=await planRangeKeeper({...kernelInput,observation:finalObservation,
  simulate:async frozen=>rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
   profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
   referenceProofHash:frame.referenceProofHash,candidate:frozen})===candidateHash&&
   selected.simulationHash.length>0});
 if(final.action!=='confirm'||!final.candidate){
  const model=emptyModel(draft,frame,[],policy);model.costs=costs;
  return block(model,`rangekeeper_kernel_gate:${final.reason}`,final.reason,final.action);
 }
 const model=emptyModel(draft,frame,costs.unavailable,policy);
 model.status='indicative';model.blockingReason='rangekeeper_two_observation_confirmation_pending';
 model.candidate=serializeCandidate(final.candidate);model.candidateHash=candidateHash;model.costs=costs;
 model.decision={status:'indicative',reason:model.blockingReason,kernelAction:final.action,
  kernelReason:final.reason,requiresSecondObservation:true,
  remaining:{action:String(final.remaining.action),rolling:String(final.remaining.rolling),
   campaign:String(final.remaining.campaign),nativeWei:String(final.remaining.nativeWei)}};
 model.execution.modeledOpenCost=costs.open.expectedValue;
 model.execution.modeledOpenCostBound=costs.open.boundValue;
 model.execution.modeledRetainExitCost=costs.retainExit.expectedValue;
 model.execution.modeledExitReserve=costs.retainExit.requiredReserveWei;
 return model;
}

function kernelReasonFromProfileSelection(selection:Exclude<ReturnType<typeof selectRangeKeeperPaperCostProfiles>,
 {status:'available'}>){
 return `${selection.reason}:${selection.missingStages.join(',')}`;
}

/** Canonical read-only wrapper. `draft` must come from DeploymentStore.paperDraft,
 * and `gasProfiles` from the bounded trusted store query for its exact size band. */
export async function readCanonicalRangeKeeperPaperOpenModel(input:{client:RobinhoodClient;
 draft:RangeKeeperPaperDraft;buildId:string;readGasProfiles:RangeKeeperPaperGasProfileReader;now?:number}){
 const frame=await readCanonicalPaperOpenFrame(input.client,input.draft.profile);
 const gasPrice=await input.client.getGasPrice(),observedAt=Date.now();
 return buildRangeKeeperPaperOpenModel({client:input.client,draft:input.draft,frame,buildId:input.buildId,
  readGasProfiles:input.readGasProfiles,marketGasPriceWei:gasPrice,marketGasPriceObservedAt:observedAt,
  now:input.now??observedAt});
}
