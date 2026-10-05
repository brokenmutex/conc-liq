import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evaluateOracleRisk} from '../src/risk/evaluate.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {contentHash} from '../src/deployments/contracts.js';
import {RANGEKEEPER_PAPER_ACCOUNTING_POLICY} from '../src/deployments/paper-accounting.js';
import {rangeKeeperJson} from '../src/strategy/rangekeeper/live-domain.js';
import {rangeKeeperPinnedSemanticProofHash} from '../src/deployments/rangekeeper-live-review-runtime.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {deploymentPosition,readDeploymentDetail} from '../src/dashboard/deployment-position.js';

const NOW=Math.floor(Date.now()/1000),HOUR=3600,TICK=222390;
const A=(digit:string)=>`0x${digit.repeat(40)}`,H=`0x${'a'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:A('1'),token0:A('2'),token1:A('3'),
 quoteToken:0,decimals0:6,decimals1:18,fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,
 quoter:PAPER_QUOTER,poolCodeHash:H,token0CodeHash:H,token1CodeHash:H,managerCodeHash:H,quoterCodeHash:H,
 reference0:'USDG/USD',reference1:'AAPL/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const profileHash=contentHash(profile);
const source={block:'102',hash:`0x${'d'.repeat(64)}`,timestamp:NOW-5};
function oracle(base:string,answer:string,ageSeconds:number,extra:{description?:string}={}){
 return evaluateOracleRisk({blockTimestamp:BigInt(source.timestamp),maxPriceAgeSeconds:180,
  feed:{address:A('9') as `0x${string}`,baseAsset:base,decimals:8,heartbeatSeconds:86_400,marketHours:null,name:`${base}/USD`,
   productTypeCode:'x',quoteAsset:'USD'},
  state:{answer,answeredInRound:'7',codeHash:H as `0x${string}`,decimals:8,description:extra.description??`${base}/USD`,roundId:'7',
   startedAt:String(source.timestamp-ageSeconds),updatedAt:String(source.timestamp-ageSeconds)}});
}
const USDG='100000000',AAPL='20000000000',ETH='300000000000';
const proofFor=(stockAge:number,{description,basis='heartbeat_valid'}:{description?:string;basis?:string}={})=>({
 token0:{asset:null,oracle:oracle('USDG',USDG,30),basis:'heartbeat_valid'},
 token1:{asset:{registry:{symbol:'AAPL'}},oracle:oracle('AAPL',AAPL,stockAge,{description}),basis},
 native:oracle('ETH',ETH,30),registry:{},feedDirectory:{}});
const FRESH_PRICES={price0:'1000000000000000000',price1:'200000000000000000000',nativePrice:'3000000000000000000000'};

/** A RangeKeeper paper position as readDeploymentRows would hand it over. `eligible` is what the accounting record
 * decided; `reasons` are the codes the strategy recorded with the mark. */
function paperRow(options:{stockAge:number;eligible:boolean;reasons?:string[];description?:string;basis?:string;
 persisted?:{price0:string|null;price1:string|null;nativePrice:string|null}}){
 const proof=proofFor(options.stockAge,{description:options.description,basis:options.basis});
 const persisted=options.persisted??(options.eligible?FRESH_PRICES:{price0:null,price1:null,nativePrice:FRESH_PRICES.nativePrice});
 const reference={...persisted,proofHash:referenceProofHash(proof),proof,eligible:options.eligible};
 const campaignId='00000000-0000-4000-8000-0000000000a1';
 const mark={id:'5',at:new Date(source.timestamp*1000),
  inventory:{classification:'rangekeeper_paper_mark_v1',position:{tickLower:-60,tickUpper:60,liquidity:'1000000000000'},idle:{token0:'7',token1:'11'}},
  provenance:{classification:'rangekeeper_paper_mark_v1',epoch:0,source,reference:{...persisted,proofHash:reference.proofHash,proof},
   referenceUnavailable:options.reasons??[],poolState:{tick:TICK,sqrtPriceX96:String(sqrtRatioAtTick(TICK))}}};
 const economics=options.eligible?{initialCapitalQuote:'170000000000000000000',netNavQuote:'180000000000000000000',
  passiveQuote:'150000000000000000000',absolutePnlQuote:'10000000000000000000',alphaQuote:'30000000000000000000',
  cumulativeFeeValueQuote:'2000000000000000000',cumulativeGasExpenseQuote:null,intervalFeeAccrualQuote:'1000000000000000000',markGasExpenseQuote:null}:
  {initialCapitalQuote:'170000000000000000000',netNavQuote:null,passiveQuote:null,absolutePnlQuote:null,alphaQuote:null,
   cumulativeFeeValueQuote:null,cumulativeGasExpenseQuote:null,intervalFeeAccrualQuote:null,markGasExpenseQuote:null};
 const snapshot={policyVersion:RANGEKEEPER_PAPER_ACCOUNTING_POLICY,classification:'provisional_paper_scenario',campaignId,
  sourceMarkId:mark.id,markKind:'valuation' as const,source,profileHash,epoch:0,reference,feeEvidence:null,
  modeledCosts:{initialOpenBoundValue:'2000000000000000000',initialOpenBoundWei:'100',cumulativeBoundValue:'3000000000000000000',
   cumulativeBoundWei:'150',paidCostsAvailable:false as const},
  inventory:{token0Raw:'50000000',token1Raw:'500000000000000000',nativeWei:'10000000000000000',principal0Raw:'49000000',
   principal1Raw:'495000000000000000',fee0Raw:'1000000',fee1Raw:'5000000000000000',cumulativeGasWei:null,hasLiquidity:true},economics,
  limitations:['modeled_hypothetical_fee_share' as const,'modeled_costs_not_paid' as const,'retained_fees_not_reinvested' as const,
   'lower_integer_allocation_point' as const,...(options.eligible?[]:['independent_reference_unavailable' as const,'passive_comparator_unavailable' as const])]};
 const row:any={id:campaignId,mode:'paper',lifecycle:'active',range_state:'inside',current_revision:1,created_at:new Date((NOW-3*86400)*1000),
  closed_at:null,allocation:{token0Raw:'40000000',token1Raw:'400000000000000000',nativeWei:'10000000000000000'},runtime_identity:{},profile,
  strategy_id:'rangekeeper_v1',config:{},mark_id:mark.id,mark_at:mark.at,source_block:source.block,source_hash:source.hash,
  inventory:mark.inventory,economics:{},provenance:mark.provenance,initial_value:'99000000',operation_id:null,operation_kind:null,
  operation_status:null,operation_stage:null,operation_reason:null,operation_updated_at:null,accounting_snapshot:null,accounting_hash:null,
  rangekeeper_accounting_snapshot:snapshot,rangekeeper_accounting_hash:contentHash(snapshot),conversion_accounting_snapshot:null,
  conversion_accounting_hash:null,accounting_invalidated_at:null,accounting_invalidation_reason:null};
 return {row,mark,snapshot};
}
const STALE_REASONS=['token1_reference_age_unacceptable','reference_value_unavailable'];

test('paper: a fresh reference keeps oracle values and adds the labeled pool-implied figure',()=>{
 const {row}=paperRow({stockAge:30,eligible:true}),position=deploymentPosition(row);
 assert.equal(position.navQuote,'180000000');assert.equal(position.holdQuote,'150000000');assert.equal(position.feesQuote,'2000000');
 const valuation=position.valuation!;
 assert.equal(valuation.basis,'oracle_fresh');assert.equal(valuation.priceAgeAtMarkSeconds,30);
 assert.deepEqual(valuation.feeds.map(feed=>[feed.name,feed.symbol,feed.state]),[['token0','USDG','fresh'],['token1','AAPL','fresh'],['native','ETH','fresh']]);
 assert(valuation.poolImplied,'a pool-implied NAV is always computed');
 const implied=Number(BigInt(valuation.poolImplied.navQuote!))/1e6;
 assert(implied>180&&implied<200,`pool-implied ${implied} differs from the oracle NAV of 180`);
 assert.equal(valuation.poolImplied.priceQuoteX18,position.priceQuoteX18,'pool-implied uses the same pool price the row already exposes');
 assert(!position.reasons.includes('valued_at_last_oracle_price'));
});

test('paper: a stale weekend oracle is valued at the last answer with the same prices for NAV, P&L and the passive comparison',()=>{
 const {row}=paperRow({stockAge:38*HOUR,eligible:false,reasons:STALE_REASONS}),position=deploymentPosition(row);
 assert.equal(position.accounting,'provisional');
 assert.equal(position.navQuote,'180000000','50 USDG + 0.5 AAPL at the last answer 200 + 0.01 ETH at 3000');
 assert.equal(position.holdQuote,'150000000','passive comparison uses the same held prices');
 assert.equal(position.feesQuote,'2000000');assert.equal(position.initialQuote,'170000000');
 assert.equal(BigInt(position.navQuote!)-BigInt(position.initialQuote!),10_000_000n,'P&L against the opening baseline');
 assert.equal(position.referencePriceQuoteX18,'200000000000000000000');
 assert.equal(position.inventory.exposurePpm,'666666','risk-token share of the two token legs at the held prices: 100 of 150');
 const valuation=position.valuation!;
 assert.equal(valuation.basis,'last_oracle_price');assert.equal(valuation.priceAgeAtMarkSeconds,38*HOUR);
 assert.equal(valuation.priceAsOf,new Date((source.timestamp-38*HOUR)*1000).toISOString());
 assert.deepEqual(valuation.freshnessReasons,['token1_reference_age_unacceptable']);assert.deepEqual(valuation.structuralReasons,[]);
 assert.equal(valuation.feeds.find(feed=>feed.name==='token1')!.state,'stale');
 assert(valuation.poolImplied&&BigInt(valuation.poolImplied.navQuote!)>0n);
 assert(position.reasons.includes('valued_at_last_oracle_price'));
 assert.doesNotThrow(()=>JSON.stringify(position));
});

test('paper: a held equity reference the strategy accepted is shown even though the oracle reports priceFresh=false',()=>{
 const {row}=paperRow({stockAge:20*HOUR,eligible:false,reasons:[],basis:'held_equity_reference'}),position=deploymentPosition(row);
 assert.equal(position.valuation!.basis,'last_oracle_price');assert.equal(position.navQuote,'180000000');
 assert.equal(position.valuation!.feeds.find(feed=>feed.name==='token1')!.strategyBasis,'held_equity_reference');
});

test('paper: structural reference failures stay unavailable, but the pool-implied figure remains available',()=>{
 const cases:[string,Parameters<typeof paperRow>[0]][]=[
  ['description mismatch',{stockAge:38*HOUR,eligible:false,description:'SPY/USD',reasons:['token1_oracle_description_mismatch',...STALE_REASONS]}],
  ['corporate action / asset health',{stockAge:38*HOUR,eligible:false,reasons:['token1_asset_health',...STALE_REASONS]}],
  ['unverified session',{stockAge:38*HOUR,eligible:false,reasons:['market_session_unverified',...STALE_REASONS]}],
  ['feed older than the hold limit',{stockAge:8*86400,eligible:false,reasons:STALE_REASONS}],
  ['proof contradicting its reasons',{stockAge:30,eligible:false,reasons:STALE_REASONS}],
 ];
 for(const [name,options] of cases){
  const position=deploymentPosition(paperRow(options).row);
  assert.equal(position.navQuote,null,name);assert.equal(position.holdQuote,null,name);assert.equal(position.feesQuote,null,name);
  assert.equal(position.referencePriceQuoteX18,null,name);assert.equal(position.valuation!.basis,'unavailable',name);
  assert(position.valuation!.structuralReasons.length>0,name);assert(!position.reasons.includes('valued_at_last_oracle_price'),name);
  assert(position.valuation!.poolImplied,`${name}: the risk token never needs an oracle for the pool-implied figure`);
 }
 // With the quote token itself unusable the pool-implied figure cannot be converted to USD either.
 const noQuote=paperRow({stockAge:38*HOUR,eligible:false,reasons:STALE_REASONS});
 (noQuote.row.rangekeeper_accounting_snapshot.reference.proof as any).token0.oracle.state=null;
 const noQuoteProof=noQuote.row.rangekeeper_accounting_snapshot.reference.proof;
 noQuote.row.rangekeeper_accounting_snapshot.reference.proofHash=referenceProofHash(noQuoteProof);
 noQuote.row.provenance.reference={...noQuote.row.provenance.reference,proof:noQuoteProof,proofHash:referenceProofHash(noQuoteProof)};
 noQuote.row.rangekeeper_accounting_hash=contentHash(noQuote.row.rangekeeper_accounting_snapshot);
 const noQuotePosition=deploymentPosition(noQuote.row);
 assert.equal(noQuotePosition.valuation!.basis,'unavailable');assert.equal(noQuotePosition.valuation!.poolImplied,null);
});

test('paper: history points carry the held NAV and basis, and structural marks stay blank',async()=>{
 const detailFor=(options:Parameters<typeof paperRow>[0])=>{
  const {row,mark,snapshot}=paperRow(options);
  const saved={...mark,source_block:source.block,source_hash:source.hash,accounting_snapshot:null,accounting_hash:null,
   rangekeeper_accounting_snapshot:snapshot,rangekeeper_accounting_hash:contentHash(snapshot),conversion_accounting_snapshot:null,
   conversion_accounting_hash:null,accounting_invalidated_at:null,accounting_invalidation_reason:null,economics:{}};
  return readDeploymentDetail({query:async(sql:string)=>({rows:sql.includes('FROM deployment_marks m')?[saved]:[]})} as any,row,24);
 };
 const held:any=(await detailFor({stockAge:38*HOUR,eligible:false,reasons:STALE_REASONS})).performance.timeline.at(-1);
 assert.equal(held.economicNavQuote,'180000000');assert.equal(held.holdQuote,'150000000');assert.equal(held.valuationBasis,'last_oracle_price');
 assert.equal(held.referencePriceQuoteX18,'200000000000000000000');assert.equal(held.feesThisIntervalQuote,null,'interval fee accrual is not invented');
 const fresh:any=(await detailFor({stockAge:30,eligible:true})).performance.timeline.at(-1);
 assert.equal(fresh.economicNavQuote,'180000000');assert.equal(fresh.valuationBasis,'oracle_fresh');
 const structural:any=(await detailFor({stockAge:38*HOUR,eligible:false,description:'SPY/USD',
  reasons:['token1_oracle_description_mismatch',...STALE_REASONS]})).performance.timeline.at(-1);
 assert.equal(structural.economicNavQuote,null);assert.equal(structural.holdQuote,null);assert.equal(structural.valuationBasis,'unavailable');
});

// ---- live ----
const liveCampaign='00000000-0000-4000-8000-0000000000b1';
function liveRow(options:{stockAge:number;status?:'available'|'unavailable';basis?:string;description?:string;persistedStale?:boolean}){
 const proof=proofFor(options.stockAge,{description:options.description,basis:options.basis??'heartbeat_valid'});
 const prices={price0:FRESH_PRICES.price0,price1:FRESH_PRICES.price1,nativePrice:FRESH_PRICES.nativePrice};
 const proofHash=rangeKeeperPinnedSemanticProofHash({profileHash,source,references:prices,referenceProof:proof});
 const evidence={kind:'rangekeeper_live_independent_reference_v1',campaignId:liveCampaign,revision:1,profileHash,source,prices,
  semanticProofHash:proofHash,referenceProof:proof};
 const state:any={version:1,id:liveCampaign,operator:A('4'),configHash:`0x${'c'.repeat(64)}`,buildId:'test',phase:'holding',desired:'running',
  haltReason:null,createdAt:NOW-300,expiresAt:NOW+300,economicActions:1,recenters:1,policy:{},last:{source,operator:A('4')},
  activeTokenId:9n,retiredTokenIds:[],legacyNftCount:0n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,initial0:40_000_000n,
  initial1:4n*10n**17n,initialNativeWei:10n**16n,initialStrategyValue:120n*10n**18n,initialCapitalValue:150n*10n**18n,epoch:1,candidate:null,
  swapDone:false,swapConfirmedAt:null,withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,
  collectedFee0:1_000_000n,collectedFee1:5n*10n**15n,gasSpentWei:5_000_000_000_000_000n,
  costEvents:[{hash:`0x${'d'.repeat(64)}`,block:99n,timestamp:NOW-6,gasWei:5_000_000_000_000_000n,gasValue:10_000_000_000_000_000n,
   swapFeeValue:0n,swapShortfallValue:0n}],highWaterValue:0n,activeSeconds:0,outsideSeconds:0,lastMarkTimestamp:NOW-5,lastReason:'holding',closedAt:null};
 const snapshot={source,operator:A('4'),wallet0:0n,wallet1:0n,nativeWei:0n,nonce:4,nftCount:1,tick:TICK,sqrtPriceX96:sqrtRatioAtTick(TICK),
  unlocked:true,poolLiquidity:0n,allowances:[],position:{tokenId:9n,owner:A('4'),token0:A('2'),token1:A('3'),fee:3000,tickLower:222360,
   tickUpper:222480,liquidity:1000n,tokensOwed0:1n,tokensOwed1:2n}};
 const fee={kind:'rangekeeper_live_position_fee_evidence_v1',source,referenceProofHash:proofHash,tokenId:'9',liquidityRaw:'1000',
  principal0Raw:'39000000',principal1Raw:'395000000000000000',uncollected0Raw:'1000000',uncollected1Raw:'5000000000000000',
  grossFee0Raw:'1000000',grossFee1Raw:'5000000000000000',inventory0Raw:'40000000',inventory1Raw:'400000000000000000',
  collectionSimulation:'canonical_eth_call'};
 const available=(options.status??'available')==='available';
 const payload:any={schemaVersion:1,kind:'rangekeeper_live_valuation_mark_v1',campaignId:liveCampaign,revision:1,
  allocationId:'00000000-0000-4000-8000-0000000000b2',profileId:'00000000-0000-4000-8000-0000000000b3',profileHash,configHash:'c'.repeat(64),
  source,snapshot,allocation:{liquidByTokenAddress:{[A('2')]:'10000000',[A('3')]:'100000000000000000'},nativeSpendWei:'10000000000000000',
   pendingNativeSpendWei:'0',exitReserveWei:'0',nftTokenIds:['9']},
  referenceValuation:available?{status:'available',source,proofHash,...prices,evidence}:{status:'unavailable',source,missing:['independent_reference_unavailable']},
  positionFeeEvidence:available?fee:{status:'unavailable',source,missing:['independent_reference_unavailable']},
  accountingState:state,runtimeStateHash:contentHash(JSON.parse(rangeKeeperJson(state))),missing:[]};
 const stored=JSON.parse(rangeKeeperJson(payload)),runtime=JSON.parse(rangeKeeperJson(state));
 return {id:liveCampaign,mode:'live',lifecycle:'active',range_state:'inside',current_revision:1,created_at:new Date((NOW-3*86400)*1000),
  closed_at:null,allocation:{token0Raw:'0',token1Raw:'0',nativeWei:'0'},runtime_identity:null,profile,strategy_id:'rangekeeper_v1',config:{},
  mark_id:null,mark_at:null,source_block:null,source_hash:null,inventory:{position:{liquidity:'1000',tickLower:222360,tickUpper:222480}},
  economics:null,provenance:{source},initial_value:null,operation_id:null,operation_kind:null,operation_status:null,operation_stage:null,
  operation_reason:null,operation_updated_at:null,accounting_snapshot:null,accounting_hash:null,rangekeeper_accounting_snapshot:null,
  rangekeeper_accounting_hash:null,conversion_accounting_snapshot:null,conversion_accounting_hash:null,accounting_invalidated_at:null,
  accounting_invalidation_reason:null,live_mark_payload:stored,live_mark_payload_hash:contentHash(stored),live_mark_block:source.block,
  live_mark_hash:source.hash,live_mark_timestamp:source.timestamp,live_runtime_state:runtime,live_runtime_state_hash:contentHash(runtime),
  live_runtime_revision:1,live_runtime_profile_hash:profileHash,live_runtime_config_hash:payload.configHash,live_profile_id:payload.profileId} as any;
}

test('live: a fresh reference keeps receipt-backed values and adds the pool-implied figure',()=>{
 const position=deploymentPosition(liveRow({stockAge:30}));
 assert.equal(position.accounting,'recorded');assert.equal(position.valuation!.basis,'oracle_fresh');
 assert.equal(position.valuation!.priceAgeAtMarkSeconds,30);
 assert(position.valuation!.poolImplied);assert.equal(position.valuation!.poolImplied!.priceQuoteX18,position.priceQuoteX18,
  'the live pool price is the sqrt price the mark recorded');
 assert(position.priceQuoteX18!==null,'a mark whose sqrt price is stored as a bigint still exposes the pool price');assert.equal(position.deployment.live!.lifecycle,'holding');
});

test('live: a reference past its age limit is valued at the last oracle answer instead of withholding NAV',()=>{
 const fresh=deploymentPosition(liveRow({stockAge:30})),held=deploymentPosition(liveRow({stockAge:38*HOUR,basis:'held_equity_reference'}));
 assert.equal(held.accounting,'recorded','receipt-backed inventory valued at the last oracle answers');
 assert.equal(held.valuation!.basis,'last_oracle_price');assert.equal(held.valuation!.priceAgeAtMarkSeconds,38*HOUR);
 assert.equal(held.valuation!.priceAsOf,new Date((source.timestamp-38*HOUR)*1000).toISOString());
 assert.equal(held.navQuote,fresh.navQuote,'the held answer equals the persisted prices, so the value matches');
 assert(held.navQuote!==null&&held.holdQuote!==null&&held.feesQuote!==null&&held.initialQuote!==null);
 assert.equal(held.valuation!.feeds.find(feed=>feed.name==='token1')!.strategyBasis,'held_equity_reference');
 assert(held.reasons.includes('valued_at_last_oracle_price'));assert(!held.reasons.includes('independent_reference_unavailable'));
 assert(held.valuation!.poolImplied);assert.equal(held.deployment.rangekeeper?.valuationCurrent,true);
});

test('live: structural failures and a mark with no reference evidence stay unavailable',()=>{
 const structural=deploymentPosition(liveRow({stockAge:38*HOUR,basis:'held_equity_reference',description:'SPY/USD'}));
 assert.equal(structural.navQuote,null);assert.equal(structural.valuation!.basis,'unavailable');
 assert(structural.valuation!.structuralReasons.includes('token1_oracle_description_mismatch'));
 const dead=deploymentPosition(liveRow({stockAge:9*86400,basis:'held_equity_reference'}));
 assert.equal(dead.navQuote,null);assert.equal(dead.valuation!.basis,'unavailable');
 const withheld=deploymentPosition(liveRow({stockAge:30,status:'unavailable'}));
 assert.equal(withheld.navQuote,null);assert.equal(withheld.valuation!.basis,'unavailable');
 assert.equal(withheld.valuation!.poolImplied,null,'no inventory observation to value without the mark evidence');
 assert.equal(withheld.accounting,'unavailable');
});

test('live: history points carry the basis of each mark',async()=>{
 const row=liveRow({stockAge:38*HOUR,basis:'held_equity_reference'});
 const detail=await readDeploymentDetail({query:async(sql:string)=>({rows:
  sql.includes("to_regclass('deployment_paper_accounting')")?[{present:null}]:
  sql.includes("to_regclass('deployment_live_runtime_events')")?[{present:'deployment_live_runtime_events'}]:
  sql.includes('FROM deployment_live_runtime_events WHERE')?[{payload:row.live_mark_payload,payload_hash:row.live_mark_payload_hash,
   source_block:source.block,source_hash:source.hash,source_timestamp:source.timestamp}]:[]})} as any,row,24);
 const point:any=detail.performance.timeline.at(-1);
 assert.equal(point.valuationBasis,'last_oracle_price');assert(point.economicNavQuote!==null);
});
