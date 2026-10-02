import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {loadRuntimeIdentity} from '../runtime/identity.js';
import {contentHash} from './contracts.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';
import {acquirePaperPreparationSharedLease} from './paper-preparation-lease.js';
import {readCanonicalPaperNextFrame} from './paper-preview.js';
import {verifyCanonicalPaperAnchors} from './paper-canonical-anchors.js';
import {resolveRangeKeeperPaperPolicy} from './rangekeeper-paper-open-model.js';
import {buildRangeKeeperPaperRecenterPlan} from './rangekeeper-paper-recenter-model.js';
import {assertRangeKeeperPaperRecenterSimulation,simulateRangeKeeperPaperRecenter}
 from './rangekeeper-paper-recenter-simulation.js';
import {createRangeKeeperPaperRecenterBookingModel,serializeRangeKeeperPaperCandidate,
 serializeRangeKeeperPaperKernelSnapshot,buildRangeKeeperPaperRecenterBooking,
 validateRangeKeeperPaperInitialModeledOpenCost} from './rangekeeper-paper-persistence.js';

const anchorSource=(s:{block:string;hash:string;timestamp:number})=>s;

/** One worker step for active RangeKeeper paper. A first decision is persisted
 * as an epoch observation; only the matching second decision freezes and
 * accepts a new position epoch. The operation is accepted while its exclusive
 * preparation lease is still held. */
