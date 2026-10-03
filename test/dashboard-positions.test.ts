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
import {readDeploymentDetail} from '../src/dashboard/deployment-position.js';

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
   provenance:mark.provenance,initial_value:'100000000',operation_id:null,operation_kind:null,
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
