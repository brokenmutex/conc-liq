import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {nextRangeKeeperStage} from '../src/strategy/rangekeeper/live-stage.js';
import {contentHash} from '../src/deployments/contracts.js';
import {RANGEKEEPER_LIVE_BUILD_INCOMPATIBLE,assertRangeKeeperLiveCampaignBuildCompatible,deriveRangeKeeperCampaignStageSnapshot,deriveRangeKeeperLiveManagementTransition,
 deriveRangeKeeperStage,prepareRangeKeeperLiveStageAuthorization,type RangeKeeperLiveCampaign,
 type RangeKeeperLiveManagementReviewPayload} from '../src/deployments/rangekeeper-live-campaign.js';
import {compatibleCampaignIdentity} from './helpers/rangekeeper-live-compat.js';

// A campaign opened under build A, managed (previewed, admitted, executed) by the later build B.
const buildA='a'.repeat(64),buildB='b'.repeat(64);
const config=parseRangeKeeperConfig(JSON.parse(readFileSync(new URL('../config/rangekeeper-v1-aapl-disabled.json',import.meta.url),'utf8')));
const p=config.pool,wallet=config.operator!;
const source={block:'10',hash:`0x${'a'.repeat(64)}`,timestamp:1000};
const conversion={mode:'convert',swapRequired:true,withdrawn0:'30',withdrawn1:'40',maxSlippageBps:config.limits.maxSlippageBps,
 maxSwapShortfallValue:String(config.limits.maxSwapShortfallValue),token:1,amountIn:'140',minOut:'139',expectedOut:'139',feeValue:'100',shortfallValue:'400'};

function fixture(){
 const snapshot={operator:wallet,source:{block:10n,hash:source.hash,timestamp:source.timestamp},nonce:4n,nftCount:1n,
  wallet0:20n,wallet1:30n,nativeWei:40n,tick:0,sqrtPriceX96:1n<<96n,unlocked:true,poolLiquidity:100n,allowances:[],
  position:{tokenId:77n,token0:p.token0,token1:p.token1,fee:p.fee,tickLower:-60,tickUpper:60,liquidity:10n,tokensOwed0:0n,tokensOwed1:0n}} as any;
 const identity=compatibleCampaignIdentity(config as any,buildA);
 const state={version:1,id:'campaign-1',operator:wallet,configHash:identity.configHash,buildId:buildA,phase:'holding',desired:'running',
  exitMode:null,haltReason:null,createdAt:1,expiresAt:3000,economicActions:1,recenters:0,policy:identity.policy,last:snapshot,activeTokenId:77n,
  retiredTokenIds:[],legacyNftCount:0n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,initial0:1n,initial1:1n,initialNativeWei:1n,
  initialStrategyValue:1n,candidate:null,swapDone:false,swapConfirmedAt:null,withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,
  mintRecoveryAttempts:0,collectedFee0:0n,collectedFee1:0n,gasSpentWei:0n,costEvents:[],highWaterValue:1n,activeSeconds:0,outsideSeconds:0,
  lastMarkTimestamp:0,lastReason:'opened',closedAt:null} as any;
 const profile={};
 const campaign={id:'campaign-1',chainId:4663,wallet,revision:1,profileId:'profile-1',profileHash:contentHash(profile),profile,
  config:identity.config,configHash:identity.configHash,strategyId:identity.strategyId,strategyVersion:identity.strategyVersion,
  stateSchemaVersion:identity.stateSchemaVersion,revisionConfig:{},revisionConfigHash:'f'.repeat(64),
  allocation:{allocationId:'allocation-1',campaignId:'campaign-1',revision:1,wallet,
   liquidByTokenAddress:{[p.token0.toLowerCase()]:20n,[p.token1.toLowerCase()]:30n},nativeSpendWei:40n,pendingNativeSpendWei:0n,
   exitReserveWei:10n,nftTokenIds:['77'],allocationHash:'e'.repeat(64),sourceGeneration:3,sourceHash:source.hash},
  baseline:{},reviewPayload:{binding:{buildId:buildA}},state,stateHash:'1'.repeat(64),stateRevision:7,status:'active'} as unknown as RangeKeeperLiveCampaign;
 const base=(over:Record<string,unknown>)=>({schemaVersion:1,kind:'rangekeeper_live_management_review',mode:'live',strategyId:'rangekeeper_v1',
  campaignId:campaign.id,revision:1,allocationId:'allocation-1',profileId:'profile-1',profileHash:campaign.profileHash,
  configHash:identity.configHash.slice(2),buildId:buildB,campaignBuildId:buildA,runtimeStateHash:campaign.stateHash,stateRevision:7,
  wallet:{address:wallet,generation:8,commitmentsHash:'9'.repeat(64),nonce:'4'},source,snapshot,
  reference:{proofHash:'8'.repeat(64),price0:'100',price1:'200',nativePrice:'300',evidence:{}},position:{tokenId:'77'},
  decision:{reason:'fixture',observationHash:'7'.repeat(64)},candidate:null,policy:null,expiresAt:2000,...over}) as any;
 const costs=(extra:Record<string,unknown>={})=>({status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,gasWei:'3',
  gasValueUsdX18:'4',actionCostValue:'504',...extra});
 const retain=(over:Record<string,unknown>={})=>base({operationKind:'close_retain',costs:costs(),...over}) as RangeKeeperLiveManagementReviewPayload;
 const convert=(over:Record<string,unknown>={})=>base({operationKind:'close_convert',costs:costs({conversion}),...over}) as RangeKeeperLiveManagementReviewPayload;
 const candidate={kind:'recenter',range:{tickLower:-60,tickUpper:60},swap:null,amount0Desired:1n,amount1Desired:2n,amount0Min:1n,amount1Min:2n,
  liquidity:3n,deployedValue:4n,sourceBlock:10n,sourceHash:source.hash,expiresAt:1090};
 const recenterPolicy={...identity.policy,lastEligible:{block:10n,hash:source.hash,timestamp:1000}};
 const recenter=(over:Record<string,unknown>={})=>base({operationKind:'change_range',costs:costs(),candidate,policy:recenterPolicy,
  decision:{reason:'confirmed_outside_range',observationHash:'7'.repeat(64)},...over}) as RangeKeeperLiveManagementReviewPayload;
 return {campaign,state,snapshot,retain,convert,recenter,identity};
}

