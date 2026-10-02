import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {principalAmounts,Q96} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {buildRangeKeeperPaperRecenterPlan,rangeKeeperPaperNextObservationAt} from
 '../src/deployments/rangekeeper-paper-recenter-model.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperOpenModel} from
 '../src/deployments/rangekeeper-paper-open-model.js';
import {rangeKeeperPaperCandidateHash} from '../src/deployments/rangekeeper-paper-cost.js';
import {replayPaperMint} from '../src/v3/position-math.js';

const address=(n:string)=>`0x${n.repeat(40)}`;
const hash=(n:string)=>`0x${n.repeat(64)}`;

function fixture(){
 const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:address('1'),pool:address('2'),
  token0:address('3'),token1:address('4'),quoteToken:1,decimals0:18,decimals1:18,fee:3000,
  tickSpacing:60,positionManager:address('5'),router:address('6'),quoter:address('7'),
  poolCodeHash:hash('a'),token0CodeHash:hash('b'),token1CodeHash:hash('c'),
  managerCodeHash:hash('d'),quoterCodeHash:hash('e'),reference0:'A/USD',reference1:'B/USD',
  nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
  token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
  token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}}),profileHash=contentHash(profile),
  parameters={fullWidthSpacings:2,limits:{maxDeploymentValue:'100000000000000000000',
   minDeploymentValue:'1',minDeploymentPpm:1,maxSwapInputValue:'10000000000000000000',
   maxSwapInputPpm:1000000,maxSwapShortfallValue:'1000000000000000000',maxSlippageBps:50,
   maxActionCost:'10000000000000000000',maxRollingCost:'10000000000000000000',
   maxCampaignCost:'10000000000000000000',maxExposurePpm:1000000,maxLossValue:'10000000000000000000',
   maxDrawdownPpm:1000000,maxRecenters:2,maxLiquiditySharePpm:100000,
   maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'}},
  configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
  draft={id:randomUUID(),revision:1,allocation:{token0Raw:'1000000000000000000',
   token1Raw:'1000000000000000000',nativeWei:'10000000000000000'},profile,profileHash,configHash,
   strategyId:'rangekeeper_v1' as const,parameters},buildId='f'.repeat(64),
  policy=resolveRangeKeeperPaperPolicy(draft,buildId).policy!;
 const source0={block:'100',hash:hash('1'),timestamp:100},source1={block:'101',hash:hash('2'),timestamp:130},
  proof={fixture:'rangekeeper-recenter-model',registry:{fetchedAt:new Date(130_000).toISOString(),
   sha256:`sha256:${'b'.repeat(64)}`,url:'https://fixture.test/registry'},
   feedDirectory:{fetchedAt:new Date(130_000).toISOString(),sha256:`sha256:${'c'.repeat(64)}`,
    url:'https://fixture.test/feeds'}},proofHash=referenceProofHash(proof),
  frame={source:source1,tick:0,sqrtPriceX96:Q96,poolLiquidity:10n**24n,
   price0:10n**18n,price1:10n**18n,nativePrice:10n**18n,referenceEligible:true,
   referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof},range={tickLower:-60,tickUpper:60},
  desired=10n**18n,mint=replayPaperMint(Q96,range,desired,desired,0n),
  candidate={kind:'entry' as const,range,swap:null,amount0Desired:desired,amount1Desired:desired,
   amount0Min:0n,amount1Min:0n,liquidity:mint.liquidity,deployedValue:2n*10n**18n,
   sourceBlock:100n,sourceHash:source0.hash as `0x${string}`,expiresAt:190},
  persistedCandidate={kind:'entry',range,swap:null,amount0Desired:String(desired),
   amount1Desired:String(desired),amount0Min:'0',amount1Min:'0',liquidity:String(mint.liquidity),
   deployedValue:String(2n*desired),sourceBlock:'100',sourceHash:source0.hash,expiresAt:190},
  candidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
   profileHash,configHash,source:source0,referenceProofHash:proofHash,candidate}),
  principal=principalAmounts({liquidity:candidate.liquidity,...range,sqrtPriceX96:Q96}),
  kernel={source:source0,state:{schemaVersion:1 as const,policyId:'rangekeeper_v1' as const,
   strategyVersion:'1.0.0' as const,configHash:`0x${policy.policyHash}` as `0x${string}`,buildId,
   lastEligible:{block:'100',hash:source0.hash,timestamp:100},confirmation:null,exit:null},
   wallet0:'0',wallet1:'0',released0:String(principal.amount0),released1:String(principal.amount1),
   nativeWei:'10000000000000000',campaignStartValue:String(2n*desired),highWaterValue:String(2n*desired),
   rollingSpentCost:'0',campaignSpentCost:'0',reservedCost:'0',recenters:0,pending:false,
   entryAllowed:false,safeExitRequired:false,executionReady:false},
  inventory={position:{tickLower:range.tickLower,tickUpper:range.tickUpper,liquidity:String(candidate.liquidity)},
   idle:{token0:'0',token1:'0'}},
  openModel={kind:'rangekeeper_paper_open_model',status:'indicative',campaignId:draft.id,revision:1,
   kernelPolicyHash:policy.policyHash,kernelBuildId:buildId,candidateHash,candidate,
   source:source0,reference:{proofHash}} as unknown as RangeKeeperPaperOpenModel,
  previousMark={id:'9',markHash:'a'.repeat(64),source:source0,epoch:0,
   classification:'rangekeeper_paper_mark_v1' as const,candidate:persistedCandidate,candidateHash,inventory,
   kernelSnapshot:kernel,provenance:{candidateHash,candidateReferenceProofHash:proofHash,
    poolState:{tick:0,sqrtPriceX96:String(Q96),poolLiquidity:'1000000000000000000000000'}}};
 return {draft,buildId,source0,frame,snapshot:{draft,runtimeIdentity:{buildId},currentEpoch:0,pending:false,
  openMark:{id:'8',markHash:'b'.repeat(64),source:source0,inventory,model:openModel,epoch:0 as const},
  previousMark},kernel};
}

