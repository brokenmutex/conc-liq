import type {Address,Hex} from 'viem';
import type {LiveWalletIdentity,LiveWalletSource,LiveWalletTokenAllocation} from './live-wallet-store.js';
import type {RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import type {RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import assert from 'node:assert/strict';
import {contentHash} from './contracts.js';
import {liveSetupEvidenceHash} from './rangekeeper-live-setup-simulation.js';
import {nextRangeKeeperStage} from '../strategy/rangekeeper/live-stage.js';
import {authorizeRangeKeeperTx,encodeRangeKeeperTx} from '../strategy/rangekeeper/calldata.js';
import {strategyBalances} from '../strategy/rangekeeper/funding.js';
import {RANGEKEEPER_ALLOWANCE_POLICY,allowanceCeiling,rangeKeeperAllowanceExposure,type RangeKeeperAllowancePolicy} from '../strategy/rangekeeper/allowance-policy.js';
import {consumeRangeKeeperLiveStageProof,type RangeKeeperLiveStageProof,type RangeKeeperLiveStageProofRequest,type RangeKeeperLiveStageEvidence}
 from './rangekeeper-live-stage-proof.js';
import type {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import type {PilotIntent} from '../live-pilot/journal.js';

export interface RangeKeeperLiveCampaignAllocation {
 allocationId:string;campaignId:string;revision:number;wallet:string;
 liquidByTokenAddress:Record<string,bigint>;nativeSpendWei:bigint;pendingNativeSpendWei:bigint;exitReserveWei:bigint;
 nftTokenIds:string[];allocationHash:string;sourceGeneration:number;sourceHash:Hex;
}
export interface RangeKeeperLiveCampaign {
 id:string;chainId:4663;wallet:Address;revision:number;profileId:string;profileHash:string;profile:unknown;
 config:RangeKeeperConfig;configHash:Hex;revisionConfig:unknown;revisionConfigHash:string;
 allocation:RangeKeeperLiveCampaignAllocation;baseline:unknown;reviewPayload:unknown;
 state:RangeKeeperLiveState|null;stateHash:string|null;stateRevision:number;status:'opening'|'active'|'blocked'|'closing'|'closed';
}
export interface RangeKeeperRuntimeEventInput extends LiveWalletIdentity {
 campaignId:string;revision:number;effectId:string;kind:'initialized'|'opened'|'stage_receipt'|'mark'|'closed'|'blocked';
 expectedStateHash:string|null;state:RangeKeeperLiveState;source:LiveWalletSource;receiptHash?:Hex|null;payload:unknown;
 /** Required only when creating the first state after canonical open+cleanup reconciliation. */
 initial?:{profileId:string;profileHash:string;profile:unknown;config:RangeKeeperConfig;configHash:Hex;
  revisionConfigHash:string;allocationId:string;initialToken0Raw:string;initialToken1Raw:string;initialNativeWei:string;baseline:unknown};
}
export interface RangeKeeperRuntimeEventResult {state:RangeKeeperLiveState;stateHash:string;stateRevision:number;replayed:boolean}
export type RangeKeeperPrices={price0:bigint;price1:bigint;nativePrice:bigint};

/** Immutable manager review consumed by the existing wallet queue. It can
 * request a recenter or retain-only close for an existing allocation; it never
 * changes campaign capital or contains signer/transaction material. */
export interface RangeKeeperLiveManagementReviewPayload {
 schemaVersion:1;kind:'rangekeeper_live_management_review';mode:'live';strategyId:'rangekeeper_v1';
 operationKind:'change_range'|'close_retain';campaignId:string;revision:number;allocationId:string;
 profileId:string;profileHash:string;configHash:string;buildId:string;runtimeStateHash:string;stateRevision:number;
 wallet:{address:string;generation:number;commitmentsHash:string;nonce:string};
 source:LiveWalletSource;reference:{proofHash:string;price0:string;price1:string;nativePrice:string;evidence:unknown};
 snapshot:RangeKeeperSnapshot;position:unknown;decision:{reason:string;observationHash:string};candidate:RangeKeeperCandidate|null;
 policy:RangeKeeperState|null;costs:unknown;expiresAt:number;
}

const eqAddress=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const sameLiveSource=(a:{block:string|bigint;hash:string;timestamp:number},b:{block:string|bigint;hash:string;timestamp:number})=>
 String(a.block)===String(b.block)&&a.hash.toLowerCase()===b.hash.toLowerCase()&&a.timestamp===b.timestamp;
/** Validate the frozen manager review against persisted campaign identity and
 * derive the sole permitted state transition. The caller persists the returned
 * state using runtime-event CAS before asking for a transaction stage. */
export function deriveRangeKeeperLiveManagementTransition(campaign:RangeKeeperLiveCampaign,
 payload:RangeKeeperLiveManagementReviewPayload):RangeKeeperLiveState{
 const state=campaign.state;assert(state,'Campaign runtime state is not initialized');
 assert(payload.schemaVersion===1&&payload.kind==='rangekeeper_live_management_review'&&payload.mode==='live'&&
  payload.strategyId==='rangekeeper_v1','Unsupported live management review');
 assert(payload.campaignId===campaign.id&&payload.revision===campaign.revision&&payload.allocationId===campaign.allocation.allocationId,
  'Management review campaign/allocation identity changed');
 assert(payload.profileId===campaign.profileId&&payload.profileHash===campaign.profileHash&&
  payload.configHash===campaign.configHash.slice(2)&&payload.buildId===state.buildId&&
  /^[0-9a-f]{64}$/.test(payload.runtimeStateHash)&&Number.isSafeInteger(payload.stateRevision)&&payload.stateRevision>0,
  'Management review is stale or bound to another runtime');
 assert(eqAddress(payload.wallet.address,campaign.wallet)&&eqAddress(state.operator,campaign.wallet)&&
  Number.isSafeInteger(payload.wallet.generation)&&payload.wallet.generation>0&&payload.wallet.generation>=campaign.allocation.sourceGeneration&&
  /^[0-9a-f]{64}$/.test(payload.wallet.commitmentsHash),
  'Management review wallet identity changed');
 assert(payload.wallet.nonce===String(payload.snapshot.nonce)&&payload.snapshot.nonce>=state.last.nonce,
  'Management review nonce differs from campaign snapshot');
 assert(sameLiveSource(payload.source,payload.snapshot.source),'Management review source differs from observed snapshot');
 assert(BigInt(payload.source.block)>=state.last.source.block&&payload.source.timestamp>=state.last.source.timestamp,
  'Management review source moved backwards');
 if(BigInt(payload.source.block)===state.last.source.block)assert(payload.source.hash.toLowerCase()===state.last.source.hash.toLowerCase(),
  'Management review source conflicts with campaign source');
 assert(payload.reference.proofHash.length===64&&/^[0-9a-f]{64}$/.test(payload.reference.proofHash)&&
  [payload.reference.price0,payload.reference.price1,payload.reference.nativePrice].every(v=>/^[1-9][0-9]*$/.test(v)),
  'Management review reference proof is incomplete');
 const costs=payload.costs as any,costGas=costs?.gasWei??costs?.stageGasWei??costs?.actionGasWei,
  costValue=costs?.actionCostValue??costs?.costValue??costs?.gasValueUsdX18;
 assert(costs?.status==='estimated'&&costs?.provenance==='owned_fork_allocated_lifecycle_v1'&&
  sameLiveSource(costs.source,payload.source)&&typeof costGas==='string'&&/^[1-9][0-9]*$/.test(costGas)&&
  typeof costValue==='string'&&/^[1-9][0-9]*$/.test(costValue),'Management review lacks source-bound owned-fork cost evidence');
 assert(payload.decision.observationHash.length===64&&/^[0-9a-f]{64}$/.test(payload.decision.observationHash),
  'Management review observation digest is malformed');
 const desiredPhase=payload.operationKind==='close_retain'?'exit':'recenter';
 const replayed=campaign.stateHash!==payload.runtimeStateHash&&state.phase===desiredPhase&&
  state.lastReason===`manager_${payload.operationKind==='close_retain'?'close_retain':'recenter'}:${payload.decision.reason}`&&
  sameLiveSource(state.last.source,payload.source)&&
  (payload.operationKind==='close_retain'?state.exitMode==='retain':state.candidate!==null&&payload.candidate!==null&&
   JSON.stringify(state.candidate,(_,v)=>typeof v==='bigint'?String(v):v)===
   JSON.stringify(payload.candidate,(_,v)=>typeof v==='bigint'?String(v):v));
 assert(campaign.stateHash===payload.runtimeStateHash&&campaign.stateRevision===payload.stateRevision||replayed,
  'Management review is stale or another state transition won');
 if(replayed)return structuredClone(state);
 const next=structuredClone(state);
 next.last=structuredClone(payload.snapshot);
 if(payload.operationKind==='close_retain'){
  assert(state.phase==='holding'&&state.activeTokenId!==null,'Retain close requires a held campaign position');
  next.phase='exit';next.desired='stopped';next.exitMode='retain';next.candidate=null;next.swapDone=false;next.swapConfirmedAt=null;
  next.withdrawDone=false;next.actionStartCostIndex=next.costEvents.length;
  next.reservedActionCost=BigInt((payload.costs as any)?.actionCostValue??(payload.costs as any)?.costValue??
   (payload.costs as any)?.gasValueUsdX18??'0');
  assert(next.reservedActionCost>0n,'Retain cost authorization is missing');
  next.lastReason=`manager_close_retain:${payload.decision.reason}`;
 }else{
  assert(state.phase==='holding'&&state.activeTokenId!==null,'Recenter requires a held campaign position');
  const candidate=payload.candidate;assert(candidate&&candidate.kind==='recenter','Recenter review lacks a recenter candidate');
  assert(candidate.sourceBlock===BigInt(payload.source.block)&&candidate.sourceHash.toLowerCase()===payload.source.hash.toLowerCase()&&
   candidate.expiresAt>payload.source.timestamp,'Recenter candidate source/expiry mismatch');
  assert(payload.policy&&payload.policy.configHash===campaign.configHash&&payload.policy.buildId===state.buildId,
   'Recenter policy state binding changed');
  assert(payload.policy.lastEligible&&String(payload.policy.lastEligible.block)===payload.source.block&&
   payload.policy.lastEligible.hash.toLowerCase()===payload.source.hash.toLowerCase()&&
   payload.policy.lastEligible.timestamp===payload.source.timestamp&&payload.policy.confirmation===null,
   'Recenter planner state is not confirmed at the frozen observation source');
  next.phase='recenter';next.desired='running';next.exitMode=null;next.haltReason=null;next.policy=structuredClone(payload.policy);
  next.candidate=structuredClone(candidate);next.swapDone=false;next.swapConfirmedAt=null;next.withdrawDone=false;
  next.actionStartCostIndex=next.costEvents.length;next.reservedActionCost=BigInt((payload.costs as any)?.actionCostValue??
   (payload.costs as any)?.costValue??(payload.costs as any)?.gasValueUsdX18??'0');
  assert(next.reservedActionCost>0n,'Recenter cost authorization is missing');
  next.lastReason=`manager_recenter:${payload.decision.reason}`;
 }
 return next;
}

/** Terminal state is only created after the queue independently verifies the
 * retain-close receipt and allowance/custody cleanup. */
export function deriveRangeKeeperLiveClosedState(state:RangeKeeperLiveState,source:LiveWalletSource):RangeKeeperLiveState{
 assert(state.phase==='exit'&&state.desired==='stopped'&&state.exitMode==='retain'&&state.activeTokenId===null&&state.candidate===null,
  'Campaign can close only after retained exit has removed its managed position');
 assert(BigInt(source.block)>=state.last.source.block,'Close source moved backwards');
 const next=structuredClone(state);next.phase='closed';next.desired='stopped';next.closedAt=source.timestamp;
 next.lastReason='retain_close_complete';next.last={...next.last,source:{block:BigInt(source.block),hash:source.hash as `0x${string}`,timestamp:source.timestamp}};
 return next;
}
/** `retry` counts this job's cancelled unsigned intents: a cancelled outbox row keeps its (job,stage) key,
 * so the replacement stage for the identical plan needs a distinct, deterministic identity. */
export function deriveRangeKeeperStage(plan:RangeKeeperTxPlan,stateRevision=0,retry=0):string{
 assert(Number.isSafeInteger(stateRevision)&&stateRevision>=0,'Invalid campaign state revision for stage identity');
 assert(Number.isSafeInteger(retry)&&retry>=0&&retry<=9999,'Invalid stage retry counter');
 return `${plan.kind}:${liveSetupEvidenceHash({plan,stateRevision}).slice(0,32)}${retry>0?`:r${retry}`:''}`;
}
/** A retained exit is the only state in which the exit reserve is spendable, whichever job kind carries it. */
export const isRangeKeeperRetainedExit=(state:Pick<RangeKeeperLiveState,'phase'|'desired'|'exitMode'>|null|undefined)=>
 !!state&&state.phase==='exit'&&state.desired==='stopped'&&state.exitMode==='retain';
/** A recenter whose withdrawal is reconciled but whose replacement range was discarded as stale. It owns loose
 * inventory only; the next range must be re-planned from fresh canonical observations. */
export const isRangeKeeperAwaitingReplan=(state:RangeKeeperLiveState|null|undefined)=>
 !!state&&state.phase==='recenter'&&state.desired==='running'&&state.withdrawDone&&!state.swapDone&&
 state.activeTokenId===null&&state.candidate===null;
/** Cap a whole-wallet pool snapshot to this campaign's remaining liquid and
 * native spend. The canonical snapshot itself stays intact for fork proof. */
export function deriveRangeKeeperCampaignStageSnapshot(campaign:RangeKeeperLiveCampaign,snapshot:RangeKeeperSnapshot):RangeKeeperSnapshot{
 const p=campaign.config.pool,a0=campaign.allocation.liquidByTokenAddress[p.token0.toLowerCase()],
  a1=campaign.allocation.liquidByTokenAddress[p.token1.toLowerCase()];
 assert(a0!==undefined&&a1!==undefined&&a0>=0n&&a1>=0n,'Campaign liquid allocation is incomplete');
 assert(campaign.allocation.nativeSpendWei>=0n&&campaign.allocation.exitReserveWei>=0n,'Campaign native allocation is invalid');
 if(campaign.state)assert(campaign.state.reserve0===0n&&campaign.state.reserve1===0n&&campaign.state.reserveNativeWei===0n,
  'Shared-wallet campaign strategy reserves must be zero; wallet allocation already isolates its spend');
 if(snapshot.position)assert(campaign.allocation.nftTokenIds.includes(String(snapshot.position.tokenId)),
  'Pool snapshot position is not owned by this campaign');
 return {...snapshot,wallet0:snapshot.wallet0<a0?snapshot.wallet0:a0,wallet1:snapshot.wallet1<a1?snapshot.wallet1:a1,
  nativeWei:snapshot.nativeWei<campaign.allocation.nativeSpendWei?snapshot.nativeWei:campaign.allocation.nativeSpendWei};
}
export function sameRangeKeeperPlan(a:RangeKeeperTxPlan,b:RangeKeeperTxPlan):boolean{
 const canonical=(v:unknown):string=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x);
 return canonical(a)===canonical(b);
}

export interface RangeKeeperStageReferences extends RangeKeeperPrices {proofHash:string;source:LiveWalletSource;evidence:unknown}
export interface RangeKeeperStageWalletBefore {walletGeneration:number;wallet:{operator:string;source:LiveWalletSource;nonce:number;pendingNonce:number;
 nativeWei:bigint;tokens:Record<string,bigint>;nftTokenIds:string[];allowances:{token:string;spender:string;amount:bigint}[]};}
export interface PrepareRangeKeeperLiveStageInput {
 campaign:RangeKeeperLiveCampaign;snapshot:RangeKeeperSnapshot;source:LiveWalletSource;references:RangeKeeperStageReferences;
 chain:RangeKeeperChain;verifyReferences:(references:RangeKeeperStageReferences)=>Promise<boolean>;
 walletBefore:RangeKeeperStageWalletBefore;stage:string;proposedPlan:RangeKeeperTxPlan;intent:PilotIntent;exitSpendAllowed?:boolean;
 /** Cancelled unsigned intents already recorded for this job. */
 stageRetry?:number;
 /** Shared-wallet allowance policy with the pairs sibling campaigns still use; defaults to no retained pair. */
 allowancePolicy?:RangeKeeperAllowancePolicy;
}
export interface AuthorizedRangeKeeperLiveStage {
 intent:PilotIntent;plan:RangeKeeperTxPlan;pool:RangeKeeperConfig['pool'];
 before:RangeKeeperStageWalletBefore&{snapshot:RangeKeeperSnapshot;allocation:{campaignId:string;liquidByTokenAddress:Record<string,bigint>;
  nativeSpendWei:bigint;exitReserveWei:bigint;nftTokenIds:string[]}};
 authorization:Readonly<RangeKeeperLiveStageEvidence>&{referenceEvidence:unknown;referenceSource:LiveWalletSource;
  prices:{price0:string;price1:string;nativePrice:string};profileId:string;revision:number;allocationId:string};
}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** persistent_capped_v1 for one campaign. Exposure uses only immutable persisted inputs (initial allocation, deployment cap,
 * frozen review prices), never live prices or balances, so every stage and integrity check derives the same cap. */
export function rangeKeeperCampaignAllowancePolicy(campaign:Pick<RangeKeeperLiveCampaign,'config'|'state'|'allocation'|'reviewPayload'>,
 retain:ReadonlySet<string>=new Set()):RangeKeeperAllowancePolicy{
 const p=campaign.config.pool,liquid=campaign.allocation.liquidByTokenAddress,refs=(campaign.reviewPayload as any)?.references;
 const price=(value:unknown)=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?BigInt(value):null,
  price0=price(refs?.price0),price1=price(refs?.price1);
 return {kind:RANGEKEEPER_ALLOWANCE_POLICY,retain,exposure:rangeKeeperAllowanceExposure({
  initial:campaign.state?[campaign.state.initial0,campaign.state.initial1]:[liquid[p.token0.toLowerCase()]??0n,liquid[p.token1.toLowerCase()]??0n],
  maxDeploymentValue:campaign.config.limits.maxDeploymentValue,decimals:[p.decimals0,p.decimals1],
  prices:price0!==null&&price1!==null?[price0,price1]:null})};
}
function futureApprovalCap(campaign:RangeKeeperLiveCampaign,snapshot:RangeKeeperSnapshot,plan:RangeKeeperTxPlan,prices:RangeKeeperPrices){
 const state=campaign.state;if(!state||plan.kind!=='approve'||plan.spender!=='positionManager'||!state.candidate?.swap)return 0n;
 const acquired:0|1=state.candidate.swap.token===0?1:0;if(plan.token!==acquired)return 0n;
 const funds=strategyBalances(snapshot,{reserve0:state.reserve0,reserve1:state.reserve1,reserveNativeWei:state.reserveNativeWei});
 const balance=acquired===0?funds.amount0:funds.amount1,price=acquired===0?prices.price0:prices.price1,
  decimals=acquired===0?campaign.config.pool.decimals0:campaign.config.pool.decimals1;
 const cap=campaign.config.limits.maxDeploymentValue*10n**BigInt(decimals)/price;
 const future=balance>cap?balance:cap;return future>balance?future-balance:0n;
}

/** Rebuild one strategy stage from persisted campaign state before requesting a fork capability. */
export async function prepareRangeKeeperLiveStageAuthorization(input:PrepareRangeKeeperLiveStageInput):Promise<{
 stage:string;plan:RangeKeeperTxPlan;request:RangeKeeperLiveStageProofRequest
}>{
 const c=input.campaign;assert(c.state,'Campaign runtime state is not initialized');
 assert(contentHash(c.profile)===c.profileHash,'Registered profile hash changed');
 assert(c.config.operator&&same(c.config.operator,c.wallet),'Frozen kernel operator differs from allocated wallet');
 assert(input.source.block===String(input.snapshot.source.block)&&input.source.hash.toLowerCase()===input.snapshot.source.hash.toLowerCase()&&
  input.source.timestamp===input.snapshot.source.timestamp,'Stage source differs from strategy snapshot');
 assert(input.references.source.block===input.source.block&&input.references.source.hash.toLowerCase()===input.source.hash.toLowerCase()&&
  input.references.source.timestamp===input.source.timestamp&&input.references.price0>0n&&input.references.price1>0n&&input.references.nativePrice>0n&&
  input.references.proofHash.length===64,'Reference evidence is not bound to this stage source');
 const verified=await input.chain.verify({block:BigInt(input.source.block),hash:input.source.hash as Hex,timestamp:input.source.timestamp});
 assert(verified&&input.references.evidence&&await input.verifyReferences(input.references),
  'Canonical pool/profile verification or independent reference proof missing');
 const wb=input.walletBefore.wallet,s=input.snapshot;
 assert(same(wb.operator,c.wallet)&&same(s.operator,c.wallet),'Stage wallet/operator differs from campaign');
 assert(wb.nonce===wb.pendingNonce&&wb.nonce===Number(s.nonce),'Wallet canonical/pending nonce or pool snapshot mismatch');
 assert(wb.source.block===input.source.block&&same(wb.source.hash,input.source.hash)&&wb.source.timestamp===input.source.timestamp,
  'Whole-wallet before image differs from stage source');
 assert(wb.nativeWei===s.nativeWei&&wb.tokens[c.config.pool.token0.toLowerCase()]===s.wallet0&&
  wb.tokens[c.config.pool.token1.toLowerCase()]===s.wallet1,'Whole-wallet liquid inventory differs from strategy snapshot');
 const strategySnapshot=deriveRangeKeeperCampaignStageSnapshot(c,input.snapshot);
 const retainedExit=c.state.phase==='exit'&&c.state.desired==='stopped'&&c.state.exitMode==='retain';
 assert(input.exitSpendAllowed!==true||retainedExit,'Exit reserve is spendable only for a retained close');
 const exitSpendAllowed=input.exitSpendAllowed===true&&retainedExit;
 const allowancePolicy=input.allowancePolicy??rangeKeeperCampaignAllowancePolicy(c);
 const plan=await nextRangeKeeperStage(c.state,strategySnapshot,c.config,input.chain,
  {price0:input.references.price0,price1:input.references.price1},allowancePolicy);
 assert(plan,'No RangeKeeper stage is currently authorized');
 const stage=deriveRangeKeeperStage(plan,c.stateRevision,input.stageRetry??0);assert.equal(input.stage,stage,'Caller stage differs from derived strategy stage');
 assert(sameRangeKeeperPlan(plan,input.proposedPlan),'Caller plan differs from persisted strategy state');
 const allocation={campaignId:c.id,liquidByTokenAddress:c.allocation.liquidByTokenAddress,nativeSpendWei:c.allocation.nativeSpendWei,
  exitReserveWei:c.allocation.exitReserveWei,nftTokenIds:c.allocation.nftTokenIds};
 const request:RangeKeeperLiveStageProofRequest={campaignId:c.id,allocationId:c.allocation.allocationId,revision:c.revision,stage,
  buildId:String((c.reviewPayload as any)?.binding?.buildId),profileHash:c.profileHash,allocationHash:c.allocation.allocationHash,
  config:c.config,source:{block:BigInt(input.source.block),hash:input.source.hash as Hex,timestamp:input.source.timestamp},plan,beforePool:input.snapshot,
  allocation,prices:{price0:input.references.price0,price1:input.references.price1,nativePrice:input.references.nativePrice},
  referenceProofHash:input.references.proofHash,futureApprovalCap:futureApprovalCap(c,strategySnapshot,plan,input.references),
  allowanceCeiling:[allowanceCeiling(allowancePolicy.exposure[0]),allowanceCeiling(allowancePolicy.exposure[1])],exitSpendAllowed};
 return {stage,plan,request};
}

/** Consume an opaque, fresh owned-fork capability and return only the exact
 * intent/plan/before image it authorized. Missing or mismatched evidence throws. */
export async function authorizeRangeKeeperLiveStage(input:PrepareRangeKeeperLiveStageInput&{capability:RangeKeeperLiveStageProof;now?:()=>number}):Promise<AuthorizedRangeKeeperLiveStage>{
 const prepared=await prepareRangeKeeperLiveStageAuthorization(input),c=input.campaign,request=prepared.request,plan=prepared.plan;
 const strategySnapshot=deriveRangeKeeperCampaignStageSnapshot(c,input.snapshot);
 const evidence=consumeRangeKeeperLiveStageProof(input.capability,request,{now:input.now});
 assert.equal(evidence.stage,input.stage);assert.equal(evidence.campaignId,c.id);assert.equal(evidence.allocationId,c.allocation.allocationId);
 assert.equal(evidence.revision,c.revision);assert.equal(evidence.buildId,request.buildId);
 assert.equal(evidence.profileHash,c.profileHash);assert.equal(evidence.allocationHash,c.allocation.allocationHash);
 assert.equal(evidence.configHash,c.configHash.slice(2));assert.equal(evidence.referenceProofHash,input.references.proofHash);
 assert.equal(evidence.source.block,input.source.block);assert.equal(evidence.source.hash.toLowerCase(),input.source.hash.toLowerCase());
 assert.equal(evidence.planHash,liveSetupEvidenceHash(plan));
 const call=encodeRangeKeeperTx(c.config.pool,input.snapshot.operator,plan);
 assert.equal(evidence.calldataHash,liveSetupEvidenceHash(call));
 assert.equal(evidence.beforeHash,liveSetupEvidenceHash(input.snapshot));
 assert.equal(evidence.gasUnitsBound, input.intent.gas);assert.equal(evidence.maxFeePerGasWei,input.intent.maxFeePerGas);
 assert.equal(evidence.priorityFeePerGasWei,input.intent.maxPriorityFeePerGas);
 assert.equal(evidence.nonce,input.intent.nonce);assert.equal(input.intent.sourceBlock,input.source.block);
 assert(same(input.intent.sourceHash,input.source.hash)&&same(input.intent.operator,input.walletBefore.wallet.operator));
 assert(same(input.intent.to,call.to)&&same(input.intent.data,call.data),'Intent calldata differs from strategy encoding');
 assert.equal(input.intent.action,plan.kind);assert.equal(input.intent.value,'0');
 const stageGasWei=BigInt(evidence.stageGasWei),stageCost=BigInt(evidence.costValue);
 const retainedExit=c.state!.phase==='exit'&&c.state!.desired==='stopped'&&c.state!.exitMode==='retain';
 assert(request.exitSpendAllowed===retainedExit||request.exitSpendAllowed===false&&!retainedExit,
  'Stage proof exit-reserve permission differs from campaign state');
 assert(stageGasWei>=0n&&stageCost>=0n&&stageGasWei<=c.allocation.nativeSpendWei+(request.exitSpendAllowed?c.allocation.exitReserveWei:0n),
  'Stage gas would invade exit reserve or exceed remaining campaign native spend');
 const actionStart=c.state!.actionStartCostIndex;
 assert(Number.isSafeInteger(actionStart)&&actionStart>=0&&actionStart<=c.state!.costEvents.length,
  'Campaign action-cost cursor is invalid');
 // Cost policy bounds discretionary actions. A retained exit is bounded by the scoped exit reserve above and
 // must stay reachable when the campaign budget is exhausted or an earlier receipt could not be valued.
 if(!retainedExit){
  const actionCost=c.state!.costEvents.slice(actionStart).reduce<bigint|null>((sum,event)=>
   sum===null||event.gasValue===null||event.swapFeeValue===null||event.swapShortfallValue===null?null:
    sum+event.gasValue+event.swapFeeValue+event.swapShortfallValue,0n);
  assert(actionCost!==null&&actionCost+stageCost<=c.config.limits.maxActionCost,
   'Owned-fork stage exceeds per-action cost policy');
  const cumulative=c.state!.costEvents.reduce<bigint|null>((sum,event)=>
   sum===null||event.gasValue===null||event.swapFeeValue===null||event.swapShortfallValue===null?null:
    sum+event.gasValue+event.swapFeeValue+event.swapShortfallValue,0n);
  assert(cumulative!==null,'Campaign has incomplete prior cost evidence');
  assert(cumulative+stageCost<=BigInt(c.config.limits.maxCampaignCost)&&
   cumulative+stageCost<=BigInt(c.config.limits.maxRollingCost),'Owned-fork stage exceeds cumulative campaign cost policy');
 }
 if(plan.kind==='mint')assert(c.config.campaignScope.maxEconomicActions===0||c.state!.economicActions<c.config.campaignScope.maxEconomicActions,
  'Campaign economic action count is exhausted');
 const semanticWallet={operator:strategySnapshot.operator,wallet0:strategySnapshot.wallet0,wallet1:strategySnapshot.wallet1,tick:strategySnapshot.tick,
  sqrtPriceX96:strategySnapshot.sqrtPriceX96,timestamp:strategySnapshot.source.timestamp,
  position:strategySnapshot.position?{...strategySnapshot.position,tokenId:strategySnapshot.position.tokenId!}:null};
 authorizeRangeKeeperTx(c.config.pool,semanticWallet,plan,c.config.limits.maxSlippageBps,c.config.limits.fullWidthSpacings,
  request.futureApprovalCap,request.allowanceCeiling);
 const allocation={campaignId:c.id,liquidByTokenAddress:c.allocation.liquidByTokenAddress,nativeSpendWei:c.allocation.nativeSpendWei,
  exitReserveWei:c.allocation.exitReserveWei,nftTokenIds:c.allocation.nftTokenIds};
 const before={...input.walletBefore,snapshot:input.snapshot,allocation};
 return {intent:input.intent,plan,pool:c.config.pool,before,
  authorization:{...evidence,referenceEvidence:input.references.evidence,referenceSource:input.references.source,
   prices:{price0:input.references.price0.toString(),price1:input.references.price1.toString(),nativePrice:input.references.nativePrice.toString()},
   profileId:c.profileId,revision:c.revision,allocationId:c.allocation.allocationId}};
}