test('a campaign opened under build A is previewed, admitted and executed for every management kind by build B',()=>{
 const {campaign,state,retain,convert,recenter}=fixture();
 for(const [kind,payload] of [['close_retain',retain()],['close_convert',convert()],['change_range',recenter()]] as const){
  assert.notEqual(payload.buildId,state.buildId,'the managing build differs from the open build');
  assert.equal(payload.campaignBuildId,state.buildId,'the review records the campaign open build');
  const next=deriveRangeKeeperLiveManagementTransition(campaign,payload);
  assert.equal(next.phase,kind==='change_range'?'recenter':'exit',kind);
  // Open-build provenance is left alone: state hashes, policy binding and the persisted-state read assertion all keep one build.
  assert.equal(next.buildId,buildA,`${kind}: state.buildId stays the open build`);
  assert.equal(next.policy.buildId,buildA,`${kind}: policy.buildId stays the open build`);
 }
});

test('a management review whose recorded campaign build differs from the persisted one is rejected',()=>{
 const {campaign,retain}=fixture();
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,retain({campaignBuildId:'c'.repeat(64)})),/campaign build provenance changed/);
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,retain({buildId:'zz'})),/stale or bound to another runtime/);
 // A review persisted before cross-build management had no campaignBuildId and was same-build only.
 assert.doesNotThrow(()=>deriveRangeKeeperLiveManagementTransition(campaign,retain({campaignBuildId:undefined,buildId:buildA})));
 assert.throws(()=>deriveRangeKeeperLiveManagementTransition(campaign,retain({campaignBuildId:undefined,buildId:buildB})),/campaign build provenance changed/);
});

