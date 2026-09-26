import assert from 'node:assert/strict';
import test from 'node:test';
import {principalAmounts,sqrtRatioAtTick} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {referenceProofHash,marketProfileSchema} from '../src/deployments/market-profile.js';
import {PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from '../src/deployments/paper-cost.js';
import {paperCloseConvertGasScopeHashV2,paperCloseConvertGasSizeBandV2,
 paperCloseConvertGasAllowanceStatesV2,PAPER_STATIC_CONVERT_GAS_STAGES_V2,
 type PaperCloseConvertGasScopeV2} from '../src/deployments/paper-close-convert-model.js';
import {persistTrustedStaticPaperCloseConvertPreview} from '../src/deployments/paper-close-convert-preflight.js';
import {buildPaperCloseRetainModel} from '../src/deployments/paper-close-model.js';
import {buildPaperCloseConvertModel,PAPER_STATIC_CONVERT_GAS_PATH,
 PAPER_STATIC_CONVERT_GAS_STAGES} from '../src/deployments/paper-close-convert-model.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {advanceEphemeralStaticPaperFeeCarry} from
 '../src/deployments/paper-close-convert-ephemeral-fees.js';

const campaignId='00000000-0000-4000-8000-000000000001',
 token0='0x1000000000000000000000000000000000000001',
 codeHash=`0x${'a'.repeat(64)}`,sourceHash=`0x${'2'.repeat(64)}`,
 now=Date.now(),nowSec=Math.floor(now/1000),tick=0,lower=-60,upper=60,
 profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
  pool:'0x8000000000000000000000000000000000000001',token0,token1:USDG,quoteToken:1,
  decimals0:18,decimals1:6,fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,
  router:PAPER_ROUTER,quoter:PAPER_QUOTER,poolCodeHash:codeHash,token0CodeHash:codeHash,
  token1CodeHash:codeHash,managerCodeHash:codeHash,quoterCodeHash:codeHash,
  reference0:'TOKEN/USD',reference1:'USDG/USD',nativeReference:'ETH/USD',numeraire:'USD'},
  referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}}),
 proof={fixture:true},proofHash=referenceProofHash(proof),
 openModel={schemaVersion:1 as const,kind:'paper_open_model' as const,campaignId,revision:1,
  strategyId:'static_manual_v1' as const,profileHash:contentHash(profile),configHash:'b'.repeat(64),
  candidateHash:'c'.repeat(64),source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:nowSec-30},
  poolState:{tick,sqrtPriceX96:String(sqrtRatioAtTick(tick)),poolLiquidity:'1000000000000'},
  referenceProof:proof,referenceProofHash:proofHash,reference:{price0:'1000000000000000000000000000000',
   price1:'1000000000000000000',nativePrice:'1000000000000000000'},
  allocation:{token0Raw:'1000000000000000000',token1Raw:'1000000',nativeWei:'1000000000000000000'},
  candidate:{range:{tickLower:lower,tickUpper:upper,fullWidthTicks:upper-lower},liquidity:'1000000',
   amount0Desired:'1000000000000',amount1Desired:'1000',amount0Minted:'1000000000000',amount1Minted:'1000',
   idle0:'0',idle1:'0',deployedValue:'1000000000',exposurePpm:'100',feeEarningAtEntry:true,
   oneSided:false,dilutedSharePpm:'100'},
  costs:{status:'provisional' as const,scope:'open_and_close_retain_gas_only' as const,
   pathVersion:PAPER_STATIC_GAS_PATH as 'paper_static_manual_no_swap_v1',sizeBand:'fixture',gasPriceWei:'1',boundGasPriceWei:'2',
   gasPriceObservedAt:new Date(now-1000).toISOString(),nativeReferencePrice:'1000000000000000000',
   stages:[],open:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},
   closeRetain:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},
   missing:[]}},
 frame={source:{block:'120',hash:sourceHash,timestamp:nowSec},tick,
  sqrtPriceX96:sqrtRatioAtTick(tick),poolLiquidity:1_000_000_000_000n,
  price0:1_000_000_000_000_000_000_000_000_000_000n,price1:1_000_000_000_000_000_000n,
  nativePrice:1_000_000_000_000_000_000n,referenceEligible:true,referenceReasons:[],
  referenceProofHash:proofHash,referenceProof:proof},
 state={openModel,openMarkId:'1',previous:{markId:'2',sourceBlock:'110',
  sourceHash:`0x${'3'.repeat(64)}`,source:{block:'110',hash:`0x${'3'.repeat(64)}`,timestamp:nowSec-10}},
  profile,profileHash:contentHash(profile),configHash:openModel.configHash,parameters:{limits:{maxSlippageBps:50}}};

