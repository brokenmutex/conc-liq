import assert from 'node:assert/strict';
import test from 'node:test';
import {amountsForLiquidity,sqrtRatioAtTick} from '../src/backtest/principal.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY,USDG} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {resolveRangeKeeperPaperPolicy} from '../src/deployments/rangekeeper-paper-open-model.js';
import type {RangeKeeperPaperOpenModel} from '../src/deployments/rangekeeper-paper-open-model.js';
import {buildRangeKeeperPaperExitModel,rangeKeeperPaperExitInventoryProofHash}
 from '../src/deployments/rangekeeper-paper-exit-model.js';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion}
 from '../src/deployments/rangekeeper-paper-cost.js';
import {replayPaperMint} from '../src/v3/position-math.js';

const address=(digit:string)=>`0x${digit.repeat(40)}`;
const hash=(digit:string)=>`0x${digit.repeat(64)}`;
const now=Date.now(),timestamp=Math.floor(now/1000)-10;
const source=(block:string,which:string)=>({block,hash:hash(which),timestamp});
const openSource=source('100','1'),priorSource=source('101','2'),frameSource=source('102','3');
const proof={fixture:'exit-model-current-epoch'},proofHash=referenceProofHash(proof);
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
 maxSwapInputValue:String(10n*10n**18n),maxSwapInputPpm:1_000_000,maxSwapShortfallValue:String(10n**18n),
 maxSlippageBps:50,maxActionCost:String(5n*10n**18n),maxRollingCost:String(8n*10n**18n),
 maxCampaignCost:String(16n*10n**18n),maxExposurePpm:1_000_000,maxLossValue:String(10n*10n**18n),
 maxDrawdownPpm:1_000_000,maxRecenters:5,maxLiquiditySharePpm:1_000_000,
 maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'}},
 configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
 allocation={token0Raw:String(10n**18n),token1Raw:String(10n**18n),nativeWei:'1000000000000000'},
 draft={id:campaignId,revision,allocation,profile,profileHash,configHash,strategyId:'rangekeeper_v1' as const,parameters},
 policy=resolveRangeKeeperPaperPolicy(draft,buildId);
assert(policy.policy&&!policy.unavailable.length);
const range={tickLower:-600,tickUpper:600},mintSqrt=sqrtRatioAtTick(0),mint=replayPaperMint(mintSqrt,range,
 BigInt(allocation.token0Raw),BigInt(allocation.token1Raw),0n),position={tickLower:range.tickLower,
 tickUpper:range.tickUpper,liquidity:String(mint.liquidity)},idle={token0:String(BigInt(allocation.token0Raw)-mint.amount0),
 token1:String(BigInt(allocation.token1Raw)-mint.amount1)};
const openCandidate={kind:'entry' as const,range,swap:null,amount0Desired:BigInt(allocation.token0Raw),
 amount1Desired:BigInt(allocation.token1Raw),amount0Min:0n,amount1Min:0n,liquidity:mint.liquidity,
 deployedValue:2n*10n**18n,sourceBlock:100n,sourceHash:openSource.hash as `0x${string}`,expiresAt:timestamp+60};
const openCandidateHash=rangeKeeperPaperCandidateHash({campaignId,revision,profileHash,configHash,source:openSource,
 referenceProofHash:proofHash,candidate:openCandidate});
const candidate={...openCandidate,kind:'recenter' as const,sourceBlock:101n,
 sourceHash:priorSource.hash as `0x${string}`};
const candidateHash=rangeKeeperPaperCandidateHash({campaignId,revision,profileHash,configHash,source:priorSource,
 referenceProofHash:proofHash,candidate});
const openModel={kind:'rangekeeper_paper_open_model' as const,status:'indicative' as const,actionAvailable:false,
 campaignId,revision,strategyId:'rangekeeper_v1' as const,strategyVersion:'1.0.0',draftConfigHash:configHash,
 profileHash,kernelPolicyHash:policy.policy!.policyHash,kernelBuildId:buildId,source:openSource,
 poolState:{tick:0,sqrtPriceX96:String(mintSqrt),poolLiquidity:String(10n**24n)},reference:{price0:'1000000000000000000',
 price1:'1000000000000000000',nativePrice:'1000000000000000000',eligible:true,proofHash,proof,reasons:[]},
 decision:{requiresSecondObservation:true},candidate:{kind:'entry',range,swap:null,amount0Desired:String(openCandidate.amount0Desired),
 amount1Desired:String(openCandidate.amount1Desired),amount0Min:'0',amount1Min:'0',liquidity:String(openCandidate.liquidity),
 deployedValue:String(openCandidate.deployedValue),sourceBlock:'100',sourceHash:openSource.hash,expiresAt:openCandidate.expiresAt},
 candidateHash:openCandidateHash} as unknown as RangeKeeperPaperOpenModel;
const priorPrincipal=amountsForLiquidity({liquidity:mint.liquidity,sqrtPriceX96:mintSqrt,
 sqrtRatioAX96:sqrtRatioAtTick(range.tickLower),sqrtRatioBX96:sqrtRatioAtTick(range.tickUpper)}),
 currentSqrt=sqrtRatioAtTick(0),currentPrincipal=priorPrincipal;
