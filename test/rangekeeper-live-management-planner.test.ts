import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRangeKeeperLiveManagementForkCost,buildRangeKeeperLivePlannerObservation,rangeKeeperLiveProvisionalActionCost,
 type RangeKeeperLiveManagementPlannerObservation} from '../src/deployments/rangekeeper-live-management-planner.js';
import type {RangeKeeperCandidate} from '../src/strategy/rangekeeper/domain.js';
import type {RangeKeeperLiveCampaign} from '../src/deployments/rangekeeper-live-campaign.js';

const token0='0x0000000000000000000000000000000000000001',token1='0x0000000000000000000000000000000000000002';
const source={block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:1_800_000_000};
const limits:any={maxActionCost:100_000n,maxRollingCost:500_000n,maxCampaignCost:1_000_000n,exitReserveWei:6_000n};
function campaign():RangeKeeperLiveCampaign{
 return {id:'c1',chainId:4663,wallet:'0x0000000000000000000000000000000000000003' as any,revision:1,profileId:'p',
  profileHash:'a'.repeat(64),profile:{},config:{pool:{token0,token1},limits} as any,configHash:`0x${'b'.repeat(64)}`,
  revisionConfig:{},revisionConfigHash:'c'.repeat(64),allocation:{allocationId:'a1',campaignId:'c1',revision:1,
   wallet:'0x0000000000000000000000000000000000000003',liquidByTokenAddress:{[token0]:500n,[token1]:700n},
   nativeSpendWei:1_000n,pendingNativeSpendWei:0n,exitReserveWei:100n,nftTokenIds:['9'],allocationHash:'d'.repeat(64),
   sourceGeneration:1,sourceHash:`0x${'1'.repeat(64)}`},baseline:{},reviewPayload:{},state:{
   version:1,id:'c1',operator:'0x0000000000000000000000000000000000000003' as any,configHash:`0x${'b'.repeat(64)}`,
   buildId:'e'.repeat(64),phase:'holding',desired:'running',haltReason:null,createdAt:1,expiresAt:2,economicActions:0,recenters:1,
   policy:{} as any,last:{} as any,activeTokenId:9n,retiredTokenIds:[],legacyNftCount:1n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,
  initial0:500n,initial1:700n,initialNativeWei:1_100n,initialStrategyValue:1_200n,candidate:null,swapDone:false,swapConfirmedAt:null,
   withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,collectedFee0:0n,collectedFee1:0n,
   gasSpentWei:400n,costEvents:[],highWaterValue:1_200n,activeSeconds:0,outsideSeconds:0,lastMarkTimestamp:1,
   lastReason:'test',closedAt:null} as any,stateHash:'f'.repeat(64),stateRevision:2,status:'active'} as any;
}
function observation():RangeKeeperLiveManagementPlannerObservation{
 return {source,snapshot:{source,operator:'0x0000000000000000000000000000000000000003',wallet0:9_000n,wallet1:8_000n,
  nativeWei:9_000n,nonce:4,nftCount:1n,tick:100,sqrtPriceX96:1n,unlocked:true,poolLiquidity:10_000n,
  allowances:[],position:{tokenId:9n,owner:'0x0000000000000000000000000000000000000003',token0,token1,fee:3000,
   tickLower:0,tickUpper:200,liquidity:2_000n,tokensOwed0:0n,tokensOwed1:0n}} as any,
  references:{source,proofHash:'1'.repeat(64),price0:2n*10n**18n,price1:10n**18n,nativePrice:2n*10n**18n,evidence:{}},
  position:{inventory0Raw:'590',inventory1Raw:'780',principal0Raw:'60',principal1Raw:'50',uncollected0Raw:'30',uncollected1Raw:'30'},
  decision:{reason:'test',observationHash:'2'.repeat(64)},costs:null,
  expiresAt:source.timestamp+90};
}
const candidate:RangeKeeperCandidate={kind:'recenter',range:{tickLower:0,tickUpper:200},swap:{token:0,amountIn:10n,
 quotedOut:5n,minOut:4n,priceAfter:1n,feeValue:20n,shortfallValue:30n},amount0Desired:1n,amount1Desired:2n,
 amount0Min:1n,amount1Min:1n,liquidity:100n,deployedValue:200n,sourceBlock:100n,sourceHash:source.hash as any,
 expiresAt:source.timestamp+90};

