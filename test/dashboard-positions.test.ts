import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {positionWindow,type PositionPoint} from '../src/dashboard/position-performance.js';
import {createDashboardServer} from '../src/dashboard/server.js';
import {loadDashboardConfig} from '../src/dashboard/config.js';
import {rangeKeeperPosition,rangeKeeperDetail} from '../src/dashboard/rangekeeper-position.js';
import {rangeKeeperJson} from '../src/strategy/rangekeeper/live-domain.js';
import {amountsForLiquidity,sqrtRatioAtTick} from '../src/backtest/principal.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import {contentHash} from '../src/deployments/contracts.js';
import {referenceProofHash} from '../src/deployments/market-profile.js';
import {RANGEKEEPER_PAPER_ACCOUNTING_POLICY} from '../src/deployments/paper-accounting.js';
import {readDeploymentDetail,deploymentPosition} from '../src/dashboard/deployment-position.js';
import {rangeKeeperPinnedSemanticProofHash} from '../src/deployments/rangekeeper-live-review-runtime.js';

function point(at:string,nav:string,extra:Partial<PositionPoint>={}):PositionPoint{return {
 sourceAt:at,observedAt:at,block:'1',action:'mark',status:'open',economicNavQuote:nav,holdQuote:'100000000',priceQuoteX18:'220000000000000000000',
 usdg:'50000000',nvda:'227272727272727272',exposurePpm:'500000',inRange:true,tickLower:222390,tickUpper:222430,
 feesThisIntervalQuote:'0',gasThisMarkQuote:'0',swapThisMarkQuote:'0',swapsThisMark:0,drawdownPpm:'0',...extra};}
