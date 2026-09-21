import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {replayPaperMint} from '../src/research/management-audit.js';
import {assertRangeKeeperState,initialRangeKeeperState,parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {parseRangeKeeperState,serializeRangeKeeperState} from '../src/strategy/rangekeeper/state.js';
import {applyRangeKeeperStageReceipt,type RangeKeeperStageLedger} from '../src/strategy/rangekeeper/stages.js';
import {assertRangeKeeperStageGas,rangeKeeperCostEnvelope} from '../src/strategy/rangekeeper/cost.js';
import {allocateRangeKeeperFunding,strategyBalances} from '../src/strategy/rangekeeper/funding.js';
import {planRangeKeeper,rangeKeeperRange,rawValue,type RangeKeeperPlannerInput} from '../src/strategy/rangekeeper/planner.js';
import type {RangeKeeperObservation} from '../src/strategy/rangekeeper/domain.js';

const unit=10n**18n,hash=`0x${'ab'.repeat(32)}` as const;
const config=parseRangeKeeperConfig({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',broadcastEnabled:false,operator:null,
 pool:{chainId:4663,factory:'0x0000000000000000000000000000000000000001',pool:'0x0000000000000000000000000000000000000002',
  token0:'0x0000000000000000000000000000000000000003',token1:'0x0000000000000000000000000000000000000004',quoteToken:0,
  decimals0:18,decimals1:18,fee:500,tickSpacing:10,positionManager:'0x0000000000000000000000000000000000000005',
  router:'0x0000000000000000000000000000000000000006',quoter:'0x0000000000000000000000000000000000000007',
  poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
  reference0:'asset0/USD',reference1:'asset1/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 limits:{fullWidthSpacings:20,maxDeploymentValue:String(200n*unit),minDeploymentPpm:500000,
  maxSwapInputValue:String(100n*unit),maxSwapInputPpm:1000000,maxSwapShortfallValue:String(unit),maxSlippageBps:50,
  maxActionCost:String(2n*unit),maxRollingCost:String(5n*unit),maxCampaignCost:String(10n*unit),
  maxExposurePpm:1000000,maxLossValue:String(100n*unit),maxDrawdownPpm:900000,maxRecenters:4,
  maxLiquiditySharePpm:20000,maxObservationGapSeconds:90,exitReserveWei:String(unit/100n)},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:1800,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:345600,session:'latest_equity_session',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:86400,maxPoolDeviationPpm:50000},
 campaignValue:String(250n*unit),strategyFundingValue:String(240n*unit),nativeFundingValue:String(10n*unit)});

function observation(overrides:Partial<RangeKeeperObservation>={}):RangeKeeperObservation{return {
 block:1n,hash,timestamp:1000,tick:0,sqrtPriceX96:sqrtRatioAtTick(0),continuity:'canonical',
 wallet0:100n*unit,wallet1:100n*unit,released0:0n,released1:0n,nativeWei:unit,requiredExitReserveWei:unit/100n,
 price0:unit,price1:unit,nativePrice:1000n*unit,position:null,pending:false,entryAllowed:true,safeExitRequired:false,
 executionReady:true,liquiditySharePpm:1000,actionCost:unit,actionGasWei:unit/100n,
 reservedCost:0n,rollingSpentCost:0n,campaignSpentCost:0n,campaignStartValue:200n*unit,highWaterValue:200n*unit,recenters:0,...overrides};}
function input(o=observation()):RangeKeeperPlannerInput{return {state:initialRangeKeeperState(config,'build-1'),observation:o,
 limits:config.limits,spacing:10,decimals0:18,decimals1:18,quoteToken:0,maxPoolDeviationPpm:50000,
 quote:async(token,amountIn)=>({amountOut:amountIn,priceAfter:o.sqrtPriceX96,feeValue:0n,shortfallValue:0n,sourceBlock:o.block,sourceHash:o.hash}),
 simulate:async()=>true};}

