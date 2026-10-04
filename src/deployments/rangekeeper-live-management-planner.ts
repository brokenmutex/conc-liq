import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {contentHash} from './contracts.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import {readWalletState,withLiveWalletTransaction} from './live-wallet-store.js';
import {readLiveWalletLane} from './live-wallet-queue.js';
import {convertRangeKeeperRecenterToRetainExit,deriveRangeKeeperLiveReplanTransition,rangeKeeperLiveCostBudgetExhausted,
 rangeKeeperLiveRemainingActionBudget} from './rangekeeper-live-management-recovery.js';
import {isRangeKeeperAwaitingReplan} from './rangekeeper-live-campaign.js';
import {appendRangeKeeperLiveCampaignEventInTransaction,readRangeKeeperLiveCampaign} from './rangekeeper-live-campaign-store.js';
import type {RangeKeeperLiveCampaign,RangeKeeperLiveManagementReviewPayload} from './rangekeeper-live-campaign.js';
import {recordRangeKeeperLiveManagementReview,enqueueRangeKeeperLiveManagementReview,
 type RangeKeeperLiveManagementQueueInput} from './rangekeeper-live-management.js';
import type {RangeKeeperLiveManagementObservation} from './rangekeeper-live-management.js';
import type {RobinhoodClient} from '../client.js';
import {marketProfileSchema} from './market-profile.js';
import {RangeKeeperChain,type RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {planRangeKeeper} from '../strategy/rangekeeper/planner.js';
import type {RangeKeeperCandidate,RangeKeeperDecision,RangeKeeperLimits,RangeKeeperObservation,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {simulateRangeKeeperCandidate} from '../strategy/rangekeeper/fork-simulator.js';
import {RANGEKEEPER_ALLOWANCE_POLICY} from '../strategy/rangekeeper/allowance-policy.js';

const ceil=(a:bigint,b:bigint)=>a===0n?0n:(a+b-1n)/b;
const min=(a:bigint,b:bigint)=>a<b?a:b;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v));
const sourceEq=(a:any,b:any)=>String(a?.block)===String(b?.block)&&String(a?.hash).toLowerCase()===String(b?.hash).toLowerCase()&&
 Number(a?.timestamp)===Number(b?.timestamp);

export interface RangeKeeperLiveManagementPlannerObservation extends RangeKeeperLiveManagementObservation {
 references:RangeKeeperLiveManagementObservation['references'];
}
export interface RangeKeeperLiveManagementPlannerInput {
 pool:Pool;client:RobinhoodClient;wallet:LiveWalletIdentity;rpcUrl:string;anvilBinary:string;buildId:string;
 observer:{observeForManagement(campaign:RangeKeeperLiveCampaign):Promise<RangeKeeperLiveManagementPlannerObservation>;
  observe(campaign:RangeKeeperLiveCampaign):Promise<RangeKeeperLiveManagementObservation>;
  verifyPinned(campaign:RangeKeeperLiveCampaign,payload:RangeKeeperLiveManagementReviewPayload):Promise<boolean>;
  observeHoldingCampaigns?:()=>Promise<unknown>;
  /** Re-anchor the persisted wallet snapshot to a fresh confirmed source (never while a transaction is unresolved). */
  refreshWallet?:()=>Promise<unknown>};
 queueReady:()=>Promise<boolean>;
 enqueue:(job:RangeKeeperLiveManagementQueueInput)=>Promise<{campaignId:string;jobId:string;allocationId?:string;replayed:boolean;status:string}>;
 /** Writes and queue admissions remain opt-in until runtime qualification. */
 enabled?:boolean;now?:()=>number;
 runFork?:typeof simulateRangeKeeperCandidate;
}

type ForkCost={status:'estimated';provenance:'owned_fork_allocated_lifecycle_v1';source:RangeKeeperLiveManagementObservation['source'];
 gasByStage:readonly {phase:'entry'|'exit';kind:string;gasUsed:string;estimatedGas:string;gasUnitsBound:string}[];
 maxFeePerGasWei:string;actionGasWei:string;completeExitGasWei:string;exitReserveWei:string;gasWei:string;
 gasValueUsdX18:string;actionCostValue:string;candidateHash:string;allocationHash:string;profileHash:string;limitsHash:string;
 campaignAllocationHash:string;sequenceHash:string;syntheticNativeFunding:true};