const frame:PaperOpenFrame={source:frameSource,tick:0,sqrtPriceX96:currentSqrt,poolLiquidity:10n**24n,
 price0:10n**18n,price1:10n**30n,nativePrice:2_000n*10n**18n,referenceEligible:true,
 referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof};
const currentEpoch={epoch:1,markId:'2',markHash:'8'.repeat(64),source:priorSource,candidate,candidateHash,
 candidateReferenceProofHash:proofHash,inventory:{position,idle},kernelSnapshot:{},mintSqrtPriceX96:mintSqrt,
 allowancesCleared:true,fundingBeforeSwap:{token0:allocation.token0Raw,token1:allocation.token1Raw},
 reference:{price0:10n**18n,price1:10n**18n,nativePrice:10n**18n,proofHash,proof}};
const previous={id:'2',source:priorSource,candidateHash,position,idle};
const kernelBase={state:{schemaVersion:1 as const,policyId:'rangekeeper_v1' as const,strategyVersion:'1.0.0' as const,
 configHash:`0x${policy.policy!.policyHash}` as `0x${string}`,buildId,
 lastEligible:{block:101n,hash:priorSource.hash as `0x${string}`,timestamp:priorSource.timestamp},confirmation:null,exit:null},
 source:frameSource,inventoryProofHash:'9'.repeat(64),wallet0:BigInt(idle.token0),wallet1:BigInt(idle.token1),
 released0:currentPrincipal.amount0,released1:currentPrincipal.amount1,nativeWei:BigInt(allocation.nativeWei),
 campaignStartValue:2n*10n**18n,highWaterValue:2n*10n**18n,rollingSpentCost:0n,campaignSpentCost:0n,
 reservedCost:0n,recenters:1,pending:false,entryAllowed:false,safeExitRequired:false,executionReady:false};
const kernel={...kernelBase,inventoryProofHash:rangeKeeperPaperExitInventoryProofHash({campaignId,revision,
 openMarkId:'1',openModelHash:contentHash(openModel),candidateHash,currentEpoch,kernel:kernelBase,previous})};

test('exit model parses a typed current-epoch candidate and queries only its scoped gas profiles',async()=>{
 const reads:unknown[]=[],historicalBuildId='a'.repeat(64),adoptedOpenModel={...openModel,
  kernelBuildId:historicalBuildId},adoptedKernelBase={...kernel,state:{...kernel.state,buildId:historicalBuildId}},
  adoptedKernel={...adoptedKernelBase,inventoryProofHash:rangeKeeperPaperExitInventoryProofHash({campaignId,
   revision,openMarkId:'1',openModelHash:contentHash(adoptedOpenModel),candidateHash,currentEpoch,
   kernel:adoptedKernelBase,previous})};
 const model=await buildRangeKeeperPaperExitModel({client:{} as never,draft,openModel:adoptedOpenModel,currentEpoch,
  openMarkId:'1',previous,frame,buildId,exitKind:'retain',kernel:adoptedKernel,marketGasPriceWei:1n,
  marketGasPriceObservedAt:now,now,simulate:async()=>true,readGasProfiles:async query=>{reads.push(query);return [];}});
 assert.equal(model.kind,'rangekeeper_paper_exit_model');
 assert.equal(model.candidateHash,candidateHash);
 assert.equal(model.position.liquidity,String(candidate.liquidity),model.blockingReason);
 assert.equal(reads.length,1);
 const query=reads[0] as {poolAddress:string;pathVersion:string;sizeBand:string};
 assert.equal(query.poolAddress,profile.pool.pool);
 assert.equal(query.pathVersion,rangeKeeperPaperPathVersion(candidate));
 assert.equal(typeof query.sizeBand,'string');assert(query.sizeBand.length>0);
 assert.equal(model.status,'blocked','empty scoped gas profiles must remain fail-closed');
 assert.equal(model.kernelBuildId,historicalBuildId,'the historical kernel identity must remain immutable after adoption');
 assert.equal(model.actionAvailable,false);
});

test('exit model rejects a tampered current-epoch candidate before gas lookup',async()=>{
 let reads=0;
 const changed={...currentEpoch,candidate:{...candidate,liquidity:candidate.liquidity+1n}};
 const model=await buildRangeKeeperPaperExitModel({client:{} as never,draft,openModel,currentEpoch:changed,
  openMarkId:'1',previous,frame,buildId,exitKind:'retain',kernel,marketGasPriceWei:1n,
  marketGasPriceObservedAt:now,now,simulate:async()=>true,readGasProfiles:async()=>{reads++;return [];}});
 assert.equal(model.kind,'rangekeeper_paper_exit_model');
 assert.equal(model.status,'blocked');
 assert.match(model.blockingReason,/rangekeeper_current_candidate_identity_mismatch|rangekeeper_current_epoch_mark_or_inventory_invalid|rangekeeper_current_epoch_baseline_mismatch/);
 assert.equal(reads,0);
});
