import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';
import {principalAmounts} from '../backtest/principal.js';
import type {RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {parseRangeKeeperPaperState,
 serializeRangeKeeperPaperKernelSnapshot} from './rangekeeper-paper-persistence.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import {readCanonicalPaperNextFrame,type PaperOpenFrame} from './paper-preview.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import type {DeploymentStore} from './store.js';
import {acquirePaperPreparationSharedLease} from './paper-preparation-lease.js';
import type {Pool} from 'pg';

type Snapshot=Awaited<ReturnType<DeploymentStore['rangeKeeperPaperMaintenanceSnapshot']>>;
type MarkInput=Parameters<DeploymentStore['recordRangeKeeperPaperMark']>[0];

const positive=(n:bigint|null|undefined):n is bigint=>typeof n==='bigint'&&n>0n;
const tokenValue=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);

function snapshotValue(model:RangeKeeperPaperOpenModel,inventory:{position:{tickLower:number;
 tickUpper:number;liquidity:string};idle:{token0:string;token1:string}}){
 const p=model.poolState,refs=model.reference;
 if(!positive(refs.price0===null?null:BigInt(refs.price0))||
  !positive(refs.price1===null?null:BigInt(refs.price1)))
  throw Error('rangekeeper_paper_maintenance_open_reference_unavailable');
 if(!model.candidate)throw Error('rangekeeper_paper_maintenance_open_candidate_unavailable');
 const principal=principalAmounts({liquidity:BigInt(inventory.position.liquidity),
  tickLower:inventory.position.tickLower,tickUpper:inventory.position.tickUpper,
  sqrtPriceX96:BigInt(p.sqrtPriceX96)});
 const amount0=principal.amount0+BigInt(inventory.idle.token0),
  amount1=principal.amount1+BigInt(inventory.idle.token1);
 return {amount0,amount1};
}

/** Build the durable monitor state for one source-pinned observation. The
 * opened inventory remains fixed: this advances RangeKeeper's outside-range
 * timer but never proposes or records an economic action. */