function costTotal(campaign:RangeKeeperLiveCampaign){
 const events=campaign.state?.costEvents??[];
 if(events.some(e=>e.gasValue===null||e.swapFeeValue===null||e.swapShortfallValue===null))return null;
 return events.reduce((sum,e)=>sum+e.gasValue!+e.swapFeeValue!+e.swapShortfallValue!,0n);
}
export function rangeKeeperLiveProvisionalActionCost(campaign:RangeKeeperLiveCampaign){
 const limits=campaign.config.limits,spent=costTotal(campaign);
 if(spent===null)return 0n;
 const used=spent+campaign.state!.reservedActionCost;
 const rolling=limits.maxRollingCost>used?limits.maxRollingCost-used:0n;
 const campaignRemaining=limits.maxCampaignCost>used?limits.maxCampaignCost-used:0n;
 return min(limits.maxActionCost,min(rolling,campaignRemaining));
}
export function buildRangeKeeperLivePlannerObservation(campaign:RangeKeeperLiveCampaign,
 observation:RangeKeeperLiveManagementPlannerObservation,limits:RangeKeeperLimits,
 cost:bigint|null,gasWei:bigint,liquiditySharePpm:number,requiredExitReserveWei=limits.exitReserveWei,
 flags:{continuity?:RangeKeeperObservation['continuity'];safeExitRequired?:boolean}={}):RangeKeeperObservation{
 const p=campaign.config.pool,source=observation.source,snapshot=observation.snapshot,
  position=observation.position as Record<string,unknown>|null;
 // A recenter whose NFT is already withdrawn holds loose inventory only: nothing is released by a position.
 assert(position===null?campaign.state!.activeTokenId===null:typeof position==='object','Campaign position valuation is unavailable');
 const raw=(key:string)=>{const v=position![key];assert(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v),`Management position ${key} is missing`);return BigInt(v);};
 const allocated0=campaign.allocation.liquidByTokenAddress[p.token0.toLowerCase()],allocated1=campaign.allocation.liquidByTokenAddress[p.token1.toLowerCase()];
 assert(allocated0!==undefined&&allocated1!==undefined,'Campaign token allocation is incomplete');
 const free0=min(snapshot.wallet0,allocated0),free1=min(snapshot.wallet1,allocated1);
 // The live allocation store reduces nativeSpendWei as receipts settle; only
 // cap once by its current remaining amount plus separately held exit reserve.
 const remainingNative=campaign.allocation.nativeSpendWei>campaign.allocation.pendingNativeSpendWei?
  campaign.allocation.nativeSpendWei-campaign.allocation.pendingNativeSpendWei:0n;
 const totalNative=remainingNative+campaign.allocation.exitReserveWei;
 const nativeWei=min(snapshot.nativeWei,totalNative);
 const spent=costTotal(campaign),priorCost=spent??limits.maxCampaignCost;
 const active=snapshot.position?.liquidity??0n,inside=!!snapshot.position&&snapshot.tick>=snapshot.position.tickLower&&snapshot.tick<snapshot.position.tickUpper;
 const poolAfter=snapshot.poolLiquidity-(inside?active:0n);assert(poolAfter>=0n,'Campaign position exceeds pool liquidity');
 const actionCost=cost??limits.maxActionCost;
 return {block:BigInt(source.block),hash:source.hash as `0x${string}`,timestamp:source.timestamp,tick:snapshot.tick,
  sqrtPriceX96:snapshot.sqrtPriceX96,continuity:flags.continuity??'canonical',wallet0:free0,wallet1:free1,
  released0:position?raw('principal0Raw')+raw('uncollected0Raw'):0n,released1:position?raw('principal1Raw')+raw('uncollected1Raw'):0n,nativeWei,requiredExitReserveWei,
  price0:observation.references.price0,price1:observation.references.price1,nativePrice:observation.references.nativePrice,
  position:snapshot.position&&snapshot.position.liquidity>0n?{tokenId:String(snapshot.position.tokenId),
   tickLower:snapshot.position.tickLower,tickUpper:snapshot.position.tickUpper,liquidity:snapshot.position.liquidity}:null,
  pending:false,entryAllowed:true,safeExitRequired:flags.safeExitRequired??false,executionReady:snapshot.unlocked,
  liquiditySharePpm,actionCost,actionGasWei:gasWei,reservedCost:campaign.state!.reservedActionCost,
  rollingSpentCost:priorCost,campaignSpentCost:priorCost,campaignStartValue:campaign.state!.initialStrategyValue,
  highWaterValue:campaign.state!.highWaterValue,recenters:campaign.state!.recenters};
}