test('planner observation is bounded to this campaign allocation and remaining native reserve',()=>{
 const result=buildRangeKeeperLivePlannerObservation(campaign(),observation(),limits,null,0n,0);
 assert.equal(result.wallet0,500n);assert.equal(result.wallet1,700n);
 assert.equal(result.released0,90n);assert.equal(result.released1,80n);
 assert.equal(result.nativeWei,1_100n); // remaining store spend + exit reserve; gasSpentWei is historical, not debited again
 assert.equal(result.requiredExitReserveWei,6_000n);
 const measured=buildRangeKeeperLivePlannerObservation(campaign(),observation(),limits,10n,20n,100,8_000n);
 assert.equal(measured.requiredExitReserveWei,8_000n,'Measured full-exit reserve replaces the policy floor');
 const safe=buildRangeKeeperLivePlannerObservation(campaign(),observation(),limits,null,0n,0,8_000n,
  {continuity:'gap',safeExitRequired:true});
 assert.equal(safe.continuity,'gap');assert.equal(safe.safeExitRequired,true);
});

test('provisional planner cost cannot exceed the tightest remaining action, rolling, or campaign budget',()=>{
 const c=campaign();c.config.limits={...limits,maxActionCost:500n,maxRollingCost:400n,maxCampaignCost:600n} as any;
 c.state!.reservedActionCost=20n;c.state!.costEvents=[{hash:`0x${'1'.repeat(64)}` as any,block:1n,timestamp:1,
  gasWei:1n,gasValue:200n,swapFeeValue:100n,swapShortfallValue:50n}];
 assert.equal(rangeKeeperLiveProvisionalActionCost(c),30n);
});

test('owned-fork recenter cost binds source, candidate, allocation and conservative gas bounds',()=>{
 const report:any={source,createdTokenId:10n,gasByStage:[
  {phase:'entry',kind:'withdraw',gasUsed:100n,estimatedGas:200n},{phase:'entry',kind:'mint',gasUsed:200n,estimatedGas:200n},
  {phase:'exit',kind:'withdraw',gasUsed:300n,estimatedGas:400n}]};
 const result=buildRangeKeeperLiveManagementForkCost({campaign:campaign(),observation:observation(),candidate,report,
  baseFee:10n,marketGasPrice:12n});
 assert.equal(result.maxFeePerGasWei,'15');assert.equal(result.actionGasWei,'7800');
 assert.equal(result.completeExitGasWei,'7800');assert.equal(result.exitReserveWei,'7800');
 assert.equal(result.gasValueUsdX18,'15600');assert.equal(result.actionCostValue,'15650');
 assert.equal(result.provenance,'owned_fork_allocated_lifecycle_v1');assert.equal(result.syntheticNativeFunding,true);
 assert.match(result.sequenceHash,/^[0-9a-f]{64}$/);
});

test('fork cost builder rejects a changed anchor or incomplete cleanup and exit proof',()=>{
 const report:any={source,createdTokenId:10n,gasByStage:[
  {phase:'entry',kind:'withdraw',gasUsed:100n,estimatedGas:100n},{phase:'entry',kind:'mint',gasUsed:200n,estimatedGas:200n}]};
 assert.throws(()=>buildRangeKeeperLiveManagementForkCost({campaign:campaign(),observation:observation(),candidate,report,
  baseFee:10n,marketGasPrice:12n}),/complete exit/);
 assert.throws(()=>buildRangeKeeperLiveManagementForkCost({campaign:campaign(),observation:observation(),candidate,
  report:{...report,source:{...source,hash:`0x${'2'.repeat(64)}`},gasByStage:[...report.gasByStage,
   {phase:'exit',kind:'withdraw',gasUsed:300n,estimatedGas:300n}]},baseFee:10n,marketGasPrice:12n}),/source changed/);
});