export async function prepareRangeKeeperPaperRecenterPreview(input:{store:DeploymentStore;
 client:RobinhoodClient;campaignId:string;buildId:string;rpcUrl:string;indexer:Pool;
 beforeRead?:()=>Promise<void>;observationOnly?:boolean;
 onFailure?:(stage:string,error:unknown)=>void}){
 const {store,client,campaignId,buildId}=input;let stage='shared_preparation_lease',
  shared:Awaited<ReturnType<typeof acquirePaperPreparationSharedLease>>|null=null;
 try{
  shared=await acquirePaperPreparationSharedLease(input.indexer,campaignId);
  if(!shared)return {status:'preparation_locked',reason:'paper_preparation_locked',actionAvailable:false};
  const releaseShared=async()=>{if(shared){const held=shared;shared=null;await held.release();}};
  stage='epoch_snapshot';
  const snapshot=await store.rangeKeeperPaperEpochSnapshot(campaignId),runtime=loadRuntimeIdentity();
  if(!runtime||runtime.buildId!==buildId)throw new DeploymentConflict('rangekeeper_runtime_identity_unavailable');
  if(snapshot.pending)throw new DeploymentConflict('rangekeeper_paper_recenter_operation_pending');
  const draft=snapshot.draft as Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['snapshot']['draft'],
   openMark=snapshot.openMark as unknown as Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['snapshot']['openMark'],
   previousMark=snapshot.previousMark as Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['snapshot']['previousMark'],
   latestKernel=previousMark.kernelSnapshot;
  if(previousMark.classification==='rangekeeper_paper_open_v1'||!latestKernel)
   return {status:'bootstrap_observation_required',reason:'rangekeeper_paper_first_observation_required',
    source:previousMark.source,actionAvailable:false};
  let epochPrevious={...previousMark,kernelSnapshot:latestKernel};
  let initialCostValid=false;
  try{validateRangeKeeperPaperInitialModeledOpenCost(previousMark.provenance?.initialModeledOpenCost);
   initialCostValid=true;}catch{}
  const baselineBootstrap=snapshot.currentEpoch===0&&!initialCostValid;
  if(baselineBootstrap){
   const costs=(openMark.model as {costs?:{status?:string;open?:{boundValue?:string;boundWei?:string};
    profileIds?:unknown[]}|null}).costs,openCost=costs?.open;
   if(costs?.status!=='provisional'||!openCost||!costs.profileIds?.length)
    throw new DeploymentConflict('rangekeeper_paper_initial_open_cost_unavailable');
   const boundValue=BigInt(String(openCost.boundValue)),boundWei=BigInt(String(openCost.boundWei)),
    priorKernel=latestKernel as Record<string,unknown>,nativeWei=BigInt(draft.allocation.nativeWei);
   if(BigInt(String(priorKernel.rollingSpentCost))!==0n||
    BigInt(String(priorKernel.campaignSpentCost))!==0n||
    BigInt(String(priorKernel.reservedCost))!==0n||
    BigInt(String(priorKernel.nativeWei))!==nativeWei||boundValue<0n||boundWei<0n||nativeWei<boundWei)
    throw new DeploymentConflict('rangekeeper_paper_initial_open_cost_invalid');
   epochPrevious={...epochPrevious,kernelSnapshot:{...priorKernel,nativeWei:String(nativeWei-boundWei),
    rollingSpentCost:String(boundValue),campaignSpentCost:String(boundValue)}};
  }
  const planSnapshot={draft,runtimeIdentity:snapshot.runtimeIdentity,currentEpoch:snapshot.currentEpoch,
    pending:snapshot.pending,openMark,previousMark:epochPrevious,runtimeAdoption:snapshot.runtimeAdoption} as
    Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['snapshot'];
  stage='canonical_frame';
  const frame=await readCanonicalPaperNextFrame(client,draft.profile,
   {sourceBlock:previousMark.source.block,sourceHash:previousMark.source.hash});
  const verifyAnchors=(chainId:number,sources:Parameters<typeof verifyCanonicalPaperAnchors>[2])=>
   verifyCanonicalPaperAnchors(client,chainId,sources);
  await verifyAnchors(draft.profile.pool.chainId,[snapshot.openMark.source,
   previousMark.source,frame.source]);
  const policy=resolveRangeKeeperPaperPolicy(draft,buildId);
  if(!policy.policy||policy.unavailable.length)
   throw new DeploymentConflict('rangekeeper_paper_recenter_policy_unavailable');
  const chain=new RangeKeeperChain(client,draft.profile.pool),kernel=epochPrevious.kernelSnapshot as
   Record<string,unknown>,quote=async(token:0|1,amount:bigint)=>chain.quote({block:BigInt(frame.source.block),
    hash:frame.source.hash as `0x${string}`,timestamp:frame.source.timestamp},token,amount,
    frame.price0!,frame.price1!),reservedCost=BigInt(String(kernel.reservedCost)),
   discoveryActionCost=[policy.policy.limits.maxActionCost,
    policy.policy.limits.maxRollingCost-BigInt(String(kernel.rollingSpentCost))-reservedCost,
    policy.policy.limits.maxCampaignCost-BigInt(String(kernel.campaignSpentCost))-reservedCost]
    .reduce((min,value)=>value<min?value:min,policy.policy.limits.maxActionCost);
  const discovery=await buildRangeKeeperPaperRecenterPlan({snapshot:planSnapshot,frame,buildId,
   actionCost:input.observationOnly||baselineBootstrap||discoveryActionCost<=0n?null:discoveryActionCost,
   actionGasWei:input.observationOnly||baselineBootstrap?null:0n,
   requiredExitReserveWei:input.observationOnly||baselineBootstrap?null:policy.policy.limits.exitReserveWei,
   quote,simulate:async()=>true});
  const candidate=discovery.candidate;
  if(!candidate){
   const kernelSnapshot=observationKernel({plan:discovery,snapshot:planSnapshot,frame,
    decision:discovery.decision,observationOnly:input.observationOnly===true||baselineBootstrap});
   stage='observation_persistence';
   const saved=await store.recordRangeKeeperPaperMark({campaignId,source:anchorSource(frame.source),frame,
    decision:{action:discovery.decision.action,reason:discovery.decision.reason},kernelSnapshot,verifyAnchors});
   return {status:discovery.decision.action==='safety_exit'?'safety_exit':'observed',
    reason:baselineBootstrap?'initial_modeled_open_cost_recorded':discovery.decision.reason,
    markId:saved.markId,source:frame.source,decision:discovery.decision,
    nextObservationAt:input.observationOnly||baselineBootstrap?null:discovery.nextObservationAt,
    actionAvailable:false};
  }
  stage='owned_fork_sampling';
  const marketGasPriceWei=await client.getGasPrice();
  const simulation=await simulateRangeKeeperPaperRecenter({snapshot:planSnapshot,frame,candidate,
   policyLimits:policy.policy.limits,rpcUrl:input.rpcUrl,marketGasPriceWei,
   beforeRead:input.beforeRead});
  assertRangeKeeperPaperRecenterSimulation(simulation);
  const final=await buildRangeKeeperPaperRecenterPlan({snapshot:planSnapshot,frame,buildId,
   actionCost:BigInt(simulation.modeledCosts.boundValue),
   actionGasWei:BigInt(simulation.modeledCosts.boundWei),
   requiredExitReserveWei:BigInt(simulation.modeledCosts.requiredReserveWei),quote,
   simulate:async frozen=>{
    assertRangeKeeperPaperRecenterSimulation(simulation);
    return rangeKeeperPaperCandidateMatches(frozen,candidate)&&
     simulation.candidateHash===discovery.candidateHash&&simulation.source.block===frame.source.block&&
     simulation.source.hash.toLowerCase()===frame.source.hash.toLowerCase();
   }});
  if(final.decision.action!=='execute'||!final.candidate){
   const kernelSnapshot=observationKernel({plan:final,snapshot:planSnapshot,frame,decision:final.decision,
    observationOnly:input.observationOnly===true});
   stage='observation_persistence';
   const saved=await store.recordRangeKeeperPaperMark({campaignId,source:anchorSource(frame.source),frame,
    decision:{action:final.decision.action,reason:final.decision.reason},kernelSnapshot,verifyAnchors});
   return {status:final.decision.action==='safety_exit'?'safety_exit':
    final.decision.action==='confirm'?'confirming':'observed',reason:final.decision.reason,
    markId:saved.markId,source:frame.source,decision:final.decision,
    nextObservationAt:final.nextObservationAt,actionAvailable:false};
  }
  stage='preparation_lease';
  await releaseShared();
  const lease=await store.acquirePaperPreparationLease(campaignId);
  try{
   await lease.assertHealthy();
   const latest=await store.rangeKeeperPaperEpochSnapshot(campaignId);
   if(latest.pending||latest.previousMark.id!==previousMark.id||
    latest.previousMark.markHash!==previousMark.markHash)
    throw new DeploymentConflict('rangekeeper_paper_recenter_latest_epoch_changed');
   const booking=buildBooking({snapshot:planSnapshot,frame,plan:final,simulation,kernel});
   const replayed=buildRangeKeeperPaperRecenterBooking({draft:planSnapshot.draft,
    previousMark,frame,booking});
   assert.equal(contentHash(replayed.inventory),contentHash(simulation.inventory));
   const modelHash=booking.modelHash,now=Date.now(),expiresAt=new Date(Math.min(
    (frame.source.timestamp+90)*1000,now+120_000));
   if(expiresAt.getTime()<=now)throw new DeploymentConflict('rangekeeper_paper_recenter_source_expired');
   stage='preview_persistence';
   const preview=await store.recordPreview({campaignId,expectedRevision:draft.revision,kind:'change_range',
    request:{kind:'automatic_paper_recenter_v1',strategyId:'rangekeeper_v1',
     profileHash:draft.profileHash,configHash:draft.configHash,epoch:booking.epoch,
     priorMarkId:previousMark.id,priorMarkHash:previousMark.markHash},
    proposal:{rangekeeperPaperRecenterModel:booking,rangekeeperPaperRecenterModelHash:modelHash},
    evidence:{verificationClass:'canonical_rangekeeper_paper_recenter_v1',modelHash,
     candidateHash:booking.candidateHash,source:booking.source,
     referenceProofHash:booking.candidateReferenceProofHash,
     costEvidenceClass:'fork_estimated',paidCostsAvailable:false},expiresAt});
   await lease.assertHealthy();stage='operation_acceptance';
   const operation=await store.acceptRangeKeeperPaperRecenterOperation(campaignId,{previewId:preview.id,
    contentDigest:preview.contentDigest,expectedRevision:draft.revision,
    idempotencyKey:`rk-auto:${preview.id}`},'paper_worker',verifyAnchors);
   return {status:'accepted',operationId:operation.id,reason:'two_confirmations',source:frame.source,
    decision:final.decision,actionAvailable:false};
  }finally{await lease.release();}
 }catch(error){try{input.onFailure?.(stage,error);}catch{/* diagnostic callbacks are non-authoritative */}
  throw error;}
 finally{if(shared)await shared.release();}
}

