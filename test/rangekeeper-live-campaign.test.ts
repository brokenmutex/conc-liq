import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compatibleCampaignIdentity} from './helpers/rangekeeper-live-compat.js';
import {deriveRangeKeeperCampaignStageSnapshot,deriveRangeKeeperLiveManagementTransition,deriveRangeKeeperStage,rangeKeeperCampaignAllowancePolicy,
 type RangeKeeperLiveCampaign,type RangeKeeperLiveManagementReviewPayload} from '../src/deployments/rangekeeper-live-campaign.js';

test('live campaign stage keys distinguish positive approval, cleanup, and later state revisions',()=>{
 const positive={kind:'approve',token:0,spender:'positionManager',amount:500n} as const;
 const cleanup={...positive,amount:0n};
 const first=deriveRangeKeeperStage(positive,1),clear=deriveRangeKeeperStage(cleanup,2),later=deriveRangeKeeperStage(positive,3);
 assert(first.length<=64&&clear.length<=64&&later.length<=64);
 assert.notEqual(first,clear);assert.notEqual(first,later);assert.notEqual(clear,later);
});

test('campaign allowance policy uses only immutable persisted inputs: initial allocation, deployment cap and frozen review prices',()=>{
 const token0='0x1111111111111111111111111111111111111111',token1='0x2222222222222222222222222222222222222222';
 const campaign=(overrides:Record<string,unknown>={})=>({config:{pool:{token0,token1,decimals0:6,decimals1:18},
  limits:{maxDeploymentValue:250n*10n**18n}},allocation:{liquidByTokenAddress:{[token0]:100n,[token1]:0n}},
  reviewPayload:{references:{price0:String(10n**18n),price1:String(250n*10n**18n)}},
  state:{initial0:300n*10n**6n,initial1:0n,reserve0:0n,reserve1:0n},...overrides}) as unknown as RangeKeeperLiveCampaign;
 const policy=rangeKeeperCampaignAllowancePolicy(campaign());
 assert.equal(policy.kind,'persistent_capped_v1');
 assert.deepEqual(policy.exposure,[300n*10n**6n,10n**18n],'USDG: initial allocation; stock: $250 at the frozen price');
 assert.equal(policy.retain?.size,0);
 const drifted=rangeKeeperCampaignAllowancePolicy(campaign({allocation:{liquidByTokenAddress:{[token0]:1n,[token1]:99n}}}));
 assert.deepEqual(drifted.exposure,policy.exposure,'current allocation drift never moves the cap');
 const opening=rangeKeeperCampaignAllowancePolicy(campaign({state:null}),new Set(['a:b']));
 assert.deepEqual(opening.exposure,[250n*10n**6n,10n**18n],'an opening campaign has only its reserved allocation and the deployment cap');
 assert(opening.retain!.has('a:b'));
 const unpriced=rangeKeeperCampaignAllowancePolicy(campaign({reviewPayload:{}}));
 assert.deepEqual(unpriced.exposure,[300n*10n**6n,0n],'without frozen prices only the allocation counts');
});

test('strategy stage snapshot exposes only this campaign remaining liquid and spendable native allocation',()=>{
 const token0='0x1111111111111111111111111111111111111111',token1='0x2222222222222222222222222222222222222222';
 const campaign={config:{pool:{token0,token1}},allocation:{liquidByTokenAddress:{[token0]:30n,[token1]:70n},
  nativeSpendWei:40n,exitReserveWei:25n,nftTokenIds:[]},state:{reserve0:0n,reserve1:0n,reserveNativeWei:0n}} as unknown as RangeKeeperLiveCampaign;
 const snapshot={operator:'0x3333333333333333333333333333333333333333',source:{block:1n,hash:`0x${'a'.repeat(64)}`,timestamp:1},
  wallet0:80n,wallet1:10n,nativeWei:100n,nonce:3n,nftCount:0n,tick:0,sqrtPriceX96:1n,unlocked:true,poolLiquidity:0n,
  allowances:[],position:null} as any;
 const bounded=deriveRangeKeeperCampaignStageSnapshot(campaign,snapshot);
 assert.equal(bounded.wallet0,30n);assert.equal(bounded.wallet1,10n);assert.equal(bounded.nativeWei,40n);
 assert.equal(snapshot.wallet0,80n);assert.equal(snapshot.nativeWei,100n,'Canonical before image must remain untouched');
 assert.throws(()=>deriveRangeKeeperCampaignStageSnapshot(campaign,{...snapshot,position:{tokenId:999n}}),/not owned by this campaign/);
 assert.throws(()=>deriveRangeKeeperCampaignStageSnapshot({...campaign,state:{reserve0:1n,reserve1:0n,reserveNativeWei:0n} as any},snapshot),
  /strategy reserves must be zero/);
});