export function buildRangeKeeperPaperMaintenanceKernel(input:{snapshot:Snapshot;frame:PaperOpenFrame}){
 const {snapshot,frame}=input,draft=snapshot.draft as RangeKeeperPaperDraft,
  model=snapshot.openMark.model as RangeKeeperPaperOpenModel,
  policy=resolveRangeKeeperPaperPolicy(draft,snapshot.runtimeIdentity.buildId);
 if(!policy.policy||policy.unavailable.length||policy.policy.policyHash!==model.kernelPolicyHash||
  policy.policy.buildId!==model.kernelBuildId)
  throw Error('rangekeeper_paper_maintenance_policy_unavailable');
 if(frame.source.block===snapshot.previousMark.source.block||
  BigInt(frame.source.block)<=BigInt(snapshot.previousMark.source.block)||
  frame.source.timestamp<snapshot.previousMark.source.timestamp)
  throw Error('rangekeeper_paper_maintenance_source_order_invalid');
 if(!frame.referenceEligible||!frame.referenceProof||!positive(frame.price0)||!positive(frame.price1)||
  !positive(frame.nativePrice))throw Error('rangekeeper_paper_maintenance_reference_unavailable');
 const source=frame.source,openSource=snapshot.openMark.source,
  inventory=snapshot.openMark.inventory,
  previousKernel=snapshot.previousMark.kernelSnapshot as Record<string,unknown>|null|undefined,
  firstMark=previousKernel==null,
  state:RangeKeeperState=firstMark?
   parseRangeKeeperPaperState(snapshot.openMark.kernelState):
   parseRangeKeeperPaperState(previousKernel.state);
 if(state.buildId!==snapshot.runtimeIdentity.buildId||
  state.configHash.toLowerCase()!==`0x${policy.policy.policyHash}`.toLowerCase())
  throw Error('rangekeeper_paper_maintenance_kernel_identity_invalid');
 const position=inventory.position,inside=frame.tick>=position.tickLower&&frame.tick<position.tickUpper,
  prior=state.exit,elapsed=source.timestamp-(prior?.since??source.timestamp),gap=source.timestamp-(prior?.lastOutsideAt??source.timestamp);
 if(inside)state.exit=null;
 else if(!prior||prior.tokenId!==model.candidateHash||prior.tickLower!==position.tickLower||
  prior.tickUpper!==position.tickUpper||gap<0||gap>policy.policy.limits.maxObservationGapSeconds){
  state.exit={tokenId:model.candidateHash!,tickLower:position.tickLower,tickUpper:position.tickUpper,
   block:BigInt(source.block),hash:source.hash as `0x${string}`,since:source.timestamp,lastOutsideAt:source.timestamp};
 }else state.exit={...prior,block:BigInt(source.block),hash:source.hash as `0x${string}`,
  lastOutsideAt:source.timestamp};
 state.lastEligible={block:BigInt(source.block),hash:source.hash as `0x${string}`,
  timestamp:source.timestamp};
 state.confirmation=null;
 const positionAmounts=principalAmounts({liquidity:BigInt(position.liquidity),
  tickLower:position.tickLower,tickUpper:position.tickUpper,sqrtPriceX96:frame.sqrtPriceX96}),
  principalOnlyValue=tokenValue(positionAmounts.amount0+BigInt(inventory.idle.token0),frame.price0,draft.profile.pool.decimals0)+
   tokenValue(positionAmounts.amount1+BigInt(inventory.idle.token1),frame.price1,draft.profile.pool.decimals1),
  openingAmounts=firstMark?snapshotValue(model,inventory):null,
  campaignStartValue=firstMark?
   tokenValue(openingAmounts!.amount0,BigInt(model.reference.price0!),draft.profile.pool.decimals0)+
    tokenValue(openingAmounts!.amount1,BigInt(model.reference.price1!),draft.profile.pool.decimals1):
    BigInt(String(previousKernel!.campaignStartValue)),
  highWaterValue=firstMark?(campaignStartValue>principalOnlyValue?campaignStartValue:principalOnlyValue):
   BigInt(String(previousKernel!.highWaterValue))>principalOnlyValue?
    BigInt(String(previousKernel!.highWaterValue)):principalOnlyValue,
  priorKernel=previousKernel;
 const kernelSnapshot=serializeRangeKeeperPaperKernelSnapshot({state,source,wallet0:BigInt(inventory.idle.token0),
  wallet1:BigInt(inventory.idle.token1),released0:positionAmounts.amount0,released1:positionAmounts.amount1,
  nativeWei:BigInt(draft.allocation.nativeWei),campaignStartValue,highWaterValue,
  rollingSpentCost:priorKernel?BigInt(String(priorKernel.rollingSpentCost)):0n,
  campaignSpentCost:priorKernel?BigInt(String(priorKernel.campaignSpentCost)):0n,
  reservedCost:priorKernel?BigInt(String(priorKernel.reservedCost)):0n,recenters:0,pending:false,
  entryAllowed:false,safeExitRequired:false,executionReady:false});
 const persistentOutside=state.exit!==null&&source.timestamp-state.exit.since>=300,
  decision={action:'wait' as const,reason:inside?'inside_range':persistentOutside?
   'outside_range_persistence_elapsed':'outside_range_observed'};
 assert(openSource.block===model.source.block,'rangekeeper_paper_maintenance_open_anchor_invalid');
 return {kernelSnapshot,decision,valuation:{principal:positionAmounts,principalOnlyValue,campaignStartValue,
  highWaterValue},actionAvailable:false as const};
}

/** One bounded signer-free RangeKeeper paper observation. */
export async function maintainRangeKeeperPaperObservation(store:DeploymentStore,
 client:RobinhoodClient,indexer:Pool,campaignId:string,
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
 const lease=await acquirePaperPreparationSharedLease(indexer,campaignId);
 if(!lease)return {status:'preparation_locked' as const,actionAvailable:false as const};
 try{
 const snapshot=await store.rangeKeeperPaperMaintenanceSnapshot(campaignId),
  frame=await readCanonicalPaperNextFrame(client,snapshot.draft.profile,
   {sourceBlock:snapshot.previousMark.source.block,sourceHash:snapshot.previousMark.source.hash}),
  built=buildRangeKeeperPaperMaintenanceKernel({snapshot,frame});
 const result=await store.recordRangeKeeperPaperMark({campaignId,source:frame.source,
  kernelSnapshot:built.kernelSnapshot,frame,decision:built.decision,verifyAnchors});
 return {status:'observed' as const,...result,source:frame.source,decision:built.decision,
  actionAvailable:false as const};
 }finally{await lease.release();}
}
