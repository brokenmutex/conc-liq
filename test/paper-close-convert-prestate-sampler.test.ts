import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeFunctionData,keccak256} from 'viem';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {PAPER_STATIC_GAS_PATH} from '../src/deployments/paper-cost.js';
import {verifyPaperCloseConvertPrestateReport} from '../src/deployments/paper-close-convert-prestate-sampler.js';
import {buildProspectivePaperCloseConvertPrestateGasProfiles,
 PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1} from
 '../src/deployments/paper-close-convert-prestate-gas-profiles.js';
import {selectPaperCloseConvertPrestateCostsV1} from
 '../src/deployments/paper-close-convert-prestate-costs.js';
import {PAPER_ACCOUNT,PAPER_QUOTER,PAPER_ROUTER,paperRouterAbi,paperTokenAbi} from '../src/paper/execution-abi.js';
import {PAPER_STATIC_CONVERT_GAS_STAGES_V2} from '../src/deployments/paper-close-convert-model.js';

const campaignId='00000000-0000-4000-8000-000000000001',
 token0='0x1000000000000000000000000000000000000001',
 codeHash=`0x${'a'.repeat(64)}`,sourceHash=`0x${'2'.repeat(64)}`,
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
 openModel={schemaVersion:1,kind:'paper_open_model',campaignId,revision:1,
  strategyId:'static_manual_v1',profileHash:contentHash(profile),configHash:'b'.repeat(64),
  candidateHash:'c'.repeat(64),source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:1000},
  poolState:{tick:0,sqrtPriceX96:String(sqrtRatioAtTick(0)),poolLiquidity:'1000000'},
  referenceProof:proof,referenceProofHash:proofHash,reference:{price0:'100',price1:'100',nativePrice:'100'},
  allocation:{token0Raw:'100',token1Raw:'100',nativeWei:'100'},
  candidate:{range:{tickLower:-60,tickUpper:60,fullWidthTicks:120},liquidity:'1000',
   amount0Desired:'100',amount1Desired:'100',amount0Minted:'100',amount1Minted:'100',
   idle0:'0',idle1:'0',deployedValue:'100',exposurePpm:'1',feeEarningAtEntry:true,
   oneSided:false,dilutedSharePpm:'1'},
  costs:{status:'provisional',scope:'open_and_close_retain_gas_only',pathVersion:PAPER_STATIC_GAS_PATH,
   sizeBand:'fixture',gasPriceWei:'1',boundGasPriceWei:'1',gasPriceObservedAt:new Date(1000).toISOString(),
   nativeReferencePrice:'1',stages:Array.from({length:6},(_,i)=>({stage:`fixture_${i}`,
    profileId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,version:1,
    evidenceClass:'fork_estimated',expectedGasUnits:'1',boundGasUnits:'1',source:{block:'100',
     hash:`0x${'1'.repeat(64)}`,estimatedAt:new Date(1000).toISOString(),
     callHash:`0x${'2'.repeat(64)}`,method:'owned_fork_nitro_exact_call_v1'}})),
   open:{expectedGasUnits:'0',boundGasUnits:'0',expectedWei:'0',boundWei:'0',expectedValue:'0',boundValue:'0'},
   closeRetain:{expectedGasUnits:'0',boundGasUnits:'0',expectedWei:'0',boundWei:'0',expectedValue:'0',boundValue:'0'},
   missing:[]}} as Record<string,any>,
 frame={source:{block:'120',hash:sourceHash,timestamp:1020},tick:0,sqrtPriceX96:String(sqrtRatioAtTick(0)),
  poolLiquidity:'1000000',price0:'100',price1:'100',nativePrice:'100',referenceEligible:true,
  referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof},
 routeBody={router:PAPER_ROUTER,quoter:PAPER_QUOTER,path:[token0,USDG],fee:3000,
  inputAsset:'token0' as const,slippageBps:50,pathVersion:'paper_static_manual_close_convert_v1'},
 route={...routeBody,routeHash:contentHash(routeBody)},
 quoteBody={schemaVersion:1,kind:'paper_exact_input_quote_v1',source:frame.source,
  router:route.router,quoter:route.quoter,path:route.path,fee:route.fee,inputAsset:route.inputAsset,
  inputAmountRaw:'100',expectedOutputRaw:'90',minimumOutputRaw:'89',slippageBps:50,
  pathVersion:route.pathVersion},quote={...quoteBody,quoteHash:contentHash(quoteBody)};