test('retain management transition freezes exit-only mode and rejects stale campaign state',()=>{
 const wallet='0x3333333333333333333333333333333333333333',source={block:'10',hash:`0x${'a'.repeat(64)}`,timestamp:1000};
 const snapshot={operator:wallet,source:{block:10n,hash:source.hash,timestamp:source.timestamp},nonce:4n,nftCount:1n,
  wallet0:20n,wallet1:30n,nativeWei:40n,tick:0,sqrtPriceX96:1n,unlocked:true,poolLiquidity:100n,allowances:[],
  position:{tokenId:77n,token0:'0x1111111111111111111111111111111111111111',token1:'0x2222222222222222222222222222222222222222',
   fee:3000,tickLower:-60,tickUpper:60,liquidity:10n,tokensOwed0:0n,tokensOwed1:0n}} as any;
 const identity=compatibleCampaignIdentity({pool:{token0:snapshot.position.token0,token1:snapshot.position.token1}},'d'.repeat(64));
 const state={version:1,id:'campaign-1',operator:wallet,configHash:identity.configHash,buildId:'d'.repeat(64),phase:'holding',
  desired:'running',exitMode:null,haltReason:null,createdAt:1,expiresAt:3000,economicActions:1,recenters:0,policy:identity.policy,last:snapshot,activeTokenId:77n,retiredTokenIds:[],legacyNftCount:0n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,
  initial0:1n,initial1:1n,initialNativeWei:1n,initialStrategyValue:1n,candidate:null,swapDone:false,swapConfirmedAt:null,withdrawDone:false,
  actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,collectedFee0:0n,collectedFee1:0n,gasSpentWei:0n,costEvents:[],
  highWaterValue:1n,activeSeconds:0,outsideSeconds:0,lastMarkTimestamp:0,lastReason:'opened',closedAt:null} as any;
 const campaign={id:'campaign-1',chainId:4663,wallet,revision:1,profileId:'profile-1',profileHash:'c'.repeat(64),profile:{},
  config:identity.config,configHash:state.configHash,strategyId:identity.strategyId,strategyVersion:identity.strategyVersion,
  stateSchemaVersion:identity.stateSchemaVersion,revisionConfig:{},revisionConfigHash:'f'.repeat(64),
  allocation:{allocationId:'allocation-1',campaignId:'campaign-1',revision:1,wallet,liquidByTokenAddress:{},nativeSpendWei:40n,
   pendingNativeSpendWei:0n,exitReserveWei:10n,nftTokenIds:['77'],allocationHash:'e'.repeat(64),sourceGeneration:3,sourceHash:source.hash},
  baseline:{},reviewPayload:{binding:{buildId:state.buildId}},state,stateHash:'1'.repeat(64),stateRevision:7,status:'active'} as unknown as RangeKeeperLiveCampaign;
 const payload={schemaVersion:1,kind:'rangekeeper_live_management_review',mode:'live',strategyId:'rangekeeper_v1',operationKind:'close_retain',
  campaignId:campaign.id,revision:1,allocationId:'allocation-1',profileId:'profile-1',profileHash:campaign.profileHash,configHash:state.configHash.slice(2),
  buildId:state.buildId,runtimeStateHash:campaign.stateHash,stateRevision:7,wallet:{address:wallet,generation:8,commitmentsHash:'9'.repeat(64),nonce:'4'},
  source,snapshot,reference:{proofHash:'8'.repeat(64),price0:'100',price1:'200',nativePrice:'300',evidence:{}},position:{tokenId:'77'},
  decision:{reason:'operator_exit',observationHash:'7'.repeat(64)},candidate:null,policy:null,
  costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,gasWei:'3',gasValueUsdX18:'4',actionCostValue:'4'},expiresAt:2000} as unknown as RangeKeeperLiveManagementReviewPayload;
 const next=deriveRangeKeeperLiveManagementTransition(campaign,payload);
 assert.equal(next.phase,'exit');assert.equal(next.desired,'stopped');assert.equal(next.exitMode,'retain');
 assert.equal(next.candidate,null);assert.equal(next.activeTokenId,77n);assert.equal(state.phase,'holding','Source state must remain immutable');
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition({...campaign,stateHash:'2'.repeat(64)},payload),/stale|another state transition/);
});