test('config requires all live limits and cannot activate an unsealed generic path',()=>{
 assert.throws(()=>parseRangeKeeperConfig({...config,broadcastEnabled:true}));
 assert.throws(()=>parseRangeKeeperConfig({...config,limits:{...config.limits,maxActionCost:undefined}}));
});
test('two chain profiles parse with explicit addresses, decimals, costs, and a shared total cap',()=>{
 for(const name of ['nvda','aapl']){
  const raw=JSON.parse(readFileSync(new URL(`../config/rangekeeper-v1-${name}-disabled.json`,import.meta.url),'utf8'));
  const p=parseRangeKeeperConfig(raw);
  assert.equal(p.pool.decimals0,6);assert.equal(p.pool.decimals1,18);
  assert.equal(p.campaignValue,BigInt(name==='aapl'?325:250)*unit);assert.equal(p.broadcastEnabled,false);
 }
});
test('centered fixed span handles negative ticks and rejects bounds',()=>{
 assert.deepEqual(rangeKeeperRange(-1,10,20),{tickLower:-110,tickUpper:90});
 assert.throws(()=>rangeKeeperRange(887270,10,20),/tick_bounds/);
});
test('entry uses exact inventory without swap and requires two distinct observations',async()=>{
 const i=input(),first=await planRangeKeeper(i);
 assert.equal(first.action,'confirm');assert.equal(first.candidate?.swap,null);
 const second=await planRangeKeeper({...i,state:first.state,observation:observation({block:2n,timestamp:1030})});
 assert.equal(second.action,'execute');assert.equal(second.candidate?.sourceBlock,2n);
 assert.equal((await planRangeKeeper({...i,state:first.state})).reason,'duplicate_or_backward_observation');
});
test('second observation confirms the same range and route with its own changed quote',async()=>{
 const first=await planRangeKeeper(input());
 assert.equal(first.action,'confirm');
 const current=observation({block:2n,timestamp:1030,tick:1,sqrtPriceX96:sqrtRatioAtTick(1)});
 const second=await planRangeKeeper({...input(current),state:first.state});
 assert.equal(second.action,'execute',second.reason);
 assert.equal(second.candidate?.sourceBlock,2n);
 assert.deepEqual(second.candidate?.range,first.candidate?.range);
 assert.notEqual(second.candidate?.liquidity,first.candidate?.liquidity);
 const late=await planRangeKeeper({...input(observation({block:3n,timestamp:1091})),state:first.state});
 assert.equal(late.action,'confirm');
});
test('timer and frozen candidate survive versioned serialization; legacy state is rejected',async()=>{
 const first=await planRangeKeeper(input());
 const restored=parseRangeKeeperState(serializeRangeKeeperState(first.state));
 assertRangeKeeperState(restored,config,'build-1');
 assert.equal(restored.confirmation?.candidate.sourceBlock,1n);
 assert.equal((await planRangeKeeper({...input(observation({block:2n,timestamp:1030})),state:restored})).action,'execute');
 assert.throws(()=>parseRangeKeeperState({...first.state,policyId:'legacy'}));
 assert.throws(()=>assertRangeKeeperState(restored,config,'another-build'));
});
test('observed exit needs continuous five minutes; a return or gap restarts it',async()=>{
 let state=initialRangeKeeperState(config,'build-1');const p={tokenId:'1',tickLower:-20,tickUpper:0,liquidity:1n};
 for(let n=0;n<=5;n++){
  const o=observation({block:BigInt(n+1),timestamp:1000+n*60,position:p});
  const result=await planRangeKeeper({...input(o),state});state=result.state;
  assert.equal(result.action,n===5?'confirm':'wait');
 }
 let r=await planRangeKeeper({...input(observation({block:7n,timestamp:1360,position:p,tick:-1})),state});
 assert.equal(r.reason,'inside_range');assert.equal(r.state.exit,null);
 r=await planRangeKeeper({...input(observation({block:8n,timestamp:1420,position:p})),state:r.state});
 assert.equal(r.reason,'exit_persistence');assert.equal(r.state.exit?.since,1420);
 r=await planRangeKeeper({...input(observation({block:9n,timestamp:1600,position:p})),state:r.state});
 assert.equal(r.reason,'exit_persistence');assert.equal(r.state.exit?.since,1600);
 r=await planRangeKeeper({...input(observation({block:10n,timestamp:1660,position:p,continuity:'reorg'})),state:r.state});
 assert.equal(r.reason,'source_reorg');assert.equal(r.state.exit,null);
});
test('one-sided entry finds the minimum feasible raw swap without spending on rejection',async()=>{
 const o=observation({wallet0:200n*unit,wallet1:0n});const r=await planRangeKeeper(input(o));
 assert.equal(r.action,'confirm');assert.equal(r.candidate?.swap?.token,0);
 const amount=r.candidate!.swap!.amountIn;assert(amount>0n&&amount<=100n*unit);
 const range=r.candidate!.range;
 const prior=replayPaperMint(o.sqrtPriceX96,range,200n*unit-(amount-1n),amount-1n,0n);
 const value=rawValue(prior.amount0,unit,18)+rawValue(prior.amount1,unit,18);
 assert(value<100n*unit);
});
test('minimum-swap solver finds a narrow feasible window before ratio overshoot',async()=>{
 const o=observation({wallet0:200n*unit,wallet1:0n});
 const limits={...config.limits,maxSwapInputValue:150n*unit,minDeploymentPpm:980000};
 const r=await planRangeKeeper({...input(o),limits});
 assert.equal(r.action,'confirm',r.reason);assert(r.candidate?.swap);
 const amount=r.candidate.swap.amountIn,range=r.candidate.range;
 assert(amount<128n*unit,'The first exponential probe after the window would be infeasible');
 const previous=replayPaperMint(o.sqrtPriceX96,range,200n*unit-(amount-1n),amount-1n,0n);
 const value=rawValue(previous.amount0,unit,18)+rawValue(previous.amount1,unit,18);
 assert(value<196n*unit,'Raw-unit predecessor must miss the floor');
});
test('minimum-swap search advances past valid zero-output dust quotes',async()=>{
 const o=observation({wallet0:200n*unit,wallet1:0n});
 const i=input(o),quote=i.quote;
 const result=await planRangeKeeper({...i,quote:async(token,amount)=>{
  const q=await quote(token,amount);return amount<1000n?{...q,amountOut:0n}:q;
 }});
 assert.equal(result.action,'confirm');
 assert(result.candidate?.swap?.amountIn&&result.candidate.swap.amountIn>=1000n);
});
test('safety exit precedes missing reference, limits, and ordinary timer',async()=>{
 const o=observation({safeExitRequired:true,price0:null,actionCost:null,position:{tokenId:'1',tickLower:-20,tickUpper:0,liquidity:1n}});
 assert.equal((await planRangeKeeper(input(o))).action,'safety_exit');
 assert.equal((await planRangeKeeper(input(observation({actionCost:null})))).reason,'complete_action_cost_unavailable');
 assert.equal((await planRangeKeeper(input(observation({wallet0:40n*unit,wallet1:40n*unit,
  position:{tokenId:'1',tickLower:-20,tickUpper:0,liquidity:1n}})))).reason,'loss_limit');
 assert.equal((await planRangeKeeper(input(observation({price1:2n*unit,
  position:{tokenId:'1',tickLower:-20,tickUpper:0,liquidity:1n}})))).reason,'independent_price_band');
});
test('ordinary action requires every cost budget, reference, and native exit reserve',async()=>{
 assert.equal((await planRangeKeeper(input(observation({rollingSpentCost:5n*unit})))).reason,'cost_limit');
 assert.equal((await planRangeKeeper(input(observation({campaignSpentCost:10n*unit})))).reason,'cost_limit');
 assert.equal((await planRangeKeeper(input(observation({nativeWei:unit/100n})))).reason,'native_exit_reserve');
 assert.equal((await planRangeKeeper(input(observation({requiredExitReserveWei:null})))).reason,'complete_exit_reserve_unavailable');
 assert.equal((await planRangeKeeper(input(observation({nativePrice:null})))).reason,'independent_reference_unavailable');
});
test('first-pool cost envelope prices complete entry and exit at a fresh bounded fee',async()=>{
 const proposal=await planRangeKeeper(input(observation({wallet0:200n*unit,wallet1:0n})));
 assert(proposal.candidate?.swap);
 const envelope=rangeKeeperCostEnvelope({candidate:proposal.candidate,limits:config.limits,
  poolAddress:'0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D',
  baseFeePerGasWei:1_000_000_000n,marketGasPriceWei:1_000_000_000n,
  nativePriceValue:2_664n*unit,existingPosition:false});
 assert.equal(envelope.actionGasUnits,1_130_000n);
 assert.equal(envelope.completeExitGasUnits,900_000n);
 assert.equal(envelope.maxFeePerGasWei,1_250_000_000n);
 assert(envelope.requiredExitReserveWei>=1_125_000_000_000_000n);
 assert.throws(()=>rangeKeeperCostEnvelope({candidate:proposal.candidate!,limits:config.limits,
  poolAddress:config.pool.pool,baseFeePerGasWei:1_000_000_000n,marketGasPriceWei:1_000_000_000n,
  nativePriceValue:2_664n*unit,existingPosition:false}),/No fork gas evidence/);
 assertRangeKeeperStageGas('mint',470_694n);
 assert.throws(()=>assertRangeKeeperStageGas('mint',650_001n),/gas_bound/);
});
test('reverted and successful canonical receipts are each charged exactly once',()=>{
 const ledger:RangeKeeperStageLedger={stage:'swap',completedHashes:[],gasSpentWei:0n,costSpentValue:0n,
  wallet0:100n,wallet1:0n,activeTokenId:null,haltedReason:null};
 const receipt={stage:'swap' as const,hash,canonical:true,status:'reverted' as const,gasWei:4n,costValue:7n,nextStage:'mint' as const};
 assert.equal(applyRangeKeeperStageReceipt(ledger,receipt),true);
 assert.equal(applyRangeKeeperStageReceipt(ledger,receipt),false);
 assert.equal(ledger.gasSpentWei,4n);assert.equal(ledger.costSpentValue,7n);assert.equal(ledger.stage,'swap');
 assert.throws(()=>applyRangeKeeperStageReceipt(ledger,{...receipt,hash:`0x${'cd'.repeat(32)}`,canonical:false}),/noncanonical/);
});
test('an existing wallet reserves unrelated funds outside the 250 total cap',()=>{
 const s={wallet0:300n*unit,wallet1:0n,nativeWei:unit/100n,price0:unit,price1:unit,nativePrice:1000n*unit};
 const a=allocateRangeKeeperFunding(config,s,{amount0:240n*unit,amount1:0n,nativeWei:unit/200n});
 assert.equal(a.reserve0,60n*unit);assert.equal(a.totalBookedValue,245n*unit);
 assert.deepEqual(strategyBalances({wallet0:300n*unit,wallet1:0n,nativeWei:unit/100n},a),
  {amount0:240n*unit,amount1:0n,nativeWei:unit/200n});
 assert.throws(()=>strategyBalances({wallet0:59n*unit,wallet1:0n,nativeWei:unit/100n},a));
});