function rangeKeeperPaperCandidateMatches(a:Parameters<typeof serializeRangeKeeperPaperCandidate>[0],
 b:Parameters<typeof serializeRangeKeeperPaperCandidate>[0]){
 return contentHash(serializeRangeKeeperPaperCandidate(a))===contentHash(serializeRangeKeeperPaperCandidate(b));
}

function observationKernel(input:{plan:Awaited<ReturnType<typeof buildRangeKeeperPaperRecenterPlan>>;
 snapshot:Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['snapshot'];frame:Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['frame'];
 decision:Awaited<ReturnType<typeof buildRangeKeeperPaperRecenterPlan>>['decision'];observationOnly:boolean}){
 const previous=input.snapshot.previousMark,kernel=previous.kernelSnapshot as Record<string,unknown>,
  inventory=previous.inventory as {position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}},
  candidate=previous.candidate as Parameters<typeof serializeRangeKeeperPaperCandidate>[0],
  principal=principalAmounts({liquidity:BigInt(inventory.position.liquidity),
   tickLower:inventory.position.tickLower,tickUpper:inventory.position.tickUpper,
   sqrtPriceX96:input.frame.sqrtPriceX96}),state={...input.plan.kernelState,
   lastEligible:input.plan.kernelState.lastEligible};
 const amount0=principal.amount0+BigInt(inventory.idle.token0),
  amount1=principal.amount1+BigInt(inventory.idle.token1),
  value=amount0*input.frame.price0!/10n**BigInt(input.snapshot.draft.profile.pool.decimals0)+
   amount1*input.frame.price1!/10n**BigInt(input.snapshot.draft.profile.pool.decimals1);
 return serializeRangeKeeperPaperKernelSnapshot({state,source:input.frame.source,
  wallet0:BigInt(inventory.idle.token0),wallet1:BigInt(inventory.idle.token1),
  released0:principal.amount0,released1:principal.amount1,nativeWei:BigInt(String(kernel.nativeWei)),
  campaignStartValue:BigInt(String(kernel.campaignStartValue)),
  highWaterValue:BigInt(String(kernel.highWaterValue))>value?BigInt(String(kernel.highWaterValue)):value,
  rollingSpentCost:BigInt(String(kernel.rollingSpentCost)),campaignSpentCost:BigInt(String(kernel.campaignSpentCost)),
  reservedCost:BigInt(String(kernel.reservedCost)),recenters:input.snapshot.currentEpoch,pending:false,
  entryAllowed:!input.observationOnly&&input.decision.action!=='safety_exit',
  safeExitRequired:input.decision.action==='safety_exit',
  executionReady:input.decision.action==='confirm'||input.decision.action==='execute',
  });
}