function mockClient(output='999'){
 return {getChainId:async()=>4663,getBlock:async()=>({hash:frame.source.hash,timestamp:BigInt(frame.source.timestamp)}),
  simulateContract:async()=>({result:[BigInt(output)]})} as never;
}

test('terminal preview rejects prestate data unless the exact report and prospective rows are supplied',async()=>{
 const principal=(await import('../src/backtest/principal.js')).principalAmounts({liquidity:1_000_000n,
  tickLower:lower,tickUpper:upper,sqrtPriceX96:frame.sqrtPriceX96});
 const token0Raw=String(principal.amount0+1n),token1Raw=String(principal.amount1+1n),
  inputAmountRaw=token0Raw,routeBody={router:profile.pool.router,quoter:profile.pool.quoter,
   path:[profile.pool.token0,profile.pool.token1],fee:profile.pool.fee,inputAsset:'token0' as const,
   slippageBps:50,pathVersion:'paper_static_manual_close_convert_v1'},
  route={...routeBody,routeHash:contentHash(routeBody)},
  scope=({poolAddress:profile.pool.pool,profileHash:state.profileHash,openModelHash:contentHash(openModel),
   candidate:{deployedValue:openModel.candidate.deployedValue,sharePpm:openModel.candidate.dilutedSharePpm,
    tickLower:lower,tickUpper:upper,liquidity:openModel.candidate.liquidity},routeHash:route.routeHash,
   inputAsset:'token0',inputAmountRaw,inventory:{token0Raw,token1Raw},
   initialAllowances:{manager0:'0',manager1:'0',router0:'0',router1:'0'}} satisfies PaperCloseConvertGasScopeV2),
  wrongScope={...scope,inputAmountRaw:String(BigInt(inputAmountRaw)+1n),
   inventory:{...scope.inventory,token0Raw:String(BigInt(token0Raw)+1n)}} as PaperCloseConvertGasScopeV2,
  wrongHash=paperCloseConvertGasScopeHashV2(wrongScope),wrongSizeBand=paperCloseConvertGasSizeBandV2(wrongScope),
  wrongAllowances=paperCloseConvertGasAllowanceStatesV2(wrongScope),sequenceHash='d'.repeat(64),
  sampleTime=new Date(now-1000).toISOString(),gasProfiles=PAPER_STATIC_CONVERT_GAS_STAGES_V2.map((stage,index)=>{
   const source={block:frame.source.block,hash:frame.source.hash,estimatedAt:sampleTime,callHash:'0x'+String(index+1).repeat(64),
    method:'owned_fork_nitro_exact_call_v1' as const},
    model={schemaVersion:1 as const,source,gasUnitsExpected:'100',gasUnitsBound:'120',
     sizeMinValue:'0',sizeMaxValue:'2000000000',shareMinPpm:'0',shareMaxPpm:'1000000',
     tickLower:lower,tickUpper:upper,scopeHash:wrongHash,sequenceHash,stageIndex:index,
     stageCount:PAPER_STATIC_CONVERT_GAS_STAGES_V2.length};
   return {id:'00000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),version:1,
    poolAddress:profile.pool.pool,pathVersion:'paper_static_manual_close_convert_v2',stage,
   allowanceState:wrongAllowances[stage],sizeBand:wrongSizeBand,component:'gas_units',status:'provisional',
    evidenceClass:'fork_estimated',model,validation:{reportHash:'f'.repeat(64)},
    sourceHash:contentHash(source),observedUntil:new Date(sampleTime)};
  }),
  previousFeeCarry={kind:'paper_fee_carry_v1' as const,pool:profile.pool.pool,token0Address:profile.pool.token0,
   token1Address:profile.pool.token1,fee:profile.pool.fee,tickSpacing:profile.pool.tickSpacing,
   range:{tickLower:lower,tickUpper:upper},liquidity:openModel.candidate.liquidity,
   stream:'fixture',targetSetHash:'e'.repeat(64),from:{block:'100',hash:openModel.source.hash},
   through:{block:'110',hash:state.previous.sourceHash},token0:{
    lowerRawQ128:'340282366920938463463374607431768211456',
     upperRawQ128:'340282366920938463463374607431768211456',
    lowerAmountRaw:'1',upperAmountRaw:'1'},token1:{
    lowerRawQ128:'340282366920938463463374607431768211456',
    upperRawQ128:'340282366920938463463374607431768211456',
    lowerAmountRaw:'1',upperAmountRaw:'1'},intervals:1,events:0,segments:0,partialSegments:0,
   accounting:'modeled_hypothetical_fee_share' as const},
  postWithdraw={verificationClass:'owned_fork_close_convert_post_withdraw_v2' as const,
   reportHash:'f'.repeat(64),source:frame.source,postWithdrawReplayHash:'a'.repeat(64),
   withdrawCallHash:'0x'+'1'.repeat(64),quoterCallHash:'0x'+'2'.repeat(64),
   poolState:{tick,sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity)},
   balances:{token0:token0Raw,token1:token1Raw},quotedOutputRaw:'999',
   position:{liquidity:'0',tokensOwed0:'0',tokensOwed1:'0'}};
 const interval={kind:'paper_observed_flow_fee_interval_v1' as const,pool:profile.pool.pool,
  token0Address:profile.pool.token0,token1Address:profile.pool.token1,fee:profile.pool.fee,
  tickSpacing:profile.pool.tickSpacing,from:previousFeeCarry.through,
  to:{block:frame.source.block,hash:frame.source.hash},
  range:{tickLower:lower,tickUpper:upper},liquidity:openModel.candidate.liquidity,
  token0:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
  token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
  events:0,segments:0,partialSegments:0,accounting:'modeled_hypothetical_fee_share' as const,
  coverage:{stream:'fixture',targetSetHash:'e'.repeat(64),completeThroughBlock:frame.source.block,
   completeThroughHash:frame.source.hash,chainAnchorRecheckRequired:false as const}},
  advanced=advanceEphemeralStaticPaperFeeCarry({previous:previousFeeCarry,interval,
   sampleSource:frame.source,stream:'fixture',targetSetHash:'e'.repeat(64),opening:openModel.source}),
  replayBody={kind:'paper_close_convert_ephemeral_fee_replay_v1' as const,
   classification:'fork_estimated' as const,previousFeeEvidenceId:'3',from:interval.from,to:interval.to,
   stream:'fixture',targetSetHash:'e'.repeat(64),interval,intervalHash:advanced.intervalHash,
   previousFeeCarryHash:contentHash(previousFeeCarry),feeCarry:advanced.feeCarry,
   feeCarryHash:advanced.feeCarryHash},feeReplay={...replayBody,replayHash:contentHash(replayBody)};
 let writes=0;
 const ownedForkReplay=(profiles:typeof gasProfiles)=>({reportHash:postWithdraw.reportHash,
  postWithdrawReplayHash:postWithdraw.postWithdrawReplayHash,sourceReplayHash:'b'.repeat(64),
  source:frame.source,gasScopeHash:'c'.repeat(64),gasSequenceHash:'d'.repeat(64),
  gasStages:profiles.map(row=>{const model=row.model as {source:{block:string;hash:string;
   estimatedAt:string;callHash:string;method:'owned_fork_nitro_exact_call_v1'};
   gasUnitsExpected:string;gasUnitsBound:string};return {stage:row.stage,source:model.source,
    sourceHash:contentHash(model.source),callHash:model.source.callHash,
    gasUnitsExpected:model.gasUnitsExpected,gasUnitsBound:model.gasUnitsBound};})});
 await assert.rejects(persistTrustedStaticPaperCloseConvertPreview({store:{recordPreview:async()=>{
   writes++;return {id:'00000000-0000-4000-8000-000000000099',contentDigest:'a'.repeat(64),expiresAt:new Date(now+60_000)};
  }},state,frame,previousFeeCarry,feeReplay,feeEvidence:{id:'3',
   proofHash:'4'.repeat(64),carryHash:contentHash(previousFeeCarry)},
  postWithdraw,client:mockClient(),verifyPersistedContext:async()=>{},verifyAnchors:async()=>{},
  verifyOwnedFork:async()=>ownedForkReplay(gasProfiles),
  prestateCostProfiles:gasProfiles,prestateReport:null,gasPriceWei:1_000_000_000n,now}));
 assert.equal(writes,0,'invalid prestate evidence must fail before preview persistence');
});

