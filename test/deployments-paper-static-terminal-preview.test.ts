import assert from 'node:assert/strict';
import test from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {referenceProofHash,marketProfileSchema} from '../src/deployments/market-profile.js';
import {PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from '../src/deployments/paper-cost.js';
import {buildPaperStaticRetainTerminalPreview} from '../src/deployments/paper-static-terminal-preview.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';

const campaignId='00000000-0000-4000-8000-000000000001';
const token0='0x1000000000000000000000000000000000000001';
const codeHash=`0x${'a'.repeat(64)}`;
const tick=-276324,lower=-276360,upper=-276300;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0,token1:USDG,quoteToken:1,
 decimals0:18,decimals1:6,fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,
 router:PAPER_ROUTER,quoter:PAPER_QUOTER,poolCodeHash:codeHash,token0CodeHash:codeHash,
 token1CodeHash:codeHash,managerCodeHash:codeHash,quoterCodeHash:codeHash,
 reference0:'TOKEN/USD',reference1:'USDG/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
  token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
const now=Date.now(),nowSec=Math.floor(now/1000),proof={fixture:true},proofHash=referenceProofHash(proof);
const openModel={schemaVersion:1 as const,kind:'paper_open_model' as const,campaignId,revision:1,
 strategyId:'static_manual_v1' as const,profileHash:contentHash(profile),configHash:'b'.repeat(64),
 candidateHash:'c'.repeat(64),source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:nowSec-30},
 poolState:{tick,sqrtPriceX96:String(sqrtRatioAtTick(tick)),poolLiquidity:'1000000000000'},
 referenceProof:proof,referenceProofHash:proofHash,reference:{price0:'1000000000000000000',
  price1:'1000000000000000000',nativePrice:'2000000000000000000000'},
 allocation:{token0Raw:'1000000000000000000',token1Raw:'1000000',nativeWei:'1000000000000000000'},
 candidate:{range:{tickLower:lower,tickUpper:upper,fullWidthTicks:upper-lower},liquidity:'1000000',
  amount0Desired:'1000000000000',amount1Desired:'1000',amount0Minted:'1000000000000',amount1Minted:'1000',
  idle0:'0',idle1:'0',deployedValue:'1000000000',exposurePpm:'100',feeEarningAtEntry:true,
  oneSided:false,dilutedSharePpm:'100'},
 costs:{status:'provisional' as const,scope:'open_and_close_retain_gas_only' as const,
  pathVersion:PAPER_STATIC_GAS_PATH,sizeBand:'saved_position_scope',gasPriceWei:'1000000000',
  boundGasPriceWei:'1250000000',gasPriceObservedAt:new Date(now-10_000).toISOString(),
  nativeReferencePrice:'2000000000000000000000',stages:PAPER_STATIC_GAS_STAGES.map((stage,index)=>({stage,
   profileId:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,version:1,
   evidenceClass:'fork_estimated',expectedGasUnits:'1',boundGasUnits:'1',
   source:{block:'100',hash:`0x${'1'.repeat(64)}`,estimatedAt:new Date(now-10_000).toISOString(),
    callHash:`0x${String(index+1).repeat(64)}`,method:'owned_fork_nitro_exact_call_v1' as const}})),
 open:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},
  closeRetain:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},missing:[]}};
const frame={source:{block:'120',hash:`0x${'2'.repeat(64)}`,timestamp:nowSec},tick,
 sqrtPriceX96:sqrtRatioAtTick(tick),poolLiquidity:1_000_000_000_000n,
 price0:1_000_000_000_000_000_000n,price1:1_000_000_000_000_000_000n,
 nativePrice:2_000_000_000_000_000_000_000n,referenceEligible:true,referenceReasons:[],
 referenceProofHash:proofHash,referenceProof:proof};
const gasProfiles=PAPER_STATIC_GAS_STAGES.map((stage,index)=>{
 const sampledAt=new Date(now-10_000).toISOString(),source={block:'119',hash:`0x${'3'.repeat(64)}`,
  estimatedAt:sampledAt,callHash:`0x${String(index+1).repeat(64)}`,method:'owned_fork_nitro_exact_call_v1' as const};
 const model={schemaVersion:1 as const,source,gasUnitsExpected:'100000',gasUnitsBound:'120000',
  sizeMinValue:'1000000000',sizeMaxValue:'1000000000',shareMinPpm:'100',shareMaxPpm:'100',
  tickLower:lower,tickUpper:upper};
 return {id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,version:1,
  poolAddress:profile.pool.pool,pathVersion:PAPER_STATIC_GAS_PATH,stage,allowanceState:'zero',
  sizeBand:'saved_position_scope',component:'gas_units',status:'provisional',evidenceClass:'fork_estimated',
  model,sourceHash:contentHash(source),observedUntil:new Date(sampledAt)};
});
const input={campaignId,openMarkId:'1',previous:{markId:'2',sourceBlock:'110',sourceHash:`0x${'4'.repeat(64)}`},
 openModel,profile,frame,gasProfiles,gasPriceWei:1_000_000_000n,now};

test('static retain preview values the saved open candidate at a canonical later frame',()=>{
 const result=buildPaperStaticRetainTerminalPreview(input);
 assert.equal(result.status,'indicative',JSON.stringify(result));
 assert.equal(result.kind,'close_retain');
 assert.equal(result.actionAvailable,false);
 assert.equal(result.draftCreationAvailable,false);
 assert.equal(result.source?.block,'120');
 assert(result.retainedLowerBound);
 assert.equal(result.costs?.scope,'saved_open_candidate_close_retain_stages_only');
 assert.deepEqual(result.missing,['stored_static_limits_unavailable','fee_capture_unavailable',
  'paid_gas_unavailable','native_balance_and_net_nav_unavailable','atomic_saved_draft_binding_unavailable']);
});

test('retain preview rejects stale source and missing exact-scope close costs',()=>{
 assert.equal(buildPaperStaticRetainTerminalPreview({...input,previous:{...input.previous,sourceBlock:'120'}})
  .missing[0],'saved_terminal_context_mismatch');
 assert.equal(buildPaperStaticRetainTerminalPreview({...input,gasProfiles:[]}).missing[0],
  'scoped_terminal_costs_unavailable:complete_fresh_stage_costs_unavailable');
});

test('changed exit tick uses saved candidate scope and requires current independent references',()=>{
 const changedTick=tick+60,sqrt=sqrtRatioAtTick(changedTick),price1=
  ((1n<<192n)*10n**6n*1_000_000_000_000_000_000n)/(sqrt*sqrt*10n**18n);
 const changedFrame={...frame,tick:changedTick,sqrtPriceX96:sqrt,price1};
 const result=buildPaperStaticRetainTerminalPreview({...input,frame:changedFrame});
 assert.equal(result.status,'indicative');
 assert.equal(result.costs?.closeRetain.boundGasUnits,'360000');
 const missingReference=buildPaperStaticRetainTerminalPreview({...input,frame:{...frame,
  referenceEligible:false,price1:null}});
 assert.equal(missingReference.missing[0],'canonical_independent_reference_unavailable');
 const stale=buildPaperStaticRetainTerminalPreview({...input,now:frame.source.timestamp*1000+181_000});
 assert.equal(stale.missing[0],'saved_terminal_context_mismatch');
});