function buildBooking(input:{snapshot:Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['snapshot'];
 frame:Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['frame'];
 plan:Awaited<ReturnType<typeof buildRangeKeeperPaperRecenterPlan>>;
 simulation:Awaited<ReturnType<typeof simulateRangeKeeperPaperRecenter>>;
 kernel:Record<string,unknown>}){
 const {snapshot,frame,plan,simulation}=input,previous=snapshot.previousMark,
  candidate=plan.candidate!;
 const body={schemaVersion:1 as const,kind:'rangekeeper_paper_recenter_v1' as const,
  campaignId:snapshot.draft.id,revision:snapshot.draft.revision,previousEpoch:snapshot.currentEpoch,
  epoch:snapshot.currentEpoch+1,priorMark:{id:previous.id,markHash:previous.markHash,source:previous.source},
  source:frame.source,poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
   poolLiquidity:String(frame.poolLiquidity)},reference:{price0:String(frame.price0),price1:String(frame.price1),
   nativePrice:String(frame.nativePrice),proofHash:frame.referenceProofHash,proof:frame.referenceProof!},
  candidateReferenceProofHash:frame.referenceProofHash,candidateHash:plan.candidateHash!,
  allowancesCleared:true as const,
  retiredPosition:{tickLower:(previous.inventory as {position:{tickLower:number}}).position.tickLower,
   tickUpper:(previous.inventory as {position:{tickUpper:number}}).position.tickUpper,
   liquidity:(previous.inventory as {position:{liquidity:string}}).position.liquidity},
  withdrawal:simulation.withdrawal,collected:simulation.collected,swap:simulation.swap,
  candidate:serializeRangeKeeperPaperCandidate(candidate),inventory:simulation.inventory,
  kernelSnapshot:recenterKernel({snapshot,frame,plan,simulation}),
  simulationHash:simulation.simulationHash,modeledCosts:simulation.modeledCosts};
 return createRangeKeeperPaperRecenterBookingModel(body);
}

