import assert from 'node:assert/strict';
import test from 'node:test';
import {amountsForLiquidity,sqrtRatioAtTick} from '../src/backtest/principal.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY,USDG} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {resolveRangeKeeperPaperPolicy} from '../src/deployments/rangekeeper-paper-open-model.js';
import {loadRangeKeeperPaperExitContext} from '../src/deployments/rangekeeper-paper-context.js';
import {rangeKeeperPaperCandidateHash} from '../src/deployments/rangekeeper-paper-cost.js';
import {replayPaperMint} from '../src/v3/position-math.js';

const address=(digit:string)=>`0x${digit.repeat(40)}`;
const hash=(digit:string)=>`0x${digit.repeat(64)}`;
const now=Date.now(),currentTimestamp=Math.floor(now/1000)-15;
const source=(block:string,timestamp:number)=>({block,hash:hash(block==='100'?'1':block==='101'?'2':'3'),timestamp});
const openSource=source('100',currentTimestamp-90),priorSource=source('101',currentTimestamp-45),currentSource=source('102',currentTimestamp);
const proof={fixture:'prior-mark-context-regression'},proofHash=referenceProofHash(proof);
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:address('4'),token0:USDG,token1:address('7'),quoteToken:0,decimals0:6,decimals1:18,
 fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,
 quoter:PAPER_QUOTER,poolCodeHash:hash('a'),token0CodeHash:hash('b'),token1CodeHash:hash('c'),
 managerCodeHash:hash('d'),quoterCodeHash:hash('e'),reference0:'USDG/USD',reference1:'AAPL/USD',
 nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const profileHash=contentHash(profile),campaignId='00000000-0000-4000-8000-00000000abcd',revision=1,
 buildId='f'.repeat(64),parameters={fullWidthSpacings:20,limits:{
 maxDeploymentValue:String(100n*10n**18n),minDeploymentValue:String(1n*10n**18n),minDeploymentPpm:10_000,
 maxSwapInputValue:String(10n*10n**18n),maxSwapInputPpm:1_000_000,
 maxSwapShortfallValue:String(1n*10n**18n),maxSlippageBps:50,
 maxActionCost:String(5n*10n**18n),maxRollingCost:String(8n*10n**18n),maxCampaignCost:String(16n*10n**18n),
 maxExposurePpm:1_000_000,maxLossValue:String(10n*10n**18n),maxDrawdownPpm:1_000_000,
 maxRecenters:5,maxLiquiditySharePpm:1_000_000,maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'}},
 configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
 allocation={token0Raw:String(10n**18n),token1Raw:String(10n**18n),nativeWei:'1000000000000000'},
 draft={id:campaignId,revision,allocation,profile,profileHash,configHash,strategyId:'rangekeeper_v1' as const,parameters},
 policy=resolveRangeKeeperPaperPolicy(draft,buildId);
assert(policy.policy&&!policy.unavailable.length);
const range={tickLower:-600,tickUpper:600},openSqrt=sqrtRatioAtTick(0),mint=replayPaperMint(openSqrt,range,
 BigInt(allocation.token0Raw),BigInt(allocation.token1Raw),0n),candidate={kind:'entry' as const,range,swap:null,
 amount0Desired:BigInt(allocation.token0Raw),amount1Desired:BigInt(allocation.token1Raw),amount0Min:0n,
 amount1Min:0n,liquidity:mint.liquidity,deployedValue:2n*10n**18n,sourceBlock:BigInt(openSource.block),
 sourceHash:openSource.hash as `0x${string}`,expiresAt:openSource.timestamp+90},
 idle={token0:String(BigInt(allocation.token0Raw)-mint.amount0),
  token1:String(BigInt(allocation.token1Raw)-mint.amount1)},
 candidateHash=rangeKeeperPaperCandidateHash({campaignId,revision,profileHash,configHash,source:openSource,
  referenceProofHash:proofHash,candidate}),openModel={kind:'rangekeeper_paper_open_model',status:'indicative',
 actionAvailable:false,campaignId,revision,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',
 draftConfigHash:configHash,profileHash,kernelPolicyHash:policy.policy!.policyHash,kernelBuildId:buildId,
 source:openSource,poolState:{tick:0,sqrtPriceX96:String(openSqrt),poolLiquidity:String(10n**24n)},
 reference:{price0:String(10n**18n),price1:String(10n**18n),nativePrice:String(10n**18n),
  eligible:true,proofHash,proof,reasons:[]},decision:{requiresSecondObservation:true},
 candidate:{kind:'entry',range,swap:null,amount0Desired:String(candidate.amount0Desired),
  amount1Desired:String(candidate.amount1Desired),amount0Min:'0',amount1Min:'0',
  liquidity:String(candidate.liquidity),deployedValue:String(candidate.deployedValue),
  sourceBlock:String(candidate.sourceBlock),sourceHash:candidate.sourceHash,expiresAt:candidate.expiresAt},candidateHash},
 openModelHash=contentHash(openModel),
 priorPrincipal=amountsForLiquidity({liquidity:mint.liquidity,sqrtPriceX96:sqrtRatioAtTick(0),
  sqrtRatioAX96:sqrtRatioAtTick(range.tickLower),sqrtRatioBX96:sqrtRatioAtTick(range.tickUpper)}),
 currentSqrt=sqrtRatioAtTick(120),currentPrincipal=amountsForLiquidity({liquidity:mint.liquidity,
  sqrtPriceX96:currentSqrt,sqrtRatioAX96:sqrtRatioAtTick(range.tickLower),
  sqrtRatioBX96:sqrtRatioAtTick(range.tickUpper)});

function snapshot(overrides:Record<string,unknown>={}){
 const body:any={schemaVersion:1,kind:'rangekeeper_paper_persisted_context_v1',campaignId,revision,
  mode:'paper',lifecycle:'active',pendingOperationId:null,
  draft:{...draft},openMark:{id:'1',classification:'rangekeeper_paper_open_v1',modelHash:openModelHash,model:openModel},
  previousMark:{id:'2',classification:'rangekeeper_paper_mark_v1',source:priorSource,candidateHash,
   candidate:openModel.candidate,candidateReferenceProofHash:proofHash,epoch:0,
   position:{tickLower:range.tickLower,tickUpper:range.tickUpper,liquidity:String(mint.liquidity)},idle:{...idle}},
 kernel:{source:priorSource,state:{schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
    configHash:`0x${policy.policy!.policyHash}`,buildId,lastEligible:priorSource,confirmation:null,exit:null},
   wallet0:idle.token0,wallet1:idle.token1,released0:String(priorPrincipal.amount0),
   released1:String(priorPrincipal.amount1),nativeWei:allocation.nativeWei,campaignStartValue:'1',highWaterValue:'1',
   rollingSpentCost:'0',campaignSpentCost:'0',reservedCost:'0',recenters:0,pending:false,
   entryAllowed:false,safeExitRequired:false,executionReady:false},...overrides};
 body.currentEpoch={epoch:0,markId:'1',markHash:'8'.repeat(64),source:openSource,
  candidate:openModel.candidate,candidateHash,candidateReferenceProofHash:proofHash,
  inventory:{position:body.previousMark.position,idle:{...idle}},kernelSnapshot:{...body.kernel,source:openSource,
   state:{...body.kernel.state,buildId}},mintSqrtPriceX96:String(openSqrt),
  fundingBeforeSwap:{token0:allocation.token0Raw,token1:allocation.token1Raw},allowancesCleared:false,
  reference:{price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'1000000000000000000',
   proofHash,proof}};
 body.snapshotHash=contentHash(body);
 return body;
}
const frame:PaperOpenFrame={source:currentSource,tick:120,sqrtPriceX96:currentSqrt,poolLiquidity:10n**24n,
 price0:10n**18n,price1:11n*10n**17n,nativePrice:2_000n*10n**18n,
 referenceEligible:true,referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof};
const load=(saved:unknown)=>loadRangeKeeperPaperExitContext({campaignId,buildId,frame,now,
 readSnapshot:async()=>saved,readGasProfiles:async()=>[]});

test('restart context binds the previous mark kernel and reprojects principal at the current source',async()=>{
 const saved=snapshot(),loaded=await load(saved);
 assert.equal(loaded.status,'available',loaded.status==='unavailable'?loaded.reason:'');
 if(loaded.status!=='available')return;
 assert.equal(loaded.previous.source.block,priorSource.block);
 assert.equal(loaded.kernel.source.block,currentSource.block);
 assert.equal(loaded.kernel.released0,currentPrincipal.amount0);
 assert.equal(loaded.kernel.released1,currentPrincipal.amount1);
 assert.notEqual(loaded.kernel.released0,BigInt(saved.kernel.released0),
  'the older observation principal must not be reused at the current price');
});

test('restart context rejects a kernel whose anchor differs from the persisted prior mark',async()=>{
 const saved=snapshot(),wrongAnchor=source('100',priorSource.timestamp);
 saved.kernel.source=wrongAnchor;saved.snapshotHash=contentHash((( {snapshotHash:_hash,...body}:any)=>body)(saved));
 const loaded=await load(saved);
 assert.equal(loaded.status,'unavailable');
 if(loaded.status==='unavailable')assert.equal(loaded.reason,'rangekeeper_persisted_open_or_mark_identity_invalid');
});

test('exit context accepts the booked two-confirmation decision but rejects an unconfirmed execute shape',async()=>{
 for(const [reason,expected] of [['two_confirmations','available'],['unconfirmed','unavailable']]){
  const model={...openModel,decision:{requiresSecondObservation:false,kernelAction:'execute',kernelReason:reason}},
   saved=snapshot({openMark:{id:'1',classification:'rangekeeper_paper_open_v1',
    modelHash:contentHash(model),model}});
  const loaded=await load(saved);assert.equal(loaded.status,expected,loaded.status==='unavailable'?loaded.reason:'');
 }
});

test('restart context rejects changed prior inventory even when the snapshot hash is refreshed',async()=>{
 const saved=snapshot();saved.previousMark.idle.token0=String(BigInt(saved.previousMark.idle.token0)+1n);
 saved.snapshotHash=contentHash((( {snapshotHash:_hash,...body}:any)=>body)(saved));
 const loaded=await load(saved);
 assert.equal(loaded.status,'unavailable');
 if(loaded.status==='unavailable')assert.equal(loaded.reason,'rangekeeper_persisted_idle_inventory_mismatch');
});

test('adopted exit context validates a connected two-hop runtime lineage against immutable opening model',async()=>{
 const historicalBuild='a'.repeat(64),middleBuild='b'.repeat(64),open={...openModel,kernelBuildId:historicalBuild},
  openHash=contentHash(open),firstMarkHash='c'.repeat(64),secondMarkHash='d'.repeat(64);
 const link=(fromBuildId:string,toBuildId:string,latestMarkHash:string,adoptionHash:string)=>{
  const compatibilityProof={schemaVersion:1,kind:'rangekeeper_paper_runtime_compatibility_v1',
   fromBuildId,toBuildId,strategyId:'rangekeeper_v1',configHash,profileHash,latestMarkHash,
   openModelHash:openHash,historicalKernelBuildId:historicalBuild,validatorVersion:'rangekeeper-paper-epoch-v1'};
  return {fromBuildId,toBuildId,adoptionHash,latestMarkHash,compatibilityProof};
 };
 const first=link(historicalBuild,middleBuild,firstMarkHash,'1'.repeat(64)),
  second=link(middleBuild,buildId,secondMarkHash,'2'.repeat(64)),
  runtimeAdoption={adoptedFromBuildId:historicalBuild,adoptionHash:second.adoptionHash,
   latestMarkHash:second.latestMarkHash,compatibilityProof:second.compatibilityProof,
   adoptionChain:[first,second]},
  openMark={id:'1',classification:'rangekeeper_paper_open_v1',modelHash:openHash,model:open},
  saved=snapshot({openMark,runtimeIdentity:{buildId},runtimeAdoption,
   kernel:{...snapshot().kernel,state:{...snapshot().kernel.state,buildId:historicalBuild}}});
 const loaded=await load(saved);
 assert.equal(loaded.status,'available',loaded.status==='unavailable'?loaded.reason:'');
 if(loaded.status==='available')assert.equal(loaded.openModel.kernelBuildId,historicalBuild);
});

test('adopted exit context rejects a disconnected or altered runtime adoption hop',async()=>{
 const historicalBuild='a'.repeat(64),middleBuild='b'.repeat(64),open={...openModel,kernelBuildId:historicalBuild},
  openHash=contentHash(open),latestMarkHash='c'.repeat(64);
 const link=(fromBuildId:string,toBuildId:string,adoptionHash:string)=>({fromBuildId,toBuildId,
  adoptionHash,latestMarkHash,compatibilityProof:{schemaVersion:1,kind:'rangekeeper_paper_runtime_compatibility_v1',
   fromBuildId,toBuildId,strategyId:'rangekeeper_v1',configHash,profileHash,latestMarkHash,
   openModelHash:openHash,historicalKernelBuildId:historicalBuild,validatorVersion:'rangekeeper-paper-epoch-v1'}});
 const first=link(historicalBuild,middleBuild,'1'.repeat(64)),second=link('e'.repeat(64),buildId,'2'.repeat(64)),
  runtimeAdoption={adoptedFromBuildId:historicalBuild,adoptionHash:second.adoptionHash,
   latestMarkHash:second.latestMarkHash,compatibilityProof:second.compatibilityProof,adoptionChain:[first,second]},
  openMark={id:'1',classification:'rangekeeper_paper_open_v1',modelHash:openHash,model:open},
  kernel=snapshot().kernel;
 for(const changed of [runtimeAdoption,{...runtimeAdoption,adoptionChain:[first,
  {...second,compatibilityProof:{...second.compatibilityProof,openModelHash:'f'.repeat(64)}}]}]){
  const saved=snapshot({openMark,runtimeIdentity:{buildId},runtimeAdoption:changed,
   kernel:{...kernel,state:{...kernel.state,buildId:historicalBuild}}});
  const loaded=await load(saved);
  assert.equal(loaded.status,'unavailable');
  if(loaded.status==='unavailable')assert.equal(loaded.reason,'rangekeeper_open_runtime_adoption_unverified');
 }
});