const total=(rows:any[],field:string)=>rows.reduce((n,b)=>n+BigInt(b[field]),0n);
test('week attribution preserves exact net P&L and allocates boundary charges once',()=>{
 const created='2026-09-11T13:28:00Z',points=[point('2026-09-11T13:29:00Z','99000000',{action:'enter',gasThisMarkQuote:'500000',swapThisMarkQuote:'500000',swapsThisMark:1}),
 point('2026-09-11T13:30:00Z','102000000',{gasThisMarkQuote:'100000',feesThisIntervalQuote:'700000'}),point('2026-09-11T13:31:00Z','101500000')];
 const w=positionWindow(points,168,Date.parse(points.at(-1)!.sourceAt),'100000000',created);
 assert.equal(total(w.rows,'netPnlQuote'),1500000n);assert.equal(total(w.rows,'gasQuote'),600000n);assert.equal(total(w.rows,'swapCostQuote'),500000n);
 assert.equal(w.rows.find(r=>r.key==='mixed_boundary')!.netPnlQuote,'3100000');assert.equal(w.rows.find(r=>r.key==='mixed_boundary')!.feeIncomeQuote,'700000');
 assert.equal(total(w.rows,'alphaQuote'),1500000n);assert.equal(w.hours,168);assert(w.sessions.some(s=>s.group==='non_market'));
});
test('live RangeKeeper projection values complete source-bound custody and fees, charges receipt gas once, and fails closed on stale or incomplete evidence',async()=>{
 const now=Math.floor(Date.now()/1000),address=(digit:string)=>`0x${digit.repeat(40)}`,
  hash=`0x${'a'.repeat(64)}`,source={block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:now-5},
  profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:address('1'),
   token0:address('2'),token1:address('3'),quoteToken:0,decimals0:6,decimals1:18,fee:3000,tickSpacing:60,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,poolCodeHash:hash,
   token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
   reference0:'USDG/USD',reference1:'AAPL/USD',nativeReference:'ETH/USD',numeraire:'USD'},
   referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
    token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
    nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}}),profileHash=contentHash(profile),
  prices={price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'2000000000000000000'},
  proof={token0:{priceFresh:true},token1:{priceFresh:true},native:{priceFresh:true}},
  proofHash=rangeKeeperPinnedSemanticProofHash({profileHash,source,references:prices,referenceProof:proof}),
  evidence={kind:'rangekeeper_live_independent_reference_v1',campaignId:'00000000-0000-4000-8000-000000000001',
   revision:1,profileHash,source,prices,semanticProofHash:proofHash,referenceProof:proof},
  accountingState:any={version:1,id:'00000000-0000-4000-8000-000000000001',operator:address('4'),
   configHash:`0x${'c'.repeat(64)}`,buildId:'test',phase:'holding',desired:'running',haltReason:null,
   createdAt:now-300,expiresAt:now+300,economicActions:1,recenters:3,policy:{},last:{source,operator:address('4')},
   activeTokenId:9n,retiredTokenIds:[],legacyNftCount:0n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,
   initial0:10_000_000n,initial1:20n*10n**18n,initialNativeWei:1n*10n**18n,initialStrategyValue:30n*10n**18n,
   initialCapitalValue:32n*10n**18n,epoch:3,
   candidate:null,swapDone:false,swapConfirmedAt:null,withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,
   mintRecoveryAttempts:0,collectedFee0:2_000_000n,collectedFee1:3n*10n**18n,gasSpentWei:5_000_000_000_000_000n,
   costEvents:[{hash:`0x${'d'.repeat(64)}`,block:99n,timestamp:now-6,gasWei:5_000_000_000_000_000n,gasValue:10_000_000_000_000_000n,
    swapFeeValue:null,swapShortfallValue:null}],highWaterValue:0n,activeSeconds:0,outsideSeconds:0,
   lastMarkTimestamp:now-5,lastReason:'holding',closedAt:null},
  snapshot={source,operator:address('4'),wallet0:13_000_000n,wallet1:24n*10n**18n,nativeWei:995_000_000_000_000_000n,
   nonce:4,nftCount:1,tick:0,sqrtPriceX96:sqrtRatioAtTick(0),unlocked:true,poolLiquidity:0n,
   allowances:[],position:{tokenId:9n,owner:address('4'),token0:address('2'),token1:address('3'),fee:3000,
    tickLower:-60,tickUpper:60,liquidity:1000n,tokensOwed0:1n,tokensOwed1:2n}},
  positionFeeEvidence={kind:'rangekeeper_live_position_fee_evidence_v1',source,referenceProofHash:proofHash,
   tokenId:'9',liquidityRaw:'1000',principal0Raw:'999999',principal1Raw:'19999999999999999998',
   uncollected0Raw:'1',uncollected1Raw:'2',grossFee0Raw:'2000000',grossFee1Raw:'3000000000000000000',
   inventory0Raw:'1000000',inventory1Raw:'20000000000000000000',collectionSimulation:'canonical_eth_call'},
  payload:any={schemaVersion:1,kind:'rangekeeper_live_valuation_mark_v1',campaignId:accountingState.id,revision:1,
   allocationId:'00000000-0000-4000-8000-000000000002',profileId:'00000000-0000-4000-8000-000000000003',
   profileHash,configHash:'c'.repeat(64),source,snapshot,allocation:{liquidByTokenAddress:{[address('2')]:'3000000',[address('3')]:'4000000000000000000'},
    nativeSpendWei:'995000000000000000',pendingNativeSpendWei:'0',exitReserveWei:'0',nftTokenIds:['9']},
   referenceValuation:{status:'available',source,proofHash,...prices,evidence},positionFeeEvidence,
   accountingState,runtimeStateHash:contentHash(JSON.parse(rangeKeeperJson(accountingState))),missing:[]},
  row:any={id:accountingState.id,mode:'live',lifecycle:'active',range_state:'inside',current_revision:1,
   created_at:new Date((now-300)*1000),closed_at:null,allocation:{token0Raw:'0',token1Raw:'0',nativeWei:'0'},
   runtime_identity:null,profile,strategy_id:'rangekeeper_v1',config:{},mark_id:null,mark_at:null,
   source_block:null,source_hash:null,inventory:{position:{liquidity:'1000',tickLower:-60,tickUpper:60}},economics:null,
   provenance:{source},initial_value:null,operation_id:null,operation_kind:null,operation_status:null,
   operation_stage:null,operation_reason:null,operation_updated_at:null,accounting_snapshot:null,accounting_hash:null,
   rangekeeper_accounting_snapshot:null,rangekeeper_accounting_hash:null,conversion_accounting_snapshot:null,
   conversion_accounting_hash:null,accounting_invalidated_at:null,accounting_invalidation_reason:null,
   live_mark_payload:JSON.parse(rangeKeeperJson(payload)),live_mark_payload_hash:contentHash(JSON.parse(rangeKeeperJson(payload))),live_mark_block:source.block,
   live_mark_hash:source.hash,live_mark_timestamp:source.timestamp,live_runtime_state:JSON.parse(rangeKeeperJson(accountingState)),
   live_runtime_state_hash:contentHash(JSON.parse(rangeKeeperJson(accountingState))),live_runtime_revision:1,
   live_runtime_profile_hash:profileHash,live_runtime_config_hash:payload.configHash,live_profile_id:payload.profileId};
 const position=deploymentPosition(row);
 assert.equal(position.accounting,'recorded');assert.equal(position.navQuote,'29990000');
 assert.equal(position.deployment.rangekeeper?.epoch,3,
  'live epoch is sourced from the persisted accountingState when the payload has no top-level epoch');
 assert.equal(position.holdQuote,'32000000');assert.equal(position.initialQuote,'32000000');
 assert.equal(position.gasQuote,'10000','measured gas is reported separately and not subtracted twice from NAV');
 assert.equal(position.feesQuote,'5000000');
 assert.equal(position.inventory.tokens[0]!.amountRaw,'4000000');
 assert.equal(position.inventory.tokens[1]!.amountRaw,'24000000000000000000');
 assert.doesNotThrow(()=>JSON.stringify(position),'Positions API projection must be JSON-safe');
 assert.equal(position.initialQuote,'32000000','opening native reserve is included in the exact opening capital baseline');
 // The mark payload's accountingState is a subset without the time-in-range counters; they come from the full verified runtime.
 const {activeSeconds:_a,outsideSeconds:_o,...subset}=accountingState,
  fullRuntime={...accountingState,activeSeconds:120,outsideSeconds:30},
  fullRuntimeHash=contentHash(JSON.parse(rangeKeeperJson(fullRuntime))),
  subsetPayload={...payload,accountingState:subset,runtimeStateHash:fullRuntimeHash},
  timed={...row,live_mark_payload:JSON.parse(rangeKeeperJson(subsetPayload)),
   live_mark_payload_hash:contentHash(JSON.parse(rangeKeeperJson(subsetPayload))),
   live_runtime_state:JSON.parse(rangeKeeperJson(fullRuntime)),live_runtime_state_hash:fullRuntimeHash};
 const timedPosition=deploymentPosition(timed);
 assert.equal(timedPosition.accounting,'recorded','the subset accountingState still values the mark');
 assert.deepEqual(timedPosition.deployment.live!.timeInRange,{activeSeconds:120,outsideSeconds:30});
 assert.equal(timedPosition.deployment.live!.runtimeVerified,true);
 assert.equal(deploymentPosition(row).deployment.live!.timeInRange!.activeSeconds,0,'a runtime with zero counters reports zero');
 const unverified=deploymentPosition({...timed,live_runtime_state_hash:'0'.repeat(64)});
 assert.equal(unverified.deployment.live!.timeInRange,null,'an unverified runtime never reports time in range');
 const stale={...row,live_mark_payload:{...row.live_mark_payload as any,referenceValuation:{...(row.live_mark_payload as any).referenceValuation,
  source:{...source,block:'99'}}}};
 stale.live_mark_payload_hash=contentHash(stale.live_mark_payload);
 const unavailable=deploymentPosition(stale);
 assert.equal(unavailable.navQuote,null);assert.equal(unavailable.holdQuote,null);assert.equal(unavailable.feesQuote,null);
 const missingFee={...row,live_mark_payload:{...row.live_mark_payload as any,positionFeeEvidence:null}};
 missingFee.live_mark_payload_hash=contentHash(missingFee.live_mark_payload);
 const incomplete=deploymentPosition(missingFee);
 assert.equal(incomplete.navQuote,null);assert.equal(incomplete.accounting,'unavailable');
 const history=await readDeploymentDetail({query:async(sql:string)=>({rows:
  sql.includes("to_regclass('deployment_paper_accounting')")?[{present:null}]:
  sql.includes("to_regclass('deployment_live_runtime_events')")?[{present:'deployment_live_runtime_events'}]:
  sql.includes('FROM deployment_live_runtime_events WHERE')?[{payload:row.live_mark_payload,
   payload_hash:row.live_mark_payload_hash,source_block:source.block,source_hash:source.hash,source_timestamp:source.timestamp}]:[]})} as any,
  row,24);
 assert.equal(history.performance.markCount,1);
 assert.equal(history.performance.timeline[0]?.economicNavQuote,'29990000');
 assert.equal(history.performance.timeline[0]?.holdQuote,'32000000');
 assert.equal(history.performance.timeline[0]?.epoch,3);
});
test('left-edge partial intervals are excluded, without charging older gas or swaps',()=>{
 const points=[point('2026-09-12T11:30:00Z','100000000'),point('2026-09-12T12:01:00Z','90000000',{gasThisMarkQuote:'2000000'}),point('2026-09-12T12:30:00Z','91000000')];
 const w=positionWindow(points,1,Date.parse('2026-09-12T13:00:00Z'),'100000000','2026-09-12T11:00:00Z');
 assert.equal(w.coveredStart,'2026-09-12T12:01:00Z');assert.equal(total(w.rows,'netPnlQuote'),1000000n);assert.equal(total(w.rows,'gasQuote'),0n);
 assert.equal(w.gaps.length,1);assert.equal(w.rows.find(r=>r.key==='unobserved')!.netPnlQuote,'1000000');
});
test('week view shows only available marks and keeps unknown gas and NAV unknown',()=>{
 const p=point('2026-09-12T12:00:00Z','100000000',{economicNavQuote:null,gasThisMarkQuote:null,holdQuote:null});
 const w=positionWindow([p],168,Date.parse(p.sourceAt),'100000000','2026-09-12T11:59:00Z');
 assert.equal(w.timeline.length,1);assert.equal(w.markCount,1);assert.equal(w.rows.find(r=>r.key==='non_market')!.netPnlQuote,null);
 assert.equal(w.rows.find(r=>r.key==='non_market')!.gasQuote,null);assert.equal(w.rows.find(r=>r.key==='non_market')!.alphaQuote,null);
});
test('pre-entry cash does not poison later passive-hold attribution',()=>{
 const ps=[point('2026-09-12T12:00:00Z','100000000',{holdQuote:null}),point('2026-09-12T12:01:00Z','99000000',{action:'enter',holdQuote:'99500000'})];
 const w=positionWindow(ps,1,Date.parse(ps[1]!.sourceAt),'100000000','2026-09-12T11:59:00Z');
 assert.equal(total(w.rows,'alphaQuote'),-500000n);
});
test('RangeKeeper paper marks and retained close marks project into shared history with unavailable economics',async()=>{
 const now=Math.floor(Date.now()/1000),address=(digit:string)=>`0x${digit.repeat(40)}`,
  hash=`0x${'a'.repeat(64)}`,profile=marketProfileSchema.parse({pool:{chainId:4663,
   factory:UNISWAP_V3_FACTORY,pool:address('1'),token0:address('2'),token1:address('3'),
   quoteToken:0,decimals0:6,decimals1:18,fee:3000,tickSpacing:60,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
   poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,
   quoterCodeHash:hash,reference0:'USDG/USD',reference1:'AAPL/USD',nativeReference:'ETH/USD',numeraire:'USD'},
   referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
    token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
    nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}}),sqrt=sqrtRatioAtTick(0),liquidity=10n**12n,
  principal=amountsForLiquidity({liquidity,sqrtPriceX96:sqrt,sqrtRatioAX96:sqrtRatioAtTick(-60),sqrtRatioBX96:sqrtRatioAtTick(60)}),
  source={block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:now-30},base={id:'00000000-0000-4000-8000-000000000001',
   at:new Date(source.timestamp*1000),source_block:source.block,source_hash:source.hash,accounting_snapshot:null,
   accounting_hash:null,conversion_accounting_snapshot:null,conversion_accounting_hash:null,
   accounting_invalidated_at:null,accounting_invalidation_reason:null},
  currentMark={...base,inventory:{classification:'rangekeeper_paper_mark_v1',position:{tickLower:-60,tickUpper:60,
    liquidity:String(liquidity)},idle:{token0:'7',token1:'11'}},economics:{principalOnlyValue:'100000000000000000000'},
   provenance:{classification:'rangekeeper_paper_mark_v1',source,poolState:{tick:0,sqrtPriceX96:String(sqrt)},
    reference:{price0:'1000000000000000000',price1:'1000000000000000000'}}},
  closeMark={...base,inventory:{classification:'rangekeeper_paper_close_retain_v1',position:null,
    retainedPrincipalLowerBound:{token0Raw:'13',token1Raw:'17'}},economics:{principalOnlyValue:null},
   provenance:{classification:'rangekeeper_paper_close_retain_v1',source,poolState:{tick:0,sqrtPriceX96:String(sqrt)},
    reference:{price0:'1000000000000000000',price1:'1000000000000000000'}}};
 const rowFor=(mark:any,lifecycle:'active'|'closed')=>({id:base.id,mode:'paper',lifecycle,range_state:'inside',
  current_revision:1,created_at:new Date((now-120)*1000),closed_at:lifecycle==='closed'?new Date(source.timestamp*1000):null,
  allocation:{token0Raw:'0',token1Raw:'0',nativeWei:'0'},runtime_identity:{},profile, strategy_id:'rangekeeper_v1',
  config:{},mark_id:'1',mark_at:mark.at,source_block:mark.source_block,source_hash:mark.source_hash,
  inventory:mark.inventory,economics:mark.economics,provenance:mark.provenance,initial_value:'100000000',
  operation_id:null,operation_kind:null,operation_status:null,operation_stage:null,operation_reason:null,
  operation_updated_at:null,accounting_snapshot:null,accounting_hash:null,conversion_accounting_snapshot:null,
  conversion_accounting_hash:null,accounting_invalidated_at:null,accounting_invalidation_reason:null});
 const detail=async(mark:any,lifecycle:'active'|'closed')=>readDeploymentDetail({query:async(sql:string)=>({rows:
  sql.includes('FROM deployment_marks m')?[mark]:[]})} as any,rowFor(mark,lifecycle) as any,lifecycle==='closed'?0:24);
 const opened=await detail(currentMark,'active'),openPoint:any=opened.performance.timeline.at(-1);
 assert.ok(openPoint);
 assert.equal(openPoint.action,'mark');assert.equal(openPoint.economicNavQuote,null);
 assert.equal(openPoint.tokenBalances[0].amountRaw,String(principal.amount0+7n));
 assert.equal(openPoint.tokenBalances[1].amountRaw,String(principal.amount1+11n));
 assert.equal(opened.position.navQuote,null);assert.equal(opened.position.accounting,'unavailable');
 const closed=await detail(closeMark,'closed'),exit:any=closed.performance.timeline.at(-1);
 assert.ok(exit);
 assert.equal(exit.action,'exit');assert.equal(exit.economicNavQuote,null);
 assert.equal(exit.tokenBalances[0].amountRaw,null);assert.equal(exit.tokenBalances[0].lowerBoundRaw,'13');
 assert.equal(exit.tokenBalances[1].lowerBoundRaw,'17');assert.equal(closed.position.navQuote,null);
 const converted=await detail({...base,inventory:{classification:'rangekeeper_paper_close_convert_v1',
  position:null,token0Raw:'23',token1Raw:'0',conversion:{inputAmount:'17'}},economics:null,
  provenance:{classification:'rangekeeper_paper_close_convert_v1',currentEpoch:{epoch:1},source}},'closed'),
  convertedPoint:any=converted.performance.timeline.at(-1);
 assert.equal(convertedPoint.action,'exit');assert.equal(convertedPoint.status,'closed');
 assert.equal(convertedPoint.tokenBalances[0].amountRaw,'23');
 assert.equal(convertedPoint.tokenBalances[1].amountRaw,'0');
 assert.equal(converted.position.deployment.rangekeeper?.currentEpoch,1);
 assert.equal(converted.position.deployment.conversionAccountingStatus,'unavailable');
 assert.equal(converted.position.navQuote,null);assert.equal(converted.counts.swaps,1);
});
test('RangeKeeper recenter marks show the new epoch and exact current inventory without inventing economics',async()=>{
 const now=Math.floor(Date.now()/1000),address=(digit:string)=>`0x${digit.repeat(40)}`,
  hash=`0x${'a'.repeat(64)}`,profile=marketProfileSchema.parse({pool:{chainId:4663,
   factory:UNISWAP_V3_FACTORY,pool:address('1'),token0:address('2'),token1:address('3'),
   quoteToken:0,decimals0:6,decimals1:18,fee:3000,tickSpacing:60,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
   poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,
   quoterCodeHash:hash,reference0:'USDG/USD',reference1:'AAPL/USD',nativeReference:'ETH/USD',numeraire:'USD'},
   referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
    token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
    nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}}),sqrt=sqrtRatioAtTick(120),liquidity=10n**12n,
  principal=amountsForLiquidity({liquidity,sqrtPriceX96:sqrt,sqrtRatioAX96:sqrtRatioAtTick(60),sqrtRatioBX96:sqrtRatioAtTick(180)}),
  source={block:'101',hash:`0x${'c'.repeat(64)}`,timestamp:now-20},campaignId='00000000-0000-4000-8000-000000000001',
  mark={id:'2',at:new Date(source.timestamp*1000),source_block:source.block,source_hash:source.hash,
   accounting_snapshot:null,accounting_hash:null,conversion_accounting_snapshot:null,conversion_accounting_hash:null,
   accounting_invalidated_at:null,accounting_invalidation_reason:null,
   inventory:{classification:'rangekeeper_paper_recenter_v1',position:{tickLower:60,tickUpper:180,
    liquidity:String(liquidity)},idle:{token0:'7',token1:'11'}},economics:{principalOnlyValue:null},
   provenance:{classification:'rangekeeper_paper_recenter_v1',epoch:1,previousEpoch:0,candidateHash:hash,
    source,poolState:{tick:120,sqrtPriceX96:String(sqrt)},
    reference:{price0:'1000000000000000000',price1:'1000000000000000000'},paidCostsAvailable:false,modeledCosts:null}};
 const row={id:campaignId,mode:'paper',lifecycle:'active',range_state:'inside',current_revision:1,
  created_at:new Date((now-120)*1000),closed_at:null,allocation:{token0Raw:'0',token1Raw:'0',nativeWei:'0'},
  runtime_identity:{},profile,strategy_id:'rangekeeper_v1',config:{},mark_id:'2',mark_at:mark.at,
  source_block:mark.source_block,source_hash:mark.source_hash,inventory:mark.inventory,economics:mark.economics,
  provenance:mark.provenance,initial_value:'100000000',operation_id:null,operation_kind:null,
  operation_status:null,operation_stage:null,operation_reason:null,operation_updated_at:null,
  accounting_snapshot:null,accounting_hash:null,conversion_accounting_snapshot:null,conversion_accounting_hash:null,
  accounting_invalidated_at:null,accounting_invalidation_reason:null};
 const detail=await readDeploymentDetail({query:async(sql:string)=>({rows:
  sql.includes('FROM deployment_marks m')?[mark]:[]})} as any,row as any,24),
  event:any=detail.performance.timeline.at(-1);
 assert.equal(event.action,'recenter');assert.equal(event.epoch,1);assert.equal(event.previousEpoch,0);
 assert.equal(event.candidateHash,hash);assert.equal(event.economicNavQuote,null);
 assert.equal(event.tokenBalances[0].amountRaw,String(principal.amount0+7n));
 assert.equal(event.tokenBalances[1].amountRaw,String(principal.amount1+11n));
 assert.equal(detail.position.navQuote,null);assert.equal(detail.position.deployment.rangekeeper?.currentEpoch,1);
 assert.equal(detail.position.deployment.rangekeeper?.latestClassification,'rangekeeper_paper_recenter_v1');
 assert.equal(detail.position.deployment.rangekeeper?.recenterAvailable,false);
 assert.equal(detail.counts.recenters,1);
});
test('RangeKeeper observed-flow accounting snapshot feeds provisional position and history economics only with eligible mark-bound references',async()=>{
 const now=Math.floor(Date.now()/1000),address=(digit:string)=>`0x${digit.repeat(40)}`,
  hash=`0x${'a'.repeat(64)}`,profile=marketProfileSchema.parse({pool:{chainId:4663,
   factory:UNISWAP_V3_FACTORY,pool:address('1'),token0:address('2'),token1:address('3'),
   quoteToken:0,decimals0:6,decimals1:18,fee:3000,tickSpacing:60,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
   poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,
   quoterCodeHash:hash,reference0:'USDG/USD',reference1:'AAPL/USD',nativeReference:'ETH/USD',numeraire:'USD'},
   referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
    token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
    nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}}),sqrt=sqrtRatioAtTick(0),liquidity=10n**12n,
  source={block:'102',hash:`0x${'d'.repeat(64)}`,timestamp:now-5},campaignId='00000000-0000-4000-8000-000000000003',
  proof={token0:{asset:{oracle:{flags:{priceFresh:true}}}},token1:{asset:{oracle:{flags:{priceFresh:true}}}},
   native:{asset:{oracle:{flags:{priceFresh:true}}}}},proofHash=referenceProofHash(proof),
  reference={price0:'1000000000000000000',price1:'2000000000000000000',nativePrice:'3000000000000000000',
   proofHash,proof,eligible:true},
  mark={id:'3',at:new Date(source.timestamp*1000),source_block:source.block,source_hash:source.hash,
   accounting_snapshot:null,accounting_hash:null,rangekeeper_accounting_snapshot:null,
   rangekeeper_accounting_hash:null,conversion_accounting_snapshot:null,conversion_accounting_hash:null,
   accounting_invalidated_at:null,accounting_invalidation_reason:null,
   inventory:{classification:'rangekeeper_paper_mark_v1',position:{tickLower:-60,tickUpper:60,
    liquidity:String(liquidity)},idle:{token0:'7',token1:'11'}},economics:{principalOnlyValue:'100000000000000000000'},
   provenance:{classification:'rangekeeper_paper_mark_v1',epoch:0,source,reference,
    poolState:{tick:0,sqrtPriceX96:String(sqrt)}}},
  snapshot={policyVersion:RANGEKEEPER_PAPER_ACCOUNTING_POLICY,classification:'provisional_paper_scenario',
   campaignId,sourceMarkId:mark.id,markKind:'valuation' as const,source,profileHash:contentHash(profile),epoch:0,
   reference,feeEvidence:null,modeledCosts:{initialOpenBoundValue:'2000000000000000000',
    initialOpenBoundWei:'100',cumulativeBoundValue:'3000000000000000000',cumulativeBoundWei:'150',
    paidCostsAvailable:false as const},inventory:{token0Raw:'1000000',token1Raw:'500000000000000000',
    nativeWei:'250',principal0Raw:'999995',principal1Raw:'499999999999999995',fee0Raw:'5',fee1Raw:'5',
    cumulativeGasWei:null,hasLiquidity:true},economics:{initialCapitalQuote:'100000000000000000000',
    netNavQuote:'123000000000000000000',passiveQuote:'120000000000000000000',absolutePnlQuote:'23000000000000000000',
    alphaQuote:'3000000000000000000',cumulativeFeeValueQuote:'5000000000000000000',
    cumulativeGasExpenseQuote:null,intervalFeeAccrualQuote:'1000000000000000000',markGasExpenseQuote:null},
   limitations:['modeled_hypothetical_fee_share' as const,'modeled_costs_not_paid' as const,
    'retained_fees_not_reinvested' as const,'lower_integer_allocation_point' as const]},
  row={id:campaignId,mode:'paper',lifecycle:'active',range_state:'inside',current_revision:1,
   created_at:new Date((now-120)*1000),closed_at:null,allocation:{token0Raw:'1000000',token1Raw:'500000000000000000',nativeWei:'1000'},
   runtime_identity:{},profile,strategy_id:'rangekeeper_v1',config:{},mark_id:mark.id,mark_at:mark.at,
   source_block:source.block,source_hash:source.hash,inventory:mark.inventory,economics:mark.economics,
   provenance:mark.provenance,initial_value:'99000000',operation_id:null,operation_kind:null,
   operation_status:null,operation_stage:null,operation_reason:null,operation_updated_at:null,
   accounting_snapshot:null,accounting_hash:null,rangekeeper_accounting_snapshot:snapshot,
   rangekeeper_accounting_hash:contentHash(snapshot),conversion_accounting_snapshot:null,
   conversion_accounting_hash:null,accounting_invalidated_at:null,accounting_invalidation_reason:null},
  withReference=(value:any)=>({...mark.provenance,reference:value}),
  makeDetail=async(snapshotValue:any,provenanceValue:any=mark.provenance,historyOverride?:any[])=>{
   const savedMark={...mark,provenance:provenanceValue,rangekeeper_accounting_snapshot:snapshotValue,
    rangekeeper_accounting_hash:snapshotValue?contentHash(snapshotValue):null};
   return readDeploymentDetail({query:async(sql:string)=>({rows:sql.includes('FROM deployment_marks m')?
    historyOverride??[savedMark]:[]})} as any,
    {...row,provenance:provenanceValue,rangekeeper_accounting_snapshot:snapshotValue,
     rangekeeper_accounting_hash:snapshotValue?contentHash(snapshotValue):null} as any,24);
  };
 const valid=await makeDetail(snapshot),validPoint:any=valid.performance.timeline.at(-1);
 assert.equal(valid.position.accounting,'provisional');assert.equal(valid.position.navQuote,'123000000');
 assert.equal(valid.position.initialQuote,'100000000','the modeled baseline includes initial native inventory');
 assert.equal(valid.position.holdQuote,'120000000');assert.equal(valid.position.feesQuote,'5000000');
 assert.equal(valid.position.swapQuote,null);
 assert.equal(valid.position.deployment.accounting?.modeledCosts?.cumulativeBoundValue,'3000000');
 assert.equal(valid.position.gasQuote,null);assert.equal(validPoint.economicNavQuote,'123000000');
 assert.equal(validPoint.holdQuote,'120000000');assert.equal(validPoint.feesThisIntervalQuote,'1000000');
 const policyProof={token0:{basis:'heartbeat_valid',oracle:{flags:{priceFresh:true}}},
  token1:{basis:'heartbeat_valid',oracle:{flags:{priceFresh:true}},
   asset:{oracle:{flags:{priceFresh:false}}}},native:{flags:{priceFresh:true}}},
  policyReference={...reference,proof:policyProof,proofHash:referenceProofHash(policyProof)};
 assert.equal((await makeDetail({...snapshot,reference:policyReference},withReference(policyReference))).position.navQuote,
  '123000000','the unused risk diagnostic oracle cannot override the selected policy-valid oracle');
 const rejectedProof={...policyProof,token1:{...policyProof.token1,oracle:{flags:{priceFresh:false}}}},
  rejectedReference={...reference,proof:rejectedProof,proofHash:referenceProofHash(rejectedProof)};
 assert.equal((await makeDetail({...snapshot,reference:rejectedReference},withReference(rejectedReference))).position.accounting,
  'unavailable','stale selected reference evidence still fails closed');
 const staleProof={...proof,token1:{asset:{oracle:{flags:{priceFresh:false}},reasons:['oracle_price_stale']}}},
  staleReference={...reference,proof:staleProof,proofHash:referenceProofHash(staleProof),eligible:false},
  staleSnapshot={...snapshot,reference:staleReference,economics:{initialCapitalQuote:null,netNavQuote:null,
   passiveQuote:null,absolutePnlQuote:null,alphaQuote:null,cumulativeFeeValueQuote:null,
   cumulativeGasExpenseQuote:null,intervalFeeAccrualQuote:null,markGasExpenseQuote:null}},
  stale=await makeDetail(staleSnapshot,withReference(staleReference));
 assert.equal(stale.position.accounting,'provisional');assert.equal(stale.position.navQuote,null);
 assert.equal(stale.position.holdQuote,null);assert.equal(stale.position.feesQuote,null);
 assert.equal(stale.position.referencePriceQuoteX18,null);assert.equal(stale.position.deployment.passiveTokenValue,null);
 assert.equal(stale.position.deployment.accounting?.modeledCosts?.cumulativeBoundValue,'3000000');
 assert.deepEqual(stale.position.deployment.accounting?.retainedModeledFees,{token0Raw:'5',token1Raw:'5'});
 assert.equal((await makeDetail(snapshot,withReference(staleReference))).position.accounting,'unavailable');
 assert.equal((await makeDetail({...snapshot,reference:{...reference,eligible:false},economics:staleSnapshot.economics},withReference({...reference,eligible:false}))).position.accounting,'provisional');
 assert.equal((await makeDetail(snapshot,withReference({...reference,price1:'3000000000000000000'}))).position.accounting,'unavailable');
 assert.equal((await makeDetail({...snapshot,source:{...source,block:'103'}})).position.accounting,'unavailable');
 const weakFreshProof={...proof,token1:{asset:{oracle:{flags:{priceFresh:true,fresh:false}}}}},
  weakFreshReference={...reference,proof:weakFreshProof,proofHash:referenceProofHash(weakFreshProof)},
  weakFreshSnapshot={...snapshot,reference:weakFreshReference},
  weakFreshProvenance=withReference(weakFreshReference);
 assert.equal((await makeDetail(weakFreshSnapshot,weakFreshProvenance)).position.accounting,'unavailable');
 const latestSource={...source,block:'103',hash:`0x${'e'.repeat(64)}`,timestamp:source.timestamp+2},
  latestMark={...mark,id:'4',at:new Date(latestSource.timestamp*1000),source_block:latestSource.block,
   source_hash:latestSource.hash,provenance:{...mark.provenance,source:latestSource}},
  pendingRow:any={...row,mark_id:latestMark.id,mark_at:latestMark.at,source_block:latestMark.source_block,
   source_hash:latestMark.source_hash,inventory:latestMark.inventory,economics:latestMark.economics,
   provenance:latestMark.provenance,rangekeeper_accounting_snapshot:null,rangekeeper_accounting_hash:null,
   rk_previous_mark_id:mark.id,rk_previous_mark_at:mark.at,rk_previous_source_block:mark.source_block,
   rk_previous_source_hash:mark.source_hash,rk_previous_inventory:mark.inventory,
   rk_previous_economics:mark.economics,rk_previous_provenance:mark.provenance,
   rk_previous_accounting_snapshot:snapshot,rk_previous_accounting_hash:contentHash(snapshot)},
  pendingPosition=deploymentPosition(pendingRow);
 assert.equal(pendingPosition.navQuote,'123000000');
 assert.equal(pendingPosition.sourceAt,new Date(latestSource.timestamp*1000).toISOString(),
  'latest operational source remains unchanged');
 assert.equal(pendingPosition.economicsSourceAt,new Date(source.timestamp*1000).toISOString());
 assert.equal(pendingPosition.deployment.rangekeeper!.latestMarkId,latestMark.id);
 assert.equal(pendingPosition.deployment.rangekeeper!.economicsPendingCurrentMark,true);
 const olderSource={block:'90',hash:`0x${'f'.repeat(64)}`,timestamp:now-300},
  olderMark={...mark,id:'2',at:new Date(olderSource.timestamp*1000),source_block:olderSource.block,
   source_hash:olderSource.hash,provenance:{...mark.provenance,source:olderSource}},
  olderSnapshot={...snapshot,source:olderSource,sourceMarkId:olderMark.id},
  olderFallback={...pendingRow,rk_previous_mark_id:olderMark.id,rk_previous_mark_at:olderMark.at,
   rk_previous_source_block:olderMark.source_block,rk_previous_source_hash:olderMark.source_hash,
   rk_previous_inventory:olderMark.inventory,rk_previous_economics:olderMark.economics,
   rk_previous_provenance:olderMark.provenance,rk_previous_accounting_snapshot:olderSnapshot,
   rk_previous_accounting_hash:contentHash(olderSnapshot)},
  olderPosition=deploymentPosition(olderFallback);
 assert.equal(olderPosition.navQuote,'123000000','a complete historical mark remains available beyond 180 seconds');
 assert.equal(olderPosition.economicsSourceAt,new Date(olderSource.timestamp*1000).toISOString());
 assert.equal(olderPosition.sourceAt,new Date(latestSource.timestamp*1000).toISOString());
 assert.equal(olderPosition.deployment.rangekeeper!.economicsPendingCurrentMark,true);
 const futureSource={...olderSource,block:'105',hash:`0x${'8'.repeat(64)}`,timestamp:now+30},
  futureMark={...olderMark,source_block:futureSource.block,source_hash:futureSource.hash,
   provenance:{...olderMark.provenance,source:futureSource}},
  futureSnapshot={...olderSnapshot,source:futureSource},
  futureFallback={...olderFallback,rk_previous_mark_at:new Date(futureSource.timestamp*1000),
   rk_previous_source_block:futureSource.block,rk_previous_source_hash:futureSource.hash,
   rk_previous_provenance:futureMark.provenance,rk_previous_accounting_snapshot:futureSnapshot,
   rk_previous_accounting_hash:contentHash(futureSnapshot)};
 assert.equal(deploymentPosition(futureFallback).navQuote,null,'future-dated economic evidence is never displayed');
 const otherEpoch={...pendingRow,rk_previous_provenance:{...mark.provenance,epoch:1}};
 assert.equal(deploymentPosition(otherEpoch).navQuote,null,'a prior epoch cannot supply current economics');
 const ineligiblePreviousReference={...reference,eligible:false},ineligiblePrevious={...pendingRow,
   rk_previous_provenance:{...mark.provenance,reference:ineligiblePreviousReference},
   rk_previous_accounting_snapshot:{...snapshot,reference:ineligiblePreviousReference,
    economics:{initialCapitalQuote:null,netNavQuote:null,passiveQuote:null,absolutePnlQuote:null,
     alphaQuote:null,cumulativeFeeValueQuote:null,cumulativeGasExpenseQuote:null,
     intervalFeeAccrualQuote:null,markGasExpenseQuote:null}}};
 ineligiblePrevious.rk_previous_accounting_hash=contentHash(ineligiblePrevious.rk_previous_accounting_snapshot);
 assert.equal(deploymentPosition(ineligiblePrevious).navQuote,null,'an ineligible reference cannot supply fallback economics');
 assert.equal(deploymentPosition({...pendingRow,rk_previous_invalidated_at:new Date()}).navQuote,null,
  'an invalidated accounting source cannot supply fallback economics');
 const sparseMark={...mark,id:'4',at:new Date((source.timestamp+1)*1000),source_block:'103',
  source_hash:`0x${'e'.repeat(64)}`,rangekeeper_accounting_snapshot:null,rangekeeper_accounting_hash:null,
  provenance:{...mark.provenance,source:{...source,block:'103',hash:`0x${'e'.repeat(64)}`,timestamp:source.timestamp+1}}},
  sparse=await makeDetail(snapshot,mark.provenance,[mark,sparseMark]),sparsePoint:any=sparse.performance.timeline.at(-1);
 assert.equal(sparsePoint.economicNavQuote,null);assert.equal(sparsePoint.holdQuote,null);
 assert.equal(sparsePoint.feesThisIntervalQuote,null);assert.equal(sparsePoint.referencePriceQuoteX18,null);
});
test('downsampling preserves full performance totals and entry / recenter markers',()=>{
 const start=Date.parse('2026-09-12T12:00:00Z');
 const ps=Array.from({length:2200},(_,i)=>point(new Date(start+i*1000).toISOString(),String(100000000+i),{action:i===1199?'recenter':'mark',feesThisIntervalQuote:'1'}));
 const w=positionWindow(ps,168,start+2200*1000,'100000000',ps[0]!.sourceAt);
 assert(w.sampled);assert(w.timeline.length<ps.length);assert(w.timeline.some(p=>p.action==='recenter'));assert.equal(total(w.rows,'netPnlQuote'),2199n);assert.equal(total(w.rows,'feeIncomeQuote'),2200n);
});
test('RangeKeeper live ledger values only an eligible recorded mark',()=>{
 const state={id:'470e5f84-ab82-4735-92f9-57e96c05b344',phase:'holding',desired:'running',createdAt:1790000401,
  expiresAt:1790043601,closedAt:null,activeTokenId:1259529n,lastReason:'inside_range',
  initial0:250000000n,initial1:0n,initialStrategyValue:250000000000000000000n,reserve0:0n,reserve1:0n,costEvents:[],
  last:{tick:218070,source:{block:68950417n,hash:'0xabc',timestamp:1790009091},
   position:{tokenId:1259529n,liquidity:6859071559694655n,tickLower:218050,tickUpper:218090},
   wallet0:3317684n,wallet1:57521280515648516n,nativeWei:8271603109714364n,
   allowances:[{amount:0n},{amount:0n}]}};
 const config={pool:{fee:500,quoteToken:0,decimals0:6,decimals1:18,reference1:'AAPL/USD'}};
 const mark={source:state.last.source,phase:'holding',nav:252000000000000000000n,gasValue:1000000000000000000n,
  inventory0:120000000n,inventory1:400000000000000000n,grossFee0:100000n,grossFee1:0n,
  exposurePpm:520000,poolPriceTick:218070,activeTokenId:1259529n,
  reference:{eligible:true,price0:1000000000000000000n,price1:330000000000000000000n}};
 const row={id:state.id,state:JSON.parse(rangeKeeperJson(state)),config,valuation:JSON.parse(rangeKeeperJson(mark)),
  heartbeat_at:new Date('2026-09-21T16:45:24Z'),monitor:[]};
 const position=rangeKeeperPosition(row as any);
 assert.equal(position.asset,'AAPL');assert.equal(position.mode,'live');assert.equal(position.status,'open');
 assert.equal(position.history,false);assert.equal(position.hasLiquidity,true);assert.equal(position.tokenId,'1259529');
 assert.equal(position.rangekeeper.tickUpper!-position.rangekeeper.tickLower!,40);
 assert.equal(position.rangekeeper.nonzeroAllowances,0);
 assert.equal(position.navQuote,'251000000');assert.equal(position.holdQuote,'250000000');
 assert.equal(position.feesQuote,'100000');assert.equal(position.range!.length,2);
 assert.equal(rangeKeeperPosition({...row,valuation:null} as any).navQuote,null);
 assert.equal(rangeKeeperPosition({...row,state:JSON.parse(rangeKeeperJson({...state,
  expiresAt:Number.MAX_SAFE_INTEGER}))} as any).rangekeeper.expiresAt,null);
});
test('RangeKeeper detail exposes recorded value and range history to the shared chart',async()=>{
 const now=Math.floor(Date.now()/1000),id='470e5f84-ab82-4735-92f9-57e96c05b344';
 const last={tick:218070,source:{block:10n,hash:'0xabc',timestamp:now-60},
  position:{tokenId:123n,liquidity:1000n,tickLower:218050,tickUpper:218090},wallet0:10000000n,wallet1:0n,nativeWei:0n,allowances:[]};
 const state={id,createdAt:now-180,expiresAt:now+3600,closedAt:null,phase:'holding',desired:'running',
  activeTokenId:123n,last,lastReason:'inside_range',initial0:250000000n,initial1:0n,
  initialStrategyValue:250000000000000000000n,reserve0:0n,reserve1:0n,costEvents:[],recenters:0};
 const config={pool:{fee:500,quoteToken:0,decimals0:6,decimals1:18,reference1:'AAPL/USD'}};
 const valuation=(timestamp:number,nav:bigint)=>({source:{block:BigInt(timestamp),timestamp},phase:'holding',nav,
  gasValue:0n,inventory0:10000000n,inventory1:0n,grossFee0:0n,grossFee1:0n,exposurePpm:0,
  poolPriceTick:218070,activeTokenId:123n,
  reference:{eligible:true,price0:1000000000000000000n,price1:330000000000000000000n}});
 const marks=[valuation(now-120,250000000000000000000n),valuation(now-60,251000000000000000000n)]
  .map((m,i)=>({id:String(i+1),at:new Date(m.source.timestamp*1000),snapshot:JSON.parse(rangeKeeperJson(m))}));
 const row={id,state:JSON.parse(rangeKeeperJson(state)),config,valuation:marks[1]!.snapshot,
  first_source_timestamp:String(now-120),heartbeat_at:new Date(),monitor:[]};
 const db={query:async(sql:string)=>({rows:sql.includes('FROM rangekeeper_v1.transitions')?
  [{at:new Date((now-150)*1000),state:row.state}]:sql.includes('kind=\'valuation\' AND at>=$2')?
  marks:[]})};
 const detail=await rangeKeeperDetail(db as any,row as any,1);
 assert.equal(detail.performance.markCount,2);
 assert.equal(detail.performance.timeline[0]!.action,'enter');
 assert.equal(detail.performance.timeline[1]!.economicNavQuote,'251000000');
 assert.equal(detail.performance.timeline[1]!.tickLower,218050);
 assert.equal(detail.performance.rows.reduce((n,r)=>n+BigInt(r.netPnlQuote??0),0n),1000000n);
});
test('HTTP position endpoint validates identifiers and permits 168 hours; legacy stays behind diagnostics',async()=>{
 const requests:any[]=[];const server=createDashboardServer({snapshot:async()=>({} as any),positions:async(id,hours)=>{requests.push({id,hours});return id==='paper-999'?null:{positions:[]};}},
  {...loadDashboardConfig({DATABASE_URL:'postgresql://unused/test'}),port:0});
 await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 try{
  assert.equal((await fetch(base+'/api/positions/paper-60?hours=168')).status,200);assert.deepEqual(requests[0],{id:'paper-60',hours:168});
  assert.equal((await fetch(base+'/api/positions/paper-adaptive-nvda?hours=24')).status,200);assert.deepEqual(requests[1],{id:'paper-adaptive-nvda',hours:24});
  assert.equal((await fetch(base+'/api/positions/live-rk-470e5f84-ab82-4735-92f9-57e96c05b344')).status,200);
  assert.equal((await fetch(base+'/api/positions/paper-dep-470e5f84-ab82-4735-92f9-57e96c05b344?hours=168')).status,200);
  assert.deepEqual(requests[3],{id:'paper-dep-470e5f84-ab82-4735-92f9-57e96c05b344',hours:168});
  assert.equal((await fetch(base+'/api/positions/live-dep-470e5f84-ab82-4735-92f9-57e96c05b344')).status,200);
  assert.equal((await fetch(base+'/api/positions/paper-60?hours=0')).status,200);
  assert.deepEqual(requests[5],{id:'paper-60',hours:0});
  assert.equal((await fetch(base+'/api/positions/paper-60?hours=720')).status,200);
  assert.deepEqual(requests[6],{id:'paper-60',hours:720});
  assert.equal((await fetch(base+'/api/positions/paper-60?hours=169')).status,400);assert.equal((await fetch(base+'/api/positions/nope')).status,400);
  assert.equal((await fetch(base+'/api/positions/paper-dep-not-a-uuid')).status,400);
  assert.equal((await fetch(base+'/api/positions/paper-999')).status,404);assert.equal((await fetch(base+'/api/positions',{method:'POST'})).status,405);
  const page=await fetch(base+'/');assert.match(await page.text(),/Positions/);assert.match(page.headers.get('Content-Security-Policy')??'',/script-src 'self'/);
  assert.equal((await fetch(base+'/legacy')).status,200);
  for(const path of ['/preview','/preview/','/preview/app.js','/preview/styles.css','/prototype','/prototype/app.js'])
   assert.equal((await fetch(base+path)).status,404,'design fixtures must not be served by the runtime');
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
test('research endpoints enforce bounded capital and bind pool detail to summary snapshot',async()=>{
 const requests:any[]=[];const snapshotId='research:stream:2026-09-29T10:00:00.000Z';
 const server=createDashboardServer({snapshot:async()=>({} as any),
  research:async(capitalQuoteRaw='250000000')=>({snapshotId,capitalQuoteRaw}),
  researchDetails:async(input)=>{requests.push(input);return input.snapshotId===snapshotId?
   {snapshotId,pool:{poolAddress:input.poolAddress}}:{error:'research_snapshot_changed'};}},
  {...loadDashboardConfig({DATABASE_URL:'postgresql://unused/test'}),port:0});
 await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 const pool='0x'+'1'.repeat(40);const query=new URLSearchParams({pool,capitalQuoteRaw:'250000000',hours:'24',width:'2',snapshotId});
 try{
  const summary=await fetch(base+'/api/research');assert.equal(summary.status,200);
  assert.deepEqual(await summary.json(),{snapshotId,capitalQuoteRaw:'250000000'});
  assert.equal((await fetch(base+'/api/research?capitalQuoteRaw=100000000001')).status,400);
  const detail=await fetch(base+'/api/research/details?'+query.toString());assert.equal(detail.status,200);
  assert.deepEqual(requests[0],{poolAddress:pool,capitalQuoteRaw:'250000000',hours:24,width:2,snapshotId});
  const changed=await fetch(base+'/api/research/details?'+new URLSearchParams({...Object.fromEntries(query),snapshotId:'research:old'}));
  assert.equal(changed.status,409);assert.deepEqual(await changed.json(),{error:'research_snapshot_changed'});
  assert.equal((await fetch(base+'/api/research?capitalQuoteRaw=1&capitalQuoteRaw=2')).status,400);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