test('an incompatible strategy, state version, config or policy shape fails closed for management and stage authorization',()=>{
 const {campaign,retain}=fixture();
 assert.doesNotThrow(()=>assertRangeKeeperLiveCampaignBuildCompatible(campaign));
 const cases:[string,(c:RangeKeeperLiveCampaign)=>RangeKeeperLiveCampaign][]=[
  ['strategy id',c=>({...c,strategyId:'other_v1'})],
  ['strategy version',c=>({...c,strategyVersion:'2.0.0'})],
  ['config strategy version',c=>({...c,config:{...c.config,strategyVersion:'2.0.0'} as any})],
  ['state schema version',c=>({...c,stateSchemaVersion:2})],
  ['live state version',c=>({...c,state:{...c.state!,version:2} as any})],
  ['config hash drift',c=>({...c,config:{...c.config,campaignValue:c.config.campaignValue+1n}})],
  ['state config hash',c=>({...c,state:{...c.state!,configHash:`0x${'1'.repeat(64)}`} as any})],
  ['policy schema version',c=>({...c,state:{...c.state!,policy:{...c.state!.policy,schemaVersion:2}} as any})],
  ['policy unknown field',c=>({...c,state:{...c.state!,policy:{...c.state!.policy,extra:1}} as any})],
  ['policy build provenance',c=>({...c,state:{...c.state!,policy:{...c.state!.policy,buildId:buildB}} as any})],
  ['missing state',c=>({...c,state:null})],
 ];
 for(const [label,mutate] of cases){
  const broken=mutate(campaign);
  assert.throws(()=>assertRangeKeeperLiveCampaignBuildCompatible(broken),new RegExp(RANGEKEEPER_LIVE_BUILD_INCOMPATIBLE),label);
  if(broken.state)assert.throws(()=>deriveRangeKeeperLiveManagementTransition(broken,retain()),new RegExp(RANGEKEEPER_LIVE_BUILD_INCOMPATIBLE),`${label}: management`);
 }

});

test('stage authorization binds to the build that admitted the job, defaulting to the open build',async()=>{
 const {campaign,retain}=fixture();
 const exit=deriveRangeKeeperLiveManagementTransition(campaign,retain());
 const managed={...campaign,state:exit,stateRevision:8,stateHash:'2'.repeat(64)} as RangeKeeperLiveCampaign;
 const snapshot=exit.last;
 const sourceText={block:source.block,hash:source.hash,timestamp:source.timestamp};
 const references={price0:1n,price1:1n,nativePrice:1n,proofHash:'8'.repeat(64),source:sourceText,evidence:{}};
 const walletBefore={walletGeneration:8,wallet:{operator:wallet,source:sourceText,nonce:4,pendingNonce:4,nativeWei:snapshot.nativeWei,
  tokens:{[p.token0.toLowerCase()]:snapshot.wallet0,[p.token1.toLowerCase()]:snapshot.wallet1},nftTokenIds:['77'],allowances:[]}};
 const common={campaign:managed,snapshot,source:sourceText,references,chain:{verify:async()=>true} as any,verifyReferences:async()=>true,
  walletBefore,intent:{} as any,exitSpendAllowed:true};
 // The stage and plan the strategy authorizes from the persisted retained-exit state.
 const authorized=await nextRangeKeeperStage(exit,deriveRangeKeeperCampaignStageSnapshot(managed,snapshot),managed.config,common.chain,
  {price0:1n,price1:1n},undefined as any);
 assert(authorized,'the retained exit has a withdraw stage');
 const stage=deriveRangeKeeperStage(authorized!,managed.stateRevision,0);
 const viaJob=await prepareRangeKeeperLiveStageAuthorization({...common,stage,proposedPlan:authorized as any,buildId:buildB});
 assert.equal(viaJob.request.buildId,buildB,'a management job runs under the build that admitted it (job.buildId)');
 const byDefault=await prepareRangeKeeperLiveStageAuthorization({...common,stage,proposedPlan:authorized as any});
 assert.equal(byDefault.request.buildId,buildA,'without a job build the request keeps the campaign open build');
 await assert.rejects(prepareRangeKeeperLiveStageAuthorization({...common,stage,proposedPlan:authorized as any,
  campaign:{...managed,stateSchemaVersion:2}}),new RegExp(RANGEKEEPER_LIVE_BUILD_INCOMPATIBLE));
});
