import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {contentHash} from './contracts.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import {withLiveWalletTransaction} from './live-wallet-store.js';
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
  observeHoldingCampaigns?:()=>Promise<unknown>};
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
 assert(position&&typeof position==='object','Campaign position valuation is unavailable');
 const raw=(key:string)=>{const v=position[key];assert(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v),`Management position ${key} is missing`);return BigInt(v);};
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
  released0:raw('principal0Raw')+raw('uncollected0Raw'),released1:raw('principal1Raw')+raw('uncollected1Raw'),nativeWei,requiredExitReserveWei,
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
 baseFee:bigint;marketGasPrice:bigint}):ForkCost{
 const {campaign,observation,candidate,report}=input;
 assert(sourceEq(report.source,observation.source),'Management fork source changed');
 assert(report.createdTokenId!==null&&report.createdTokenId>0n,'Management fork mint receipt is missing');
 assert(input.baseFee>0n&&input.marketGasPrice>0n&&observation.references.nativePrice>0n,'Management fee/reference unavailable');
 const gas=report.gasByStage;
 assert(gas.some(s=>s.phase==='entry'&&s.kind==='mint')&&gas.some(s=>s.phase==='entry'&&s.kind==='withdraw')&&
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
 const persistObservation=async(campaign:RangeKeeperLiveCampaign,decision:RangeKeeperDecision,
  observation:RangeKeeperLiveManagementPlannerObservation)=>{
  assert(campaign.state&&campaign.stateHash,'Management campaign state is unavailable');
  const next=structuredClone(campaign.state);next.policy=decision.state;next.lastReason=decision.reason;
  const observationHash=contentHash(json({source:observation.source,snapshot:observation.snapshot,
   references:{proofHash:observation.references.proofHash,price0:String(observation.references.price0),
    price1:String(observation.references.price1),nativePrice:String(observation.references.nativePrice)},
   decision:decision.action,reason:decision.reason,candidate:decision.candidate}));
  if(decision.reason==='duplicate_or_backward_observation')return observationHash;
  if(contentHash(json(next))===contentHash(json(campaign.state)))return observationHash;
  await withLiveWalletTransaction(input.pool,input.wallet,async db=>{
   const current=await readRangeKeeperLiveCampaign(db,{...input.wallet,campaignId:campaign.id,revision:campaign.revision});
   assert.equal(current.stateHash,campaign.stateHash,'Campaign changed during automatic planner observation');
   const idle=(await db.query<{ready:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2
    AND status IN('queued','preflighting','executing','confirming','reconciling','blocked')) AND
    NOT EXISTS(SELECT 1 FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2 AND lease_until>clock_timestamp()) AND
    NOT EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE chain_id=$1 AND wallet=$2 AND
     (status IN('prepared','signed','blocked') OR (signed_raw IS NOT NULL AND canonical_receipt_json IS NULL))) AS ready`,
    [input.wallet.chainId,input.wallet.address.toLowerCase()])).rows[0]?.ready;
   assert(idle===true,'Shared wallet queue became busy during management observation');
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
  assert(campaign.status==='active'&&campaign.state?.phase==='holding'&&campaign.state.activeTokenId!==null,
   'Automatic recenter requires an active holding campaign');
  const observation=await input.observer.observeForManagement(campaign),profile=marketProfileSchema.parse(campaign.profile);
  assert(sourceEq(observation.source,observation.snapshot.source)&&sourceEq(observation.source,observation.references.source),
   'Management observation source bindings disagree');
  assert(observation.snapshot.position&&observation.snapshot.position.tokenId===campaign.state.activeTokenId&&
   observation.snapshot.position.liquidity>0n,'Campaign active NFT is missing from canonical observation');
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
  const safeExitRequired=campaign.state.desired==='stopped'||!observation.snapshot.unlocked||source.timestamp>=campaign.state.expiresAt||
   (maxActions>0&&campaign.state.economicActions>=maxActions);
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
     rehearseExit:{maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm}});
    costsByCandidate.set(candidateHash,buildRangeKeeperLiveManagementForkCost({campaign,observation,candidate,report,
     baseFee:block.baseFeePerGas,marketGasPrice}));
    await verifySource(source);return true;
   }catch{return false;}
  };
  const observationForPlan=buildRangeKeeperLivePlannerObservation(campaign,observation,campaign.config.limits,
   rangeKeeperLiveProvisionalActionCost(campaign),0n,0,campaign.config.limits.exitReserveWei,{continuity,safeExitRequired});
  const plannerInput={state:campaign.state.policy,observation:observationForPlan,limits:campaign.config.limits,
   spacing:profile.pool.tickSpacing,decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1,
   quoteToken:profile.pool.quoteToken,maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,
   quote:(token:0|1,amount:bigint)=>chain.quote(source,token,amount,observation.references.price0,observation.references.price1),
   simulate:executeFork};
  let decision=await planRangeKeeper(plannerInput);
  if(decision.action==='execute'&&decision.candidate){
   const forkCost=costsByCandidate.get(contentHash(json(decision.candidate)));
   assert(forkCost,'Planner execute is missing its owned-fork proof');
   const candidate=decision.candidate,active=observation.snapshot.position!;
   const poolAfter=observation.snapshot.poolLiquidity-(observation.snapshot.tick>=active.tickLower&&
    observation.snapshot.tick<active.tickUpper?active.liquidity:0n);
   assert(poolAfter>=0n,'Active NFT liquidity exceeds canonical pool liquidity');
   const share=Number(candidate.liquidity*1_000_000n/(poolAfter+candidate.liquidity));
   const checkedObservation=buildRangeKeeperLivePlannerObservation(campaign,observation,campaign.config.limits,
    BigInt(forkCost.actionCostValue),BigInt(forkCost.actionGasWei),share,BigInt(forkCost.exitReserveWei),
    {continuity,safeExitRequired});
   decision=await planRangeKeeper({...plannerInput,observation:checkedObservation});
   assert(decision.action==='execute'&&decision.candidate&&contentHash(json(decision.candidate))===forkCost.candidateHash,
    `Measured recenter no longer qualifies: ${decision.reason}`);
  }
  const finalCost=decision.candidate?costsByCandidate.get(contentHash(json(decision.candidate))):undefined;
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
    AND r.strategy_id='rangekeeper_v1' AND m.status='active' AND m.state_json->>'phase'='holding'
   ORDER BY c.id LIMIT 101`,[input.wallet.chainId,input.wallet.address.toLowerCase()])).rows;
  assert(rows.length<=100,'Holding management campaign scan exceeded its bound');
  let processed=0;const results=[] as unknown[];
  for(const row of rows){if(!await input.queueReady())break;
   try{results.push(await planCampaign(row.id));processed++;}catch(error){results.push({campaignId:row.id,status:'unavailable',
    reason:error instanceof Error?error.message:'management_planner_unavailable'});}}
  // Policy CAS updates the runtime state hash. Record the matching dashboard
  // valuation afterwards, and only while the manager did not enqueue work.
  const valuations=await input.queueReady()?await input.observer.observeHoldingCampaigns?.():{status:'deferred',reason:'wallet_queue_busy'};
  return {status:'observed' as const,processed,valuations,results};
 };
 return {planCampaign,observeAndEnqueueManagement};
}
