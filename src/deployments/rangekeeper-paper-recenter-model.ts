import assert from 'node:assert/strict';
import {principalAmounts} from '../backtest/principal.js';
import type {RangeKeeperCandidate,RangeKeeperDecision,RangeKeeperObservation} from
 '../strategy/rangekeeper/domain.js';
import {planRangeKeeper,rawValue} from '../strategy/rangekeeper/planner.js';
import {parseRangeKeeperPaperCandidate,parseRangeKeeperPaperState,
 type RangeKeeperPaperEpochMark} from './rangekeeper-paper-persistence.js';
import {contentHash} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperCandidateHash} from './rangekeeper-paper-cost.js';

export interface RangeKeeperPaperRecenterSnapshot {
 draft:RangeKeeperPaperDraft;runtimeIdentity:{buildId:string};currentEpoch:number;pending:boolean;
 runtimeAdoption?:null|{adoptedFromBuildId:string;adoptionHash:string;latestMarkHash:string;
  compatibilityProof:unknown;adoptionChain?:Array<{fromBuildId:string;toBuildId:string;adoptionHash:string;
   latestMarkHash:string;compatibilityProof:unknown}>};
 openMark:{id:string;markHash:string;source:PaperOpenFrame['source'];inventory:unknown;
  model:RangeKeeperPaperOpenModel;epoch:0};
 previousMark:RangeKeeperPaperEpochMark&{candidateHash:string};
}

export interface RangeKeeperPaperRecenterPlan {
 status:'available';campaignId:string;revision:number;currentEpoch:number;nextEpoch:number;
 priorMark:{id:string;markHash:string;source:PaperOpenFrame['source']};source:PaperOpenFrame['source'];
 decision:RangeKeeperDecision;candidate:RangeKeeperCandidate|null;candidateHash:string|null;
 nextObservationAt:number|null;kernelState:RangeKeeperDecision['state'];actionAvailable:false;
}

function assertRuntimeAdoption(input:{adoption:NonNullable<RangeKeeperPaperRecenterSnapshot['runtimeAdoption']>;
 open:RangeKeeperPaperOpenModel;draft:RangeKeeperPaperDraft;buildId:string}){
 const {adoption,open,draft,buildId}=input,legacy=adoption.compatibilityProof as Record<string,unknown>|undefined,
  chain=adoption.adoptionChain??(legacy?[{fromBuildId:adoption.adoptedFromBuildId,
   toBuildId:String(legacy.toBuildId??''),adoptionHash:adoption.adoptionHash,
   latestMarkHash:adoption.latestMarkHash,compatibilityProof:legacy}]:[]);
 assert(chain.length>0&&/^[a-f0-9]{64}$/.test(adoption.adoptionHash),
  'rangekeeper_paper_recenter_runtime_adoption_unavailable');
 let expectedBuild=open.kernelBuildId;
 for(const link of chain){
  const proof=link.compatibilityProof as Record<string,unknown>|undefined;
  assert(/^[a-f0-9]{64}$/.test(link.adoptionHash)&&/^[a-f0-9]{64}$/.test(link.latestMarkHash)&&
   link.fromBuildId===expectedBuild&&proof&&proof.schemaVersion===1&&
   proof.kind==='rangekeeper_paper_runtime_compatibility_v1'&&
   proof.fromBuildId===link.fromBuildId&&proof.toBuildId===link.toBuildId&&
   proof.latestMarkHash===link.latestMarkHash&&proof.strategyId==='rangekeeper_v1'&&
   proof.configHash===draft.configHash&&proof.profileHash===draft.profileHash&&
   proof.openModelHash===contentHash(open)&&proof.historicalKernelBuildId===open.kernelBuildId,
   'rangekeeper_paper_recenter_runtime_adoption_unavailable');
  expectedBuild=link.toBuildId;
 }
 const first=chain[0]!,last=chain.at(-1)!;
 assert(expectedBuild===buildId&&adoption.adoptedFromBuildId===first.fromBuildId&&
  adoption.adoptionHash===last.adoptionHash&&adoption.latestMarkHash===last.latestMarkHash&&
  contentHash(adoption.compatibilityProof)===contentHash(last.compatibilityProof),
  'rangekeeper_paper_recenter_runtime_adoption_unavailable');
}

export function rangeKeeperPaperNextObservationAt(input:{decision:RangeKeeperDecision;
 maxObservationGapSeconds:number;now:number}):number|null{
 const confirmation=input.decision.state.confirmation;
 if(!confirmation||!(input.decision.action==='confirm'||input.decision.reason==='decision_interval'))return null;
 const dueAt=(confirmation.firstAt+30)*1000,
  validThrough=(confirmation.firstAt+input.maxObservationGapSeconds)*1000;
 return input.now<=validThrough?Math.max(input.now,dueAt):null;
}