test('recenter planner projects principal from current frame while preserving opening campaign baseline',async()=>{
 const f=fixture(),plan=await buildRangeKeeperPaperRecenterPlan({snapshot:f.snapshot,frame:f.frame,
  buildId:f.buildId,actionCost:1n,actionGasWei:1n,requiredExitReserveWei:1n,
  quote:async()=>{throw Error('inside-range plan must not quote');},
  simulate:async()=>{throw Error('inside-range plan must not simulate');},now:130_000});
 assert.equal(plan.decision.action,'wait');assert.equal(plan.decision.reason,'inside_range');
 assert.equal(plan.kernelState.lastEligible?.block,100n);
 assert.equal(BigInt(f.kernel.campaignStartValue),2n*10n**18n);
 assert.equal(plan.currentEpoch,0);assert.equal(plan.nextEpoch,1);assert.equal(plan.actionAvailable,false);
});

test('recenter planner fails closed when latest mark is not the current epoch/source parent',async()=>{
 const f=fixture(),stale={...f.snapshot,previousMark:{...f.snapshot.previousMark,
  source:{...f.source0,block:'101'}}};
 await assert.rejects(buildRangeKeeperPaperRecenterPlan({snapshot:stale,frame:f.frame,
  buildId:f.buildId,actionCost:1n,actionGasWei:1n,requiredExitReserveWei:1n,
  quote:async()=>{throw Error('unexpected');},simulate:async()=>false,now:130_000}),/source_order_invalid/);
});

test('validated runtime adoption remains valid after later append-only observation marks',async()=>{
 const f=fixture(),previousHash=f.snapshot.previousMark.markHash,
  adoptedFrom='a'.repeat(64),compatibilityProof={schemaVersion:1,
   kind:'rangekeeper_paper_runtime_compatibility_v1',fromBuildId:adoptedFrom,
   toBuildId:f.buildId,strategyId:'rangekeeper_v1',configHash:f.draft.configHash,
   profileHash:f.draft.profileHash,latestMarkHash:'b'.repeat(64),validatorVersion:'fixture-v1'},
  snapshot={...f.snapshot,openMark:{...f.snapshot.openMark,model:{...f.snapshot.openMark.model,
   kernelBuildId:adoptedFrom}},previousMark:{...f.snapshot.previousMark,
   kernelSnapshot:{...f.kernel,state:{...f.kernel.state,buildId:adoptedFrom}}},
   runtimeAdoption:{adoptedFromBuildId:adoptedFrom,adoptionHash:'c'.repeat(64),
    latestMarkHash:'b'.repeat(64),compatibilityProof}};
 const plan=await buildRangeKeeperPaperRecenterPlan({snapshot,frame:f.frame,buildId:f.buildId,
  actionCost:1n,actionGasWei:1n,requiredExitReserveWei:1n,
  quote:async()=>{throw Error('inside range must not quote');},
  simulate:async()=>{throw Error('inside range must not simulate');},now:130_000});
 assert.equal(plan.decision.reason,'inside_range');assert.equal(plan.priorMark.markHash,previousHash);
});

test('fast observation cadence schedules confirmation at the persisted 30-second decision boundary',()=>{
 const decision={action:'wait',reason:'decision_interval',state:{confirmation:{firstAt:100}}} as never;
 assert.equal(rangeKeeperPaperNextObservationAt({decision,maxObservationGapSeconds:90,now:105_000}),130_000);
 assert.equal(rangeKeeperPaperNextObservationAt({decision,maxObservationGapSeconds:90,now:140_000}),140_000);
 assert.equal(rangeKeeperPaperNextObservationAt({decision,maxObservationGapSeconds:90,now:191_000}),null);
});
