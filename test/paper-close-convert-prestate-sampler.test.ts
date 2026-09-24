import assert from 'node:assert/strict';
import test from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {PAPER_STATIC_GAS_PATH} from '../src/deployments/paper-cost.js';
import {verifyPaperCloseConvertPrestateReport} from '../src/deployments/paper-close-convert-prestate-sampler.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';

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
   nativeReferencePrice:'1',stages:[],open:{},closeRetain:{},missing:[]}} as Record<string,any>,
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

function validReport(){
 const inventory={principal0Raw:'80',principal1Raw:'10',idle0Raw:'10',idle1Raw:'20',
  fee0Raw:'10',fee1Raw:'5',token0Raw:'100',token1Raw:'35',inputAsset:'token0',inputAmountRaw:'100'},
  postWithdrawReplayBody={poolState:{tick:0,sqrtPriceX96:frame.sqrtPriceX96,poolLiquidity:'1000'},
   balances:{token0:'100',token1:'35'},withdrawCallHash:'0x'+'1'.repeat(64),
   quoterCallHash:'0x'+'2'.repeat(64),quotedOutputRaw:'90',
   position:{liquidity:'0',tokensOwed0:'0',tokensOwed1:'0'}},
  replay={...postWithdrawReplayBody,replayHash:contentHash(postWithdrawReplayBody)},
  body={schemaVersion:1,kind:'paper_close_convert_prestate_report_v1',campaignId,revision:1,
   profile,profileHash:contentHash(profile),openModel,openModelHash:contentHash(openModel),
   openMarkId:'1',previousMarkId:'2',previousSource:{block:'110',hash:`0x${'3'.repeat(64)}`,timestamp:1010},
   frame,route,feeCarryHash:'d'.repeat(64),inventory,quote,withdrawCalldata:'0x1234',quoteCalldata:'0xabcd',
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
 assert.equal('terminalMarkId' in report,false);
 const changedInventory={...report,inventory:{...report.inventory,token0Raw:'101'}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedInventory));
 const changedQuote={...report,quote:{...report.quote,expectedOutputRaw:'91'}};
 assert.throws(()=>verifyPaperCloseConvertPrestateReport(changedQuote));
});