/** Advances the existing RangeKeeper kernel against the latest persisted
 * inventory epoch. It never uses opening allocation as current inventory and
 * never turns modeled costs into paid costs. Quote and exact simulation are
 * supplied by the trusted canonical runtime. */
export async function buildRangeKeeperPaperRecenterPlan(input:{snapshot:RangeKeeperPaperRecenterSnapshot;
 frame:PaperOpenFrame;buildId:string;actionCost:bigint|null;actionGasWei:bigint|null;
 requiredExitReserveWei:bigint|null;quote:(token:0|1,amount:bigint)=>Promise<{
 amountOut:bigint;priceAfter:bigint;feeValue:bigint;shortfallValue:bigint;
 sourceBlock:bigint;sourceHash:string}>;simulate:(candidate:RangeKeeperCandidate)=>Promise<boolean>;
 now?:number}):Promise<RangeKeeperPaperRecenterPlan>{
 const {snapshot,frame}=input,draft=snapshot.draft,previous=snapshot.previousMark,
  policyResolution=resolveRangeKeeperPaperPolicy(draft,input.buildId),now=input.now??Date.now();
 if(!policyResolution.policy||policyResolution.unavailable.length)
  throw Error(policyResolution.unavailable.join(',')||'rangekeeper_paper_recenter_policy_unavailable');
 const policy=policyResolution.policy,open=snapshot.openMark.model;
 assert(draft.strategyId==='rangekeeper_v1'&&draft.revision===open.revision&&
  open.campaignId===draft.id&&open.status==='indicative'&&open.candidateHash&&open.candidate,
  'rangekeeper_paper_recenter_open_baseline_invalid');
 assert(open.kernelPolicyHash===policy.policyHash&&snapshot.runtimeIdentity.buildId===input.buildId,
  'rangekeeper_paper_recenter_runtime_identity_invalid');
 if(open.kernelBuildId!==input.buildId){
  assert(snapshot.runtimeAdoption,'rangekeeper_paper_recenter_runtime_adoption_unavailable');
  assertRuntimeAdoption({adoption:snapshot.runtimeAdoption,open,draft,buildId:input.buildId});
 }
 assert(!snapshot.pending,'rangekeeper_paper_recenter_pending_operation');
 assert(snapshot.currentEpoch===previous.epoch&&previous.epoch>=0&&
  previous.markHash.length===64&&/^[a-f0-9]{64}$/.test(previous.markHash),
  'rangekeeper_paper_recenter_epoch_identity_invalid');
 assert(previous.classification==='rangekeeper_paper_mark_v1'||
  previous.classification==='rangekeeper_paper_recenter_v1',
  'rangekeeper_paper_recenter_latest_observation_required');
 assert(BigInt(frame.source.block)>BigInt(previous.source.block)&&
  frame.source.timestamp>=previous.source.timestamp,'rangekeeper_paper_recenter_source_order_invalid');
 assert(frame.referenceEligible&&frame.referenceProof&&
  referenceProofHash(frame.referenceProof)===frame.referenceProofHash&&
  frame.price0!==null&&frame.price0>0n&&frame.price1!==null&&frame.price1>0n&&
  frame.nativePrice!==null&&frame.nativePrice>0n&&frame.sqrtPriceX96>0n,
  'rangekeeper_paper_recenter_reference_unavailable');
 const candidate=parseRangeKeeperPaperCandidate(previous.candidate),inventory=previous.inventory as {
  position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}},
  kernel=previous.kernelSnapshot as Record<string,unknown>;
 assert(candidate.range.tickLower===inventory.position.tickLower&&
  candidate.range.tickUpper===inventory.position.tickUpper&&
  String(candidate.liquidity)===inventory.position.liquidity&&
  previous.candidateHash===previous.provenance?.candidateHash,
  'rangekeeper_paper_recenter_latest_candidate_inventory_mismatch');
 const positionEpoch=(previous.provenance?.positionEpoch as Record<string,unknown>|undefined),
  candidateSource=(positionEpoch?.source??(snapshot.currentEpoch===0?open.source:
   previous.provenance?.source??previous.source)) as PaperOpenFrame['source'],
  candidateReferenceProofHash=String(positionEpoch?.candidateReferenceProofHash??
   (snapshot.currentEpoch===0?open.reference.proofHash:previous.provenance?.candidateReferenceProofHash??''));
 if(snapshot.currentEpoch===0)assert(previous.candidateHash===open.candidateHash,
  'rangekeeper_paper_recenter_open_candidate_hash_mismatch');
 assert(/^[a-f0-9]{64}$/.test(candidateReferenceProofHash)&&
  rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
   profileHash:draft.profileHash,configHash:draft.configHash,source:candidateSource,
   referenceProofHash:candidateReferenceProofHash,candidate})===previous.candidateHash,
  'rangekeeper_paper_recenter_latest_candidate_hash_invalid');
 const savedKernel=parseRangeKeeperPaperState(kernel.state);
 assert(savedKernel.buildId===open.kernelBuildId&&
  savedKernel.configHash.toLowerCase()===`0x${policy.policyHash}`.toLowerCase()&&
  kernel.source&&contentHash(kernel.source)===contentHash(previous.source)&&
  Number(kernel.recenters)===snapshot.currentEpoch&&kernel.pending===false&&
  String(kernel.wallet0)===inventory.idle.token0&&String(kernel.wallet1)===inventory.idle.token1,
  'rangekeeper_paper_recenter_latest_kernel_inventory_mismatch');
 const previousPoolState=previous.provenance?.poolState as {sqrtPriceX96?:unknown}|undefined;
 assert(previousPoolState&&/^[1-9][0-9]*$/.test(String(previousPoolState.sqrtPriceX96)),
  'rangekeeper_paper_recenter_prior_pool_state_unavailable');
 const priorPrincipal=principalAmounts({liquidity:BigInt(inventory.position.liquidity),
  tickLower:inventory.position.tickLower,tickUpper:inventory.position.tickUpper,
  sqrtPriceX96:BigInt(String(previousPoolState.sqrtPriceX96))});
 assert(String(kernel.released0)===String(priorPrincipal.amount0)&&
  String(kernel.released1)===String(priorPrincipal.amount1),
  'rangekeeper_paper_recenter_latest_principal_mismatch');
 const principal=principalAmounts({liquidity:BigInt(inventory.position.liquidity),
  tickLower:inventory.position.tickLower,tickUpper:inventory.position.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96});
 assert(frame.poolLiquidity>=0n,'rangekeeper_paper_recenter_liquidity_share_unavailable');
 const source={block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
  timestamp:frame.source.timestamp},p=draft.profile.pool;
 const observation:RangeKeeperObservation={block:source.block,hash:source.hash,
  timestamp:source.timestamp,tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical',
  wallet0:BigInt(inventory.idle.token0),wallet1:BigInt(inventory.idle.token1),
  released0:principal.amount0,released1:principal.amount1,nativeWei:BigInt(String(kernel.nativeWei)),
  requiredExitReserveWei:input.requiredExitReserveWei,price0:frame.price0,price1:frame.price1,
  nativePrice:frame.nativePrice,position:{tokenId:previous.candidateHash,
   tickLower:inventory.position.tickLower,tickUpper:inventory.position.tickUpper,
   liquidity:BigInt(inventory.position.liquidity)},pending:false,entryAllowed:true,
  safeExitRequired:false,executionReady:input.actionCost!==null&&input.actionGasWei!==null&&
   input.requiredExitReserveWei!==null,liquiditySharePpm:0,
  actionCost:input.actionCost,actionGasWei:input.actionGasWei,
  reservedCost:BigInt(String(kernel.reservedCost)),rollingSpentCost:BigInt(String(kernel.rollingSpentCost)),
  campaignSpentCost:BigInt(String(kernel.campaignSpentCost)),
  campaignStartValue:BigInt(String(kernel.campaignStartValue)),highWaterValue:BigInt(String(kernel.highWaterValue)),
  recenters:snapshot.currentEpoch};
 const state={...savedKernel,confirmation:savedKernel.confirmation};
 let decision=await planRangeKeeper({state,observation,limits:policy.limits,
  spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
  maxPoolDeviationPpm:draft.profile.referencePolicy.maxPoolDeviationPpm,
  quote:(token,amount)=>input.quote(token,amount),simulate:input.simulate});
 if(decision.candidate){
  const nextShare=decision.candidate.liquidity*1_000_000n/
   (frame.poolLiquidity+decision.candidate.liquidity);
  if(nextShare>BigInt(policy.limits.maxLiquiditySharePpm))
   decision={...decision,action:'wait',reason:'liquidity_share_limit',candidate:null};
 }
 const nextObservationAt=rangeKeeperPaperNextObservationAt({decision,
  maxObservationGapSeconds:policy.limits.maxObservationGapSeconds,now});
 return {status:'available',campaignId:draft.id,revision:draft.revision,
  currentEpoch:snapshot.currentEpoch,nextEpoch:snapshot.currentEpoch+1,
  priorMark:{id:previous.id,markHash:previous.markHash,source:previous.source},source:frame.source,
  decision,candidate:decision.candidate,candidateHash:decision.candidate?
   rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
    profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
    referenceProofHash:frame.referenceProofHash,candidate:decision.candidate}):null,
  nextObservationAt,kernelState:decision.state,actionAvailable:false};
}