export function validReport(){
 const inventory={principal0Raw:'80',principal1Raw:'10',idle0Raw:'10',idle1Raw:'20',
  fee0Raw:'10',fee1Raw:'5',token0Raw:'100',token1Raw:'35',inputAsset:'token0',inputAmountRaw:'100'},
  postWithdrawReplayBody={poolState:{tick:0,sqrtPriceX96:frame.sqrtPriceX96,poolLiquidity:'1000'},
   balances:{token0:'100',token1:'35'},withdrawCallHash:'0x'+'1'.repeat(64),
   quoterCallHash:'0x'+'2'.repeat(64),quotedOutputRaw:'90',
   position:{liquidity:'0',tokensOwed0:'0',tokensOwed1:'0'}},
  replay={...postWithdrawReplayBody,replayHash:contentHash(postWithdrawReplayBody)},
  feeReplay={kind:'paper_close_convert_ephemeral_fee_replay_v1',classification:'fork_estimated',
   previousFeeEvidenceId:'1',from:{block:'110',hash:'0x'+'3'.repeat(64)},
   to:{block:frame.source.block,hash:frame.source.hash},stream:'fee-stream',
   targetSetHash:'0x'+'4'.repeat(64),intervalHash:'e'.repeat(64),previousFeeCarryHash:'f'.repeat(64),
   feeCarryHash:'d'.repeat(64),replayHash:'9'.repeat(64)},
  initialAllowance={manager0:'10',manager1:'20',router0:'0',router1:'0'},
  initialBalance={token0:'20',token1:'25'},
  definitions=[
   {stage:'withdraw_collect',to:profile.pool.positionManager,calldata:'0x1234',
    allowancesAfter:initialAllowance,balancesAfter:{token0:'100',token1:'35'}},
   {stage:'approve_swap_input',to:token0,calldata:encodeFunctionData({abi:paperTokenAbi,
    functionName:'approve',args:[PAPER_ROUTER,100n]}),
    allowancesAfter:{...initialAllowance,router0:'100'},balancesAfter:{token0:'100',token1:'35'}},
   {stage:'swap',to:PAPER_ROUTER,calldata:encodeFunctionData({abi:paperRouterAbi,functionName:'multicall',
    args:[1320n,[encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{
     tokenIn:token0,tokenOut:USDG,fee:3000,recipient:PAPER_ACCOUNT,amountIn:100n,
     amountOutMinimum:89n,sqrtPriceLimitX96:0n}]} )]]}),allowancesAfter:initialAllowance,
    balancesAfter:{token0:'0',token1:'125'}},
   ...(['cleanup_manager_token0','cleanup_manager_token1','cleanup_router_token0',
    'cleanup_router_token1'] as const).map((stage,index)=>({stage,
    to:index===0||index===2?token0:USDG,
    calldata:encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[
     index<2?profile.pool.positionManager:PAPER_ROUTER,0n]}),
    allowancesAfter:{manager0:'0',manager1:index===0?'20':'0',router0:'0',router1:'0'},
    balancesAfter:{token0:'0',token1:'125'}}))
  ],
  gasScope={campaignId,revision:1,openMarkId:'1',latestMarkId:'2',openModelHash:contentHash(openModel),
   profileHash:contentHash(profile),feeCarryHash:'d'.repeat(64),feeReplayHash:feeReplay.replayHash,
   source:frame.source,routeHash:route.routeHash,inventory,quoteHash:quote.quoteHash,
   initialAllowances:initialAllowance},gasScopeHash=contentHash(gasScope),
  gasStages=definitions.map((definition,index)=>{
   const callHash=keccak256(definition.calldata as `0x${string}`),source={block:frame.source.block,
    hash:frame.source.hash,estimatedAt:new Date(frame.source.timestamp*1000).toISOString(),callHash,
    method:'owned_fork_nitro_exact_call_v1'},estimate={gas:'100000',parentGas:'0',baseFeeWei:'100',
    parentBaseFeeWei:'0',totalFeeWei:'10000000',parentFeeWei:'0',executionFeeWei:'10000000',
    basis:'node_estimateGas_with_paper_prestate_and_parent_component'},
    allowancesBefore=index===0?initialAllowance:definitions[index-1]!.allowancesAfter,
    balancesBefore=index===0?initialBalance:definitions[index-1]!.balancesAfter;
   return {stage:definition.stage,source,sourceHash:contentHash(source),callHash,to:definition.to,
    calldata:definition.calldata,returnData:'0x',localHash:'0x'+'a'.repeat(64),localGasUsed:'100000',
    localEffectiveGasPriceWei:'100',estimate,allowancesBefore,allowancesAfter:definition.allowancesAfter,
    balancesBefore,balancesAfter:definition.balancesAfter,gasUnitsExpected:'100000',gasUnitsBound:'130000',
    scopeHash:gasScopeHash,sequenceHash:'0'.repeat(64),stageIndex:index};
  }),gasSequenceHash=contentHash(gasStages.map(stage=>({stage:stage.stage,callHash:stage.callHash,
   sourceHash:stage.sourceHash,allowancesBefore:stage.allowancesBefore,
   allowancesAfter:stage.allowancesAfter,balancesBefore:stage.balancesBefore,
   balancesAfter:stage.balancesAfter})));
  for(const stage of gasStages)stage.sequenceHash=gasSequenceHash;
  const body={schemaVersion:1,kind:'paper_close_convert_prestate_report_v1',campaignId,revision:1,
   profile,profileHash:contentHash(profile),openModel,openModelHash:contentHash(openModel),
   openMarkId:'1',previousMarkId:'2',previousSource:{block:'110',hash:`0x${'3'.repeat(64)}`,timestamp:1010},
   frame,route,feeCarryHash:'d'.repeat(64),feeReplay,gasScopeHash,gasSequenceHash,gasStages,
   inventory,quote,withdrawCalldata:'0x1234',quoteCalldata:'0xabcd',
   simulationPrestate:{nativeBalanceWei:'1000000000000000000',allowances:[]},
   postWithdrawReplay:replay,limitations:['owned_fork_restore_is_not_a_paper_fill',
    'inventory_is_simulated_not_canonical_custody','fee_carry_requires_persisted_replay',
    'v2_worker_acceptance_replay_unavailable','sampler_share_cap_is_one_percent',
    'native_fork_funding_is_simulation_only']},
  reportHash=contentHash(body),postWithdraw={verificationClass:'owned_fork_close_convert_post_withdraw_v2',
   reportHash,source:frame.source,postWithdrawReplayHash:replay.replayHash,
   withdrawCallHash:replay.withdrawCallHash,quoterCallHash:replay.quoterCallHash,
   poolState:replay.poolState,balances:replay.balances,quotedOutputRaw:'90',position:replay.position},
  sourceReplayHash=contentHash({kind:'paper_close_convert_prestate_source_replay_v1',reportHash,
   source:frame.source,openModelHash:contentHash(openModel),feeCarryHash:'d'.repeat(64),
   postWithdrawReplayHash:replay.replayHash,quoteHash:quote.quoteHash});
 return {...body,reportHash,postWithdraw,sourceReplayHash};
}