function recenterKernel(input:{snapshot:Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['snapshot'];
 frame:Parameters<typeof buildRangeKeeperPaperRecenterPlan>[0]['frame'];
 plan:Awaited<ReturnType<typeof buildRangeKeeperPaperRecenterPlan>>;
 simulation:Awaited<ReturnType<typeof simulateRangeKeeperPaperRecenter>>}){
 const previous=input.snapshot.previousMark,k=previous.kernelSnapshot as Record<string,unknown>,
  c=input.plan.candidate!,price=input.frame.sqrtPriceX96,
  principal=principalAmounts({liquidity:c.liquidity,tickLower:c.range.tickLower,
   tickUpper:c.range.tickUpper,sqrtPriceX96:price}),
  priorInventory=previous.inventory as {position:{tickLower:number;tickUpper:number;liquidity:string};
   idle:{token0:string;token1:string}},priorPrincipal=principalAmounts({
   liquidity:BigInt(priorInventory.position.liquidity),tickLower:priorInventory.position.tickLower,
   tickUpper:priorInventory.position.tickUpper,sqrtPriceX96:price}),
  currentValue=(priorPrincipal.amount0+BigInt(priorInventory.idle.token0))*input.frame.price0!/
    10n**BigInt(input.snapshot.draft.profile.pool.decimals0)+
   (priorPrincipal.amount1+BigInt(priorInventory.idle.token1))*input.frame.price1!/
    10n**BigInt(input.snapshot.draft.profile.pool.decimals1),
  priorHighWater=BigInt(String(k.highWaterValue)),
  state={...input.plan.kernelState,recenters:input.snapshot.currentEpoch+1,confirmation:null,exit:null,
   lastEligible:{block:BigInt(input.frame.source.block),hash:input.frame.source.hash as `0x${string}`,
    timestamp:input.frame.source.timestamp}};
 return serializeRangeKeeperPaperKernelSnapshot({state,source:input.frame.source,
  wallet0:BigInt(input.simulation.inventory.idle.token0),wallet1:BigInt(input.simulation.inventory.idle.token1),
  released0:principal.amount0,released1:principal.amount1,
  nativeWei:BigInt(String(k.nativeWei))-BigInt(input.simulation.modeledCosts.boundWei),
  campaignStartValue:BigInt(String(k.campaignStartValue)),
  highWaterValue:priorHighWater>currentValue?priorHighWater:currentValue,
  rollingSpentCost:BigInt(String(k.rollingSpentCost))+BigInt(input.simulation.modeledCosts.boundValue),
  campaignSpentCost:BigInt(String(k.campaignSpentCost))+BigInt(input.simulation.modeledCosts.boundValue),
  reservedCost:BigInt(String(k.reservedCost)),recenters:input.snapshot.currentEpoch+1,pending:false,
  entryAllowed:false,safeExitRequired:false,executionReady:true});
}