export function buildRangeKeeperLiveManagementForkCost(input:{campaign:RangeKeeperLiveCampaign;observation:RangeKeeperLiveManagementPlannerObservation;
 candidate:RangeKeeperCandidate;report:Awaited<ReturnType<typeof simulateRangeKeeperCandidate>>;
 baseFee:bigint;marketGasPrice:bigint;
 /** A re-plan after a confirmed withdrawal rehearses no entry withdrawal: the position is already out. */
 replan?:boolean}):ForkCost{
 const {campaign,observation,candidate,report}=input;
 assert(sourceEq(report.source,observation.source),'Management fork source changed');
 assert(report.createdTokenId!==null&&report.createdTokenId>0n,'Management fork mint receipt is missing');
 assert(input.baseFee>0n&&input.marketGasPrice>0n&&observation.references.nativePrice>0n,'Management fee/reference unavailable');
 const gas=report.gasByStage;
 assert(gas.some(s=>s.phase==='entry'&&s.kind==='mint')&&(input.replan===true||gas.some(s=>s.phase==='entry'&&s.kind==='withdraw'))&&
  gas.some(s=>s.phase==='exit'&&s.kind==='withdraw'),'Owned management fork did not prove recenter and complete exit');
 assert(gas.length>0&&gas.length<=32&&gas.every(s=>s.gasUsed>0n&&s.gasUsed<=8_000_000n&&
  typeof (s as any).estimatedGas==='bigint'&&(s as any).estimatedGas>0n&&
  ['entry','exit'].includes(s.phase)&&['approve','swap','mint','withdraw'].includes(s.kind)), 'Management stage gas evidence is malformed');
 const maxFee=ceil((input.baseFee>input.marketGasPrice?input.baseFee:input.marketGasPrice)*5n,4n);
 const gasByStage=gas.map(s=>{const estimated=(s as any).estimatedGas as bigint,basis=s.gasUsed>estimated?s.gasUsed:estimated;
  return {phase:s.phase,kind:s.kind,gasUsed:String(s.gasUsed),estimatedGas:String(estimated),gasUnitsBound:String(ceil(basis*13n,10n))};});
 const units=(phase:'entry'|'exit')=>gasByStage.filter(s=>s.phase===phase).reduce((sum,s)=>sum+BigInt(s.gasUnitsBound),0n);
 const actionGasWei=units('entry')*maxFee,completeExitGasWei=units('exit')*maxFee;
 const exitReserve=completeExitGasWei>campaign.config.limits.exitReserveWei?completeExitGasWei:campaign.config.limits.exitReserveWei;
 const swap=candidate.swap,actionCost=ceil(actionGasWei*observation.references.nativePrice,10n**18n)+
  (swap?swap.feeValue+swap.shortfallValue:0n);
 assert(actionGasWei>0n&&completeExitGasWei>0n&&actionCost>0n,'Management action cost proof is empty');
 const allocation={amount0:String(min(observation.snapshot.wallet0,campaign.allocation.liquidByTokenAddress[campaign.config.pool.token0.toLowerCase()]!)),
  amount1:String(min(observation.snapshot.wallet1,campaign.allocation.liquidByTokenAddress[campaign.config.pool.token1.toLowerCase()]!)),
  activeTokenId:String(campaign.state!.activeTokenId)};
 const binding={source:observation.source,profileHash:campaign.profileHash,allocationHash:campaign.allocation.allocationHash,
  limitsHash:contentHash(json(campaign.config.limits)),candidateHash:contentHash(json(candidate)),gasByStage,
  maxFeePerGasWei:String(maxFee),actionGasWei:String(actionGasWei),completeExitGasWei:String(completeExitGasWei),
  exitReserveWei:String(exitReserve),createdTokenId:String(report.createdTokenId),allocation};
 return {status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source:observation.source,gasByStage,
  maxFeePerGasWei:String(maxFee),actionGasWei:String(actionGasWei),completeExitGasWei:String(completeExitGasWei),
  exitReserveWei:String(exitReserve),gasWei:String(actionGasWei),gasValueUsdX18:String(ceil(actionGasWei*observation.references.nativePrice,10n**18n)),
  actionCostValue:String(actionCost),candidateHash:contentHash(json(candidate)),allocationHash:contentHash(json({amount0:allocation.amount0,
   amount1:allocation.amount1})),campaignAllocationHash:campaign.allocation.allocationHash,
  profileHash:campaign.profileHash,limitsHash:contentHash(json(campaign.config.limits)),sequenceHash:contentHash(binding),syntheticNativeFunding:true};
}