test('centered static parameters reuse the frozen open range for retain and convert builders',()=>{
 const centered={halfWidthTicks:120,limits:{maxDeploymentValue:'1000000000',minDeploymentValue:'0',
  maxExposurePpm:1_000_000,maxLossValue:'1000000000',maxDrawdownPpm:1_000_000,
  maxActionCost:'1000000000',maxRollingCost:'1000000000',maxCampaignCost:'1000000000',
  exitReserveWei:'1',maxSlippageBps:50}},
  centeredState={...state,parameters:centered},
  openCosts={...openModel.costs,stages:PAPER_STATIC_GAS_STAGES.map((stage,index)=>({stage,
   profileId:`00000000-0000-4000-8000-${String(index+20).padStart(12,'0')}`,version:1,
   evidenceClass:'fork_estimated' as const,expectedGasUnits:'1',boundGasUnits:'1',
   source:{block:frame.source.block,hash:frame.source.hash,estimatedAt:new Date(now-1000).toISOString(),
    callHash:`0x${String(index+1).repeat(64)}`,method:'owned_fork_nitro_exact_call_v1' as const}}))},
  costed={status:'indicative' as const,candidate:openModel.candidate,costs:openCosts},
  previous={markId:'2',sourceBlock:'110',sourceHash:`0x${'3'.repeat(64)}`},
  retained=buildPaperCloseRetainModel(openModel,'1',previous,frame,profile,centered,costed,now);
 const frozenPrincipal=principalAmounts({liquidity:BigInt(openModel.candidate.liquidity),
  tickLower:openModel.candidate.range.tickLower,tickUpper:openModel.candidate.range.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96});
 assert.deepEqual(retained.principal,{amount0Raw:String(frozenPrincipal.amount0),
  amount1Raw:String(frozenPrincipal.amount1)});

 const routeBody={router:profile.pool.router,quoter:profile.pool.quoter,
  path:[profile.pool.token0,profile.pool.token1],fee:profile.pool.fee,inputAsset:'token0' as const,
  slippageBps:50,pathVersion:PAPER_STATIC_CONVERT_GAS_PATH},
  route={...routeBody,routeHash:contentHash(routeBody)},
  gasPriceObservedAt=new Date(now-1000).toISOString(),stages=PAPER_STATIC_CONVERT_GAS_STAGES.map((stage,index)=>({
   stage,profileId:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
   version:1,evidenceClass:'fork_estimated' as const,expectedGasUnits:'1',boundGasUnits:'1',
   source:{block:frame.source.block,hash:frame.source.hash,estimatedAt:gasPriceObservedAt,
    callHash:`0x${String(index+1).repeat(64)}`,method:'owned_fork_nitro_exact_call_v1' as const},
  }));
 const costs={status:'provisional' as const,scope:'convert_close_gas_only' as const,
  pathVersion:PAPER_STATIC_CONVERT_GAS_PATH,sizeBand:'fixture',gasPriceWei:'1',boundGasPriceWei:'2',
  gasPriceObservedAt,nativeReferencePrice:String(frame.nativePrice),stages,expectedGasUnits:'4',
  boundGasUnits:'4',expectedWei:'4',boundWei:'8',expectedValue:'4',boundValue:'8'};
 const converted=buildPaperCloseConvertModel(openModel,'1',previous,frame,profile,centered,
  route,costs,now);
 assert.deepEqual(converted.principal,{amount0Raw:String(frozenPrincipal.amount0),
  amount1Raw:String(frozenPrincipal.amount1)});
 assert.equal(centeredState.parameters.halfWidthTicks,120);
});