test('recenter management transition requires source-bound candidate and freezes policy state',()=>{
 const wallet='0x3333333333333333333333333333333333333333',source={block:'10',hash:`0x${'a'.repeat(64)}`,timestamp:1000};
 const snapshot={operator:wallet,source:{block:10n,hash:source.hash,timestamp:1000},nonce:4n,nftCount:1n,position:{tokenId:77n},
  wallet0:20n,wallet1:30n,nativeWei:40n,tick:0,sqrtPriceX96:1n,unlocked:true,poolLiquidity:100n,allowances:[]} as any;
 const identity=compatibleCampaignIdentity({pool:{}},'d'.repeat(64));
 const state={version:1,id:'campaign-1',operator:wallet,configHash:identity.configHash,buildId:'d'.repeat(64),phase:'holding',
  desired:'running',exitMode:null,last:snapshot,activeTokenId:77n,costEvents:[],policy:identity.policy,actionStartCostIndex:0} as any;
 const campaign={id:'campaign-1',chainId:4663,wallet,revision:1,profileId:'profile-1',profileHash:'c'.repeat(64),profile:{},
  config:identity.config,strategyId:identity.strategyId,strategyVersion:identity.strategyVersion,stateSchemaVersion:identity.stateSchemaVersion,
  configHash:state.configHash,allocation:{allocationId:'allocation-1',sourceGeneration:1,nftTokenIds:['77']},state,stateHash:'1'.repeat(64),
  stateRevision:2,status:'active'} as unknown as RangeKeeperLiveCampaign;
 const candidate={kind:'recenter',range:{tickLower:-60,tickUpper:60},swap:null,amount0Desired:1n,amount1Desired:2n,
  amount0Min:1n,amount1Min:2n,liquidity:3n,deployedValue:4n,sourceBlock:10n,sourceHash:source.hash,expiresAt:1090};
 const policy={schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',configHash:state.configHash,buildId:state.buildId,
  lastEligible:{block:10n,hash:source.hash,timestamp:1000},exit:null,confirmation:null} as any;
 const payload={schemaVersion:1,kind:'rangekeeper_live_management_review',mode:'live',strategyId:'rangekeeper_v1',operationKind:'change_range',
  campaignId:campaign.id,revision:1,allocationId:'allocation-1',profileId:'profile-1',profileHash:campaign.profileHash,configHash:state.configHash.slice(2),
  buildId:state.buildId,runtimeStateHash:campaign.stateHash,stateRevision:2,wallet:{address:wallet,generation:2,commitmentsHash:'9'.repeat(64),nonce:'4'},
  source,snapshot,reference:{proofHash:'8'.repeat(64),price0:'100',price1:'200',nativePrice:'300',evidence:{}},position:{tokenId:'77'},
  decision:{reason:'confirmed_outside_range',observationHash:'7'.repeat(64)},candidate,policy,
  costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,actionGasWei:'3',actionCostValue:'1'},expiresAt:2000} as any;
 const next=deriveRangeKeeperLiveManagementTransition(campaign,payload);
 assert.equal(next.phase,'recenter');assert.equal(next.exitMode,null);assert.equal(next.candidate?.kind,'recenter');
 assert.equal(next.actionStartCostIndex,0);assert.equal(next.reservedActionCost,1n);assert.equal(state.phase,'holding');
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,{...payload,candidate:{...candidate,sourceBlock:9n}}),/source\/expiry mismatch/);
});