/** One wallet-idle, source-pinned planner for the existing campaign/queue.
 * It persists only policy observations until a fully simulated recenter can
 * be frozen and admitted. No signer or publisher is exposed here. */
export function createRangeKeeperLiveManagementPlanner(input:RangeKeeperLiveManagementPlannerInput){
 const now=input.now??Date.now;
 const verifySource=async(source:RangeKeeperSource)=>{
  const tip=await input.client.getBlock(),header=await input.client.getBlock({blockNumber:source.block});
  assert(tip.number>=source.block+64n&&header.hash&&header.hash.toLowerCase()===source.hash.toLowerCase()&&
   Number(header.timestamp)===source.timestamp,'Management source is no longer canonical and confirmed');
 };
 const hashObservation=(decision:RangeKeeperDecision,observation:RangeKeeperLiveManagementPlannerObservation)=>
  contentHash(json({source:observation.source,snapshot:observation.snapshot,
   references:{proofHash:observation.references.proofHash,price0:String(observation.references.price0),
    price1:String(observation.references.price1),nativePrice:String(observation.references.nativePrice)},
   decision:decision.action,reason:decision.reason,candidate:decision.candidate}));
 /** One runtime-event CAS under the wallet lock, for a state change made by the manager outside any stage receipt. */
 const applyManagerState=async(campaign:RangeKeeperLiveCampaign,state:RangeKeeperLiveCampaign['state'],
  source:RangeKeeperLiveManagementPlannerObservation['source'],effectId:string,payload:unknown)=>{
  assert(campaign.stateHash&&state,'Management campaign state is unavailable');
  await withLiveWalletTransaction(input.pool,input.wallet,async db=>{
   const current=await readRangeKeeperLiveCampaign(db,{...input.wallet,campaignId:campaign.id,revision:campaign.revision});
   assert.equal(current.stateHash,campaign.stateHash,'Campaign changed during manager state transition');
   const lane=await readLiveWalletLane(db,input.wallet,campaign.id);
   assert(!lane.inflight&&!lane.unresolved,'Shared wallet queue became busy during manager state transition');
   await appendRangeKeeperLiveCampaignEventInTransaction(db,{...input.wallet,campaignId:campaign.id,revision:campaign.revision,
    effectId,kind:'mark',expectedStateHash:campaign.stateHash,state,source,payload});
  });
 };
 const persistObservation=async(campaign:RangeKeeperLiveCampaign,decision:RangeKeeperDecision,
  observation:RangeKeeperLiveManagementPlannerObservation,allowOwnJob=false)=>{
  assert(campaign.state&&campaign.stateHash,'Management campaign state is unavailable');
  const next=structuredClone(campaign.state);next.policy=decision.state;next.lastReason=decision.reason;
  // A recenter in progress is never valuation-marked, so its recorded snapshot would otherwise age forever and every later
  // observation would look discontinuous (source_gap), blocking both the re-plan and the safety-exit conversion. Each
  // persisted observation therefore re-anchors the campaign snapshot, exactly as the valuation mark does for a holding one.
  if(campaign.state.phase==='recenter')next.last=structuredClone(observation.snapshot);
  const observationHash=hashObservation(decision,observation);
  if(decision.reason==='duplicate_or_backward_observation')return observationHash;
  if(contentHash(json(next))===contentHash(json(campaign.state)))return observationHash;
  await withLiveWalletTransaction(input.pool,input.wallet,async db=>{
   const current=await readRangeKeeperLiveCampaign(db,{...input.wallet,campaignId:campaign.id,revision:campaign.revision});
   assert.equal(current.stateHash,campaign.stateHash,'Campaign changed during automatic planner observation');
   // Sibling queued or blocked work does not stop a policy observation; only an in-flight job, an unresolved
   // transaction, or pending work of this very campaign (whose frozen review binds its state hash) does.
   const lane=await readLiveWalletLane(db,input.wallet,campaign.id);
   assert(!lane.inflight&&!lane.unresolved&&(allowOwnJob||!lane.campaignWork),'Shared wallet queue became busy during management observation');
   await appendRangeKeeperLiveCampaignEventInTransaction(db,{...input.wallet,campaignId:campaign.id,revision:campaign.revision,
    effectId:contentHash({kind:'rangekeeper_live_management_observation_v1',campaignId:campaign.id,
     revision:campaign.revision,source:observation.source,observationHash}),kind:'mark',expectedStateHash:campaign.stateHash,
    state:next,source:observation.source,payload:{schemaVersion:1,kind:'rangekeeper_live_management_observation_v1',
     decision:decision.action,reason:decision.reason,observationHash,referenceProofHash:observation.references.proofHash}});
  });
  return observationHash;
 };
 const planCampaign=async(campaignId:string)=>{
  if(input.enabled!==true)return {status:'disabled' as const,reason:'automatic_management_disabled',queued:false as const};
  const campaign=await readRangeKeeperLiveCampaign(input.pool,{...input.wallet,campaignId});
  const state0=campaign.state;
  // A holding campaign is evaluated for a discretionary recenter or a safety exit. A recenter already in progress
  // (its job queued or blocked) is only evaluated for a safety exit, except after a confirmed withdrawal whose
  // candidate went stale: that one is re-planned from fresh observations without repeating the withdrawal.
  const awaitingReplan=isRangeKeeperAwaitingReplan(state0),inFlightRecenter=state0?.phase==='recenter'&&!awaitingReplan;
  assert(campaign.status==='active'&&campaign.state&&state0&&(state0.phase==='holding'&&state0.activeTokenId!==null||
   state0.phase==='recenter'&&state0.desired==='running'),'Automatic management requires an active holding or recentering campaign');
  if(state0.phase==='recenter'){
   const persisted=await readWalletState(input.pool,input.wallet);
   if(!persisted.source||Math.floor(now()/1000)-persisted.source.timestamp>45)await input.observer.refreshWallet?.();
  }
  const observation=await input.observer.observeForManagement(campaign),profile=marketProfileSchema.parse(campaign.profile);
  assert(sourceEq(observation.source,observation.snapshot.source)&&sourceEq(observation.source,observation.references.source),
   'Management observation source bindings disagree');
  if(state0.activeTokenId!==null)assert(observation.snapshot.position&&observation.snapshot.position.tokenId===state0.activeTokenId&&
   observation.snapshot.position.liquidity>0n,'Campaign active NFT is missing from canonical observation');
  else assert(observation.snapshot.position===null||observation.snapshot.position.liquidity===0n,'Withdrawn campaign NFT still holds liquidity');
  const source:RangeKeeperSource={block:BigInt(observation.source.block),hash:observation.source.hash as `0x${string}`,
   timestamp:observation.source.timestamp};await verifySource(source);
  if(source.block<campaign.state.last.source.block||source.timestamp<campaign.state.last.source.timestamp||
   source.block===campaign.state.last.source.block&&source.hash.toLowerCase()!==campaign.state.last.source.hash.toLowerCase())
   return {status:'unavailable',reason:'management_source_precedes_or_conflicts_with_campaign_state',queued:false as const};
  const chain=new RangeKeeperChain(input.client,profile.pool,campaign.config.zeroAllowances);
  const priorEligible=campaign.state.policy.lastEligible;
  const priorAnchor=priorEligible??{block:campaign.state.last.source.block,hash:campaign.state.last.source.hash,
   timestamp:campaign.state.last.source.timestamp};
  let continuity:RangeKeeperObservation['continuity']='canonical';
  const anchors=[campaign.state.last.source,priorAnchor,...(campaign.state.policy.confirmation?[{block:campaign.state.policy.confirmation.firstBlock,
   hash:campaign.state.policy.confirmation.firstHash,timestamp:campaign.state.policy.confirmation.firstAt}]:[])];
  if(anchors.some(anchor=>source.block>anchor.block&&source.timestamp<=anchor.timestamp))continuity='reorg';
  if(anchors.some(anchor=>source.block>anchor.block&&source.timestamp-anchor.timestamp>campaign.config.limits.maxObservationGapSeconds))
   continuity='gap';
  for(const anchor of anchors){
   try{const block=await input.client.getBlock({blockNumber:anchor.block});
    if(!block.hash||block.hash.toLowerCase()!==anchor.hash.toLowerCase())continuity='reorg';
   }catch{continuity='reorg';}
  }
  const maxActions=campaign.config.campaignScope.maxEconomicActions;
  // Exhausted cost budgets end discretionary management too: nothing further may be spent except the exit itself.
  const safeExitRequired=campaign.state.desired==='stopped'||!observation.snapshot.unlocked||source.timestamp>=campaign.state.expiresAt||
   (maxActions>0&&campaign.state.economicActions>=maxActions)||(!inFlightRecenter&&rangeKeeperLiveCostBudgetExhausted(campaign));
  // A re-plan can only spend what remains of the recenter's own per-action budget.
  const planLimits=awaitingReplan?{...campaign.config.limits,maxActionCost:rangeKeeperLiveRemainingActionBudget(campaign)}:campaign.config.limits;
  const provisionalCost=()=>{const c=rangeKeeperLiveProvisionalActionCost(campaign);return awaitingReplan&&c>planLimits.maxActionCost?planLimits.maxActionCost:c;};
  const costsByCandidate=new Map<string,ForkCost>();
  const runFork= input.runFork??simulateRangeKeeperCandidate;
  const executeFork=async(candidate:RangeKeeperCandidate)=>{
   const candidateHash=contentHash(json(candidate));if(costsByCandidate.has(candidateHash))return true;
   try{
    const [block,marketGasPrice]=await Promise.all([input.client.getBlock({blockNumber:source.block}),input.client.getGasPrice()]);
    assert(block.baseFeePerGas&&block.baseFeePerGas>0n&&marketGasPrice>0n,'Management gas price unavailable');
    const report=await runFork({rpcUrl:input.rpcUrl,anvilBinary:input.anvilBinary,source,pool:profile.pool,
     limits:campaign.config.limits,operator:campaign.wallet,candidate,activeTokenId:campaign.state!.activeTokenId,
     prices:{price0:observation.references.price0,price1:observation.references.price1},
     allocation:{amount0:min(observation.snapshot.wallet0,campaign.allocation.liquidByTokenAddress[profile.pool.token0.toLowerCase()]!),
      amount1:min(observation.snapshot.wallet1,campaign.allocation.liquidByTokenAddress[profile.pool.token1.toLowerCase()]!)},
     rehearseExit:{maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm},allowancePolicy:RANGEKEEPER_ALLOWANCE_POLICY});
    costsByCandidate.set(candidateHash,buildRangeKeeperLiveManagementForkCost({campaign,observation,candidate,report,
     baseFee:block.baseFeePerGas,marketGasPrice,replan:awaitingReplan}));
    await verifySource(source);return true;
   }catch{return false;}
  };
  const observationForPlan={...buildRangeKeeperLivePlannerObservation(campaign,observation,planLimits,
   provisionalCost(),0n,0,campaign.config.limits.exitReserveWei,{continuity,safeExitRequired}),
   // Only safety conditions are evaluated for a recenter whose own stages are still in progress.
   ...(inFlightRecenter?{entryAllowed:false}:{})};
  const plannerInput={state:campaign.state.policy,observation:observationForPlan,limits:planLimits,
   spacing:profile.pool.tickSpacing,decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1,
   quoteToken:profile.pool.quoteToken,maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,
   quote:(token:0|1,amount:bigint)=>chain.quote(source,token,amount,observation.references.price0,observation.references.price1),
   simulate:executeFork};
  let decision=await planRangeKeeper(plannerInput);
  if(decision.action==='execute'&&decision.candidate){
   const forkCost=costsByCandidate.get(contentHash(json(decision.candidate)));
   assert(forkCost,'Planner execute is missing its owned-fork proof');
   const candidate=decision.candidate,active=observation.snapshot.position;
   const poolAfter=observation.snapshot.poolLiquidity-(active&&active.liquidity>0n&&observation.snapshot.tick>=active.tickLower&&
    observation.snapshot.tick<active.tickUpper?active.liquidity:0n);
   assert(poolAfter>=0n,'Active NFT liquidity exceeds canonical pool liquidity');
   const share=Number(candidate.liquidity*1_000_000n/(poolAfter+candidate.liquidity));
   const checkedObservation=buildRangeKeeperLivePlannerObservation(campaign,observation,planLimits,
    BigInt(forkCost.actionCostValue),BigInt(forkCost.actionGasWei),share,BigInt(forkCost.exitReserveWei),
    {continuity,safeExitRequired});
   decision=await planRangeKeeper({...plannerInput,observation:checkedObservation});
   assert(decision.action==='execute'&&decision.candidate&&contentHash(json(decision.candidate))===forkCost.candidateHash,
    `Measured recenter no longer qualifies: ${decision.reason}`);
  }
  const finalCost=decision.candidate?costsByCandidate.get(contentHash(json(decision.candidate))):undefined;
  if(state0.phase==='recenter'){
   const observationHash=hashObservation(decision,observation);
   if(decision.action==='safety_exit'){
    // Exits outrank the recenter already in progress: its job continues as a retained exit from the state it is in
    // (the withdrawal, retired NFT and any completed swap stay recorded; nothing is repeated, converted or approved).
    const converted=convertRangeKeeperRecenterToRetainExit(campaign.state!,decision.reason,observation.snapshot);
    await applyManagerState(campaign,converted,observation.source,contentHash({kind:'rangekeeper_live_management_exit_conversion_v1',
     campaignId:campaign.id,revision:campaign.revision,previousStateHash:campaign.stateHash}),
     {schemaVersion:1,kind:'rangekeeper_live_management_exit_conversion_v1',reason:decision.reason,observationHash,
      referenceProofHash:observation.references.proofHash});
    return {status:'safety_exit',reason:'recenter_converted_to_retain_exit',observationHash,source:observation.source,queued:false as const,
     converted:true as const};
   }
   if(!awaitingReplan){
    // A blocked in-flight recenter stays evaluable for a safety exit: a discontinuity resets policy and re-anchors the snapshot.
    if(decision.reason.startsWith('source_'))await persistObservation(campaign,decision,observation,true);
    return {status:'wait',reason:'recenter_in_progress',observationHash,source:observation.source,queued:false as const};
   }
   if(decision.action!=='execute'||!decision.candidate||!finalCost){
    await persistObservation(campaign,decision,observation,true);
    return {status:decision.action,reason:decision.reason,observationHash,source:observation.source,queued:false as const};
   }
   const next=deriveRangeKeeperLiveReplanTransition(campaign,{source:observation.source,snapshot:observation.snapshot,
    candidate:decision.candidate,policy:decision.state,costs:finalCost});
   await applyManagerState(campaign,next,observation.source,contentHash({kind:'rangekeeper_live_management_replan_v1',
    campaignId:campaign.id,revision:campaign.revision,previousStateHash:campaign.stateHash,observationHash}),
    {schemaVersion:1,kind:'rangekeeper_live_management_replan_v1',reason:decision.reason,observationHash,
     candidate:decision.candidate,costs:finalCost,referenceProofHash:observation.references.proofHash});
   return {status:'replanned',reason:'stale_recenter_replanned',observationHash,source:observation.source,queued:false as const};
  }
  const observationHash=await persistObservation(campaign,decision,observation);
  if(decision.action==='safety_exit'){
   if(!await input.queueReady())return {status:'deferred',reason:'wallet_queue_busy',observationHash,
    source:observation.source,queued:false as const};
   const current=await readRangeKeeperLiveCampaign(input.pool,{...input.wallet,campaignId,revision:campaign.revision});
   const close=await input.observer.observe(current);
   const review=await recordRangeKeeperLiveManagementReview(input.pool,{wallet:input.wallet,campaign:current,
    operationKind:'close_retain',source:close.source,snapshot:close.snapshot,references:close.references,
    position:close.position,decision:{reason:decision.reason,observationHash},candidate:null,policy:null,
    costs:close.costs,missing:close.missing,expiresAt:close.expiresAt},
    {buildId:input.buildId,verifyPinned:input.observer.verifyPinned,now});
   if(review.status!=='indicative'||!review.previewId||!review.contentDigest)
    return {status:'unavailable',reason:review.missing.join(','),observationHash,source:close.source,queued:false as const};
   const admitted=await enqueueRangeKeeperLiveManagementReview({wallet:input.wallet,campaignId,
    previewId:review.previewId,contentDigest:review.contentDigest,expectedRevision:current.revision,
    idempotencyKey:`rk-auto-retain:${campaignId}:${current.revision}:${observationHash.slice(0,32)}`,
    expectedOperationKind:'close_retain'},{pool:input.pool,buildId:input.buildId,
     verifyPinned:input.observer.verifyPinned,enqueue:input.enqueue,now});
   return {status:admitted.status,reason:admitted.status==='queued'?'safety_retain_queued':admitted.missing.join(','),
    observationHash,source:close.source,queued:admitted.status==='queued',jobId:admitted.status==='queued'?admitted.jobId:null};
  }
  if(decision.action!=='execute'||!decision.candidate||!finalCost)return {status:decision.action,reason:decision.reason,
   observationHash,source:observation.source,queued:false as const};
  if(input.enabled!==true)return {status:'indicative',reason:'automatic_management_disabled',observationHash,
   source:observation.source,queued:false as const};
  if(!await input.queueReady())return {status:'deferred',reason:'wallet_queue_busy',observationHash,source:observation.source,queued:false as const};
  const refreshed=await readRangeKeeperLiveCampaign(input.pool,{...input.wallet,campaignId,revision:campaign.revision});
  const review=await recordRangeKeeperLiveManagementReview(input.pool,{wallet:input.wallet,campaign:refreshed,
   operationKind:'change_range',source:observation.source,snapshot:observation.snapshot,references:observation.references,
   position:observation.position,decision:{reason:decision.reason,observationHash},candidate:decision.candidate,
   policy:decision.state,costs:finalCost,expiresAt:Math.min(observation.expiresAt,decision.candidate.expiresAt)},
   {buildId:input.buildId,verifyPinned:input.observer.verifyPinned,now});
  if(review.status!=='indicative'||!review.previewId||!review.contentDigest)
   return {status:'unavailable',reason:review.missing.join(','),observationHash,source:observation.source,queued:false as const};
  const admitted=await enqueueRangeKeeperLiveManagementReview({wallet:input.wallet,campaignId,
   previewId:review.previewId,contentDigest:review.contentDigest,expectedRevision:refreshed.revision,
   idempotencyKey:`rk-auto-recenter:${campaignId}:${refreshed.revision}:${observationHash.slice(0,32)}`,
   expectedOperationKind:'change_range'},{pool:input.pool,buildId:input.buildId,verifyPinned:input.observer.verifyPinned,
    enqueue:input.enqueue,now});
  return {status:admitted.status,reason:admitted.status==='queued'?'automatic_recenter_queued':admitted.missing.join(','),
   observationHash,source:observation.source,queued:admitted.status==='queued',jobId:admitted.status==='queued'?admitted.jobId:null};
 };
 const observeAndEnqueueManagement=async()=>{
  if(input.enabled!==true||!await input.queueReady())return {status:'disabled' as const,processed:0};
  const rows=(await input.pool.query<{id:string}>(`SELECT c.id FROM deployment_campaigns c
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   JOIN deployment_live_campaign_runtime m ON m.campaign_id=c.id AND m.revision=r.revision
   WHERE c.chain_id=$1 AND lower(c.wallet)=$2 AND c.mode='live' AND c.lifecycle='active'
    AND r.strategy_id='rangekeeper_v1' AND m.status='active' AND m.state_json->>'phase' IN('holding','recenter')
   ORDER BY m.updated_at,c.id LIMIT 101`,[input.wallet.chainId,input.wallet.address.toLowerCase()])).rows;
  assert(rows.length<=100,'Holding management campaign scan exceeded its bound');
  let processed=0;const results=[] as unknown[];
  // Every active campaign of the wallet is evaluated each pass, least recently updated first; a campaign whose own
  // job is pending, or that fails to observe, never delays a sibling's evaluation or exit.
  for(const row of rows){if(!await input.queueReady())break;
   try{
    const lane=await readLiveWalletLane(input.pool,input.wallet,row.id);
    const phase=(await input.pool.query<{phase:string}>(`SELECT state_json->>'phase' AS phase FROM deployment_live_campaign_runtime WHERE campaign_id=$1`,[row.id])).rows[0]?.phase;
    // A holding campaign with its own queued or blocked job is bound to that job's frozen review; a recenter in
    // progress is by definition evaluated while its job waits.
    if(lane.campaignWork&&phase==='holding'){results.push({campaignId:row.id,status:'wait',reason:'campaign_job_pending'});continue;}
    results.push(await planCampaign(row.id));processed++;
   }catch(error){results.push({campaignId:row.id,status:'unavailable',
    reason:error instanceof Error?error.message:'management_planner_unavailable'});}}
  // Policy CAS updates the runtime state hash. Record the matching dashboard
  // valuation afterwards, and only while the manager did not enqueue work.
  const valuations=await input.queueReady()?await input.observer.observeHoldingCampaigns?.():{status:'deferred',reason:'wallet_queue_busy'};
  return {status:'observed' as const,processed,valuations,results};
 };
 return {planCampaign,observeAndEnqueueManagement};
}