test('prestate sampler verifier accepts only report-bound simulated inventory and quote',()=>{
 const report=validReport();
 assert.equal(verifyPaperCloseConvertPrestateReport(report).reportHash,report.reportHash);
 const prospective=buildProspectivePaperCloseConvertPrestateGasProfiles(report);
 assert.equal(prospective.pathVersion,PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1);
 assert.equal(prospective.profiles.length,7);assert.equal(prospective.actionAvailable,false);
 assert(prospective.profiles.every(profile=>profile.status==='provisional'&&
  profile.evidenceClass==='fork_estimated'&&profile.validation.reportHash===report.reportHash));
 assert.equal('terminalMarkId' in report,false);
 const changedInventory={...report,inventory:{...report.inventory,token0Raw:'101'}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedInventory));
 const changedQuote={...report,quote:{...report.quote,expectedOutputRaw:'91'}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedQuote));
 const changedFeeReplay={...report,feeReplay:{...report.feeReplay,intervalHash:'a'.repeat(64)}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedFeeReplay));
});

test('prospective cost selector accepts only the exact seven report-bound prestate rows',()=>{
 const report=validReport(),prospective=buildProspectivePaperCloseConvertPrestateGasProfiles(report),
  version=3,rows=prospective.profiles.map((profile,index)=>({id:
   `00000000-0000-4000-8000-${String(index+11).padStart(12,'0')}`,version,
   poolAddress:profile.poolAddress,pathVersion:profile.pathVersion,stage:profile.stage,
   allowanceState:profile.allowanceState,sizeBand:profile.sizeBand,component:profile.component,
   status:profile.status,evidenceClass:profile.evidenceClass,model:profile.model,
   validation:{...profile.validation,actionAvailable:false},sourceHash:profile.sourceHash,
   observedUntil:profile.observedUntil})),
  gasPriceObservedAt=new Date(report.frame.source.timestamp*1000).toISOString(),now=Date.parse(gasPriceObservedAt);
 const costs=selectPaperCloseConvertPrestateCostsV1({report,rows,gasPriceWei:100n,
  gasPriceObservedAt,now});
 assert.equal(costs.kind,'paper_close_convert_prestate_costs_v1');
 assert.equal(costs.pathVersion,PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1);
 assert.equal(costs.stages.length,7);assert.equal(costs.paidGasAvailable,false);
 assert(costs.stages.every(stage=>stage.version===version&&stage.evidenceClass==='fork_estimated'));
 assert.throws(()=>selectPaperCloseConvertPrestateCostsV1({report,
  rows:rows.map(row=>({...row,pathVersion:'paper_static_manual_close_convert_v2'})),
  gasPriceWei:100n,gasPriceObservedAt,now}),/paper_close_convert_prestate_cost_profiles_unavailable/);
 assert.throws(()=>selectPaperCloseConvertPrestateCostsV1({report,rows:rows.slice(1),
  gasPriceWei:100n,gasPriceObservedAt,now}),/paper_close_convert_prestate_cost_profiles_unavailable/);
});
