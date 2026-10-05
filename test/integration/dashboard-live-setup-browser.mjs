// Run with `node --import tsx test/integration/dashboard-live-setup-browser.mjs`.
// This serves the real dashboard assets from a disposable loopback mock server.
// No database, RPC, signer, worker, or production service is used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startDashboardBrowser,wait} from './helpers/dashboard-browser.mjs';

const dashboardRoot=resolve(fileURLToPath(new URL('../../dashboard/',import.meta.url)));
const token=(n)=>`0x${n.toString(16).padStart(40,'0')}`;
const feeProfiles=[['AAPL',500],['AAPL',3000],['AAPL',10000],['NVDA',500],['NVDA',3000],
 ['GOOGL',500],['GOOGL',3000],['SPY',500],['SPY',3000],['QQQ',500],['QQQ',3000],['MSFT',3000]];
const profiles=feeProfiles.map(([symbol,fee],index)=>({
 id:`${String(index+1).padStart(8,'0')}-1111-4111-8111-${String(index+1).padStart(12,'0')}`,
 profileHash:`${String(index+1).repeat(64).slice(0,64)}`,pool:token(100+index),fee,
 tickSpacing:fee===500?10:fee===3000?60:200,
 token0:index%3===0?token(1):token(200+index),token1:index%3===0?token(200+index):token(1),
 decimals0:index%3===0?6:18,decimals1:index%3===0?18:6,quoteToken:index%3===0?0:1,
 reference0:index%3===0?'USDG/USD':`${symbol}/USD`,reference1:index%3===0?`${symbol}/USD`:'USDG/USD',
 draftAvailable:index<3,
}));
const researchPools=profiles.map((profile,index)=>({poolAddress:profile.pool,fee:profile.fee,tickSpacing:profile.tickSpacing,
 rwaSymbol:feeProfiles[index][0],registryEnabled:true,poolLiquidityRaw:'1000000000000000000000',
 volumeQuoteRaw:'1000000',swapCount:0,sourceFreshness:{status:'fresh'}}));
const livePoolOrder=profiles.map((profile,index)=>({pool:profile.pool,symbol:feeProfiles[index][0],fee:profile.fee}))
 .sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.fee-b.fee).map(row=>row.pool);
const apiCalls=[];let walletMode='available',preflightMode='valid',admissionMode='ambiguous-once',admissionPosts=0;
// Worker readiness as the command service reports it: absent (older server), ready, or not ready with a reason.
let workerMode='not-connected',positionsMode='multi',retainQueued=false;
const workerStates={absent:undefined,ready:{ready:true,missing:[]},
 'not-connected':{ready:false,missing:['live_wallet_worker_not_connected']},
 stale:{ready:false,missing:['canonical_wallet_snapshot_stale']},
 schema:{ready:false,missing:['live_runtime_or_wallet_history_schema_unavailable']},
 multiple:{ready:false,missing:['live_wallet_worker_not_connected','canonical_wallet_snapshot_stale']}};
// As the command service reports it, admission already includes worker readiness.
const workerAdmission=()=>admissionMode!=='disabled'&&(workerStates[workerMode]===undefined||workerStates[workerMode].ready===true);
const campaignId=n=>`aaaaaaaa-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hashOf=c=>`0x${c.repeat(64)}`;
const nowIso=new Date().toISOString();
const iso=ms=>new Date(Date.now()-ms).toISOString();
const emptyJob=null;
// The valuation block the projection attaches to every RangeKeeper row: which oracle basis the headline numbers use.
const hoursAgoIso=hours=>new Date(Date.now()-hours*3_600_000).toISOString();
const valuationOf=(basis,{ageHours=38,symbol='AAPL',poolImplied='189500000',reasons=[]}={})=>basis==='oracle_fresh'?
 {basis,priceAsOf:iso(30_000),priceAgeAtMarkSeconds:30,feeds:[{name:'token0',symbol:'USDG',state:'fresh'},{name:'token1',symbol,state:'fresh'},{name:'native',symbol:'ETH',state:'fresh'}],
  freshnessReasons:[],structuralReasons:[],poolImplied:{navQuote:poolImplied,priceQuoteX18:'219000000000000000000'}}:
 basis==='last_oracle_price'?{basis,priceAsOf:hoursAgoIso(ageHours),priceAgeAtMarkSeconds:ageHours*3600,
  feeds:[{name:'token0',symbol:'USDG',state:'fresh'},{name:'token1',symbol,state:'stale',updatedAt:hoursAgoIso(ageHours)},{name:'native',symbol:'ETH',state:'fresh'}],
  freshnessReasons:['token1_reference_age_unacceptable'],structuralReasons:[],poolImplied:{navQuote:poolImplied,priceQuoteX18:'219000000000000000000'}}:
 {basis:'unavailable',priceAsOf:null,priceAgeAtMarkSeconds:null,feeds:[],freshnessReasons:[],structuralReasons:reasons,
  poolImplied:poolImplied===null?null:{navQuote:poolImplied,priceQuoteX18:'219000000000000000000'}};
// One mock row per live lifecycle. Economics the server could not prove are null, never zero.
function livePosition({n,asset,label,lifecycle,status,rangeState='inside',job=emptyJob,nftId=null,nav=null,fees=null,gas=null,
 range=null,blockedReason=null,history=false,recenters=null,paidGasWei=null,nextAction=null,accounting='unavailable',valuation=null,
 scope={maxDurationSeconds:0,maxEconomicActions:0,openEnded:true,expiresAt:null,economicActions:null}}){
 const id=`live-dep-${campaignId(n)}`;
 return {id,label,mode:'live',asset,quote:'USDG',fee:3000,quoteIsToken0:true,hasLiquidity:nftId!==null&&lifecycle!=='closed',status,history,
  initialQuote:nav===null?'250000000':'250000000',navQuote:nav,holdQuote:nav,feesQuote:fees,gasQuote:gas,swapQuote:null,exitEstimateQuote:null,drawdownPpm:null,
  createdAt:iso(3_600_000),endedAt:history?iso(60_000):null,sourceAt:nav===null?null:iso(20_000),heartbeatAt:iso(20_000),
  reasons:nav===null&&!['queued','opening'].includes(lifecycle)?['live_valuation_unavailable']:[],economicsSourceAt:null,invalidatedAt:null,reserveQuote:null,
  strategy:{live:true},range,priceQuoteX18:range?'220000000000000000000':null,referencePriceQuoteX18:null,
  inventory:{tokens:[{address:token(1),symbol:'USDG',decimals:6,allocatedRaw:'200000000',amountRaw:null,lowerBoundRaw:null},
   {address:token(208),symbol:asset,decimals:18,allocatedRaw:'340000000000000000',amountRaw:null,lowerBoundRaw:null}],
   exposurePpm:null,nativeWei:null,principalOnlyValue:null,passiveTokenValue:null},
  tokenId:nftId,accounting,nextAction,...(valuation?{valuation}:{}),
  deployment:{campaignId:campaignId(n),chainId:4663,pool:token(108),strategyId:'rangekeeper_v1',lifecycle:history?'closed':lifecycle==='queued'||lifecycle==='opening'?'opening':lifecycle==='blocked'?'blocked':'active',
   rangeState,revision:1,operation:{id:job?.id??null,kind:job?.kind??null,status:job?.status??null,stage:job?.stage??null,reason:blockedReason,updatedAt:nowIso},
   sourceBlock:nav===null?null:'12345',sourceHash:nav===null?null:hashOf('a'),rangekeeper:{currentEpoch:0,latestMarkId:null},
   token0:{address:token(1),symbol:'USDG',decimals:6,allocatedRaw:'200000000',amountRaw:null,lowerBoundRaw:null},
   token1:{address:token(208),symbol:asset,decimals:18,allocatedRaw:'340000000000000000',amountRaw:null,lowerBoundRaw:null},
   poolTick:0,lowerBoundValue:null,passiveTokenValue:null,conversionAccountingStatus:'not_applicable',accounting:null,accountingInvalidation:null,unavailable:['net_nav'],
   live:{lifecycle,phase:lifecycle==='holding'?'holding':null,job,blockedReason,nftId,
    range:{state:rangeState,tick:0,tickLower:range?-600:null,tickUpper:range?600:null},
    allocation:{token0Raw:'200000000',token1Raw:'340000000000000000',nativeWei:'6000000000000000'},scope,recenters,paidGasWei,runtimeVerified:true,valuationAvailable:nav!==null}}};
}
const liveJob=(extra)=>({id:'55555555-5555-4555-8555-555555555500',kind:'open',status:'succeeded',inFlight:false,stage:null,stageKind:null,stageStatus:null,
 nonce:null,txHash:null,attempt:1,createdAt:iso(3_000_000),updatedAt:iso(2_000_000),...extra});
const multiPositions=()=>[
 livePosition({n:1,asset:'AAPL',label:'RK-aaaaaaaa',lifecycle:retainQueued?'closing':'holding',status:retainQueued?'exiting':'open',nftId:'1000',nav:'251250000',fees:'1800000',gas:'120000',
  range:['210000000000000000000','230000000000000000000'],recenters:2,paidGasWei:'120000000000000',accounting:'recorded',valuation:valuationOf('oracle_fresh'),scope:{maxDurationSeconds:0,maxEconomicActions:0,openEnded:true,expiresAt:null,economicActions:3},
  job:retainQueued?liveJob({id:'55555555-5555-4555-8555-555555555501',kind:'close_retain',status:'queued',inFlight:true,createdAt:nowIso,updatedAt:nowIso}):liveJob({nonce:'998',txHash:hashOf('1'),stageKind:'approve',stageStatus:'confirmed'})}),
 livePosition({n:2,asset:'NVDA',label:'RK-aaaaaaab',lifecycle:'holding',status:'outside',rangeState:'outside',nftId:'999',nav:'249000000',fees:'900000',gas:'90000',
  range:['120000000000000000000','140000000000000000000'],recenters:0,paidGasWei:'90000000000000',accounting:'recorded',valuation:valuationOf('last_oracle_price',{ageHours:38,symbol:'NVDA',poolImplied:'248500000'}),
  scope:{maxDurationSeconds:43200,maxEconomicActions:4,openEnded:false,expiresAt:new Date(Date.now()+5*3600_000).toISOString(),economicActions:1},job:liveJob({nonce:'997',txHash:hashOf('2')})}),
 livePosition({n:3,asset:'GOOGL',label:'RK-aaaaaaac',lifecycle:'recentering',status:'recentring',nftId:'1001',nav:'250100000',fees:'400000',gas:'100000',range:['150000000000000000000','170000000000000000000'],
  recenters:1,paidGasWei:'200000000000000',accounting:'recorded',valuation:valuationOf('last_oracle_price',{ageHours:38,symbol:'GOOGL',poolImplied:'250400000'}),
  job:liveJob({id:'55555555-5555-4555-8555-555555555503',kind:'change_range',status:'executing',inFlight:true,stage:`withdraw:${'e'.repeat(32)}`,stageKind:'withdraw',stageStatus:'signed',nonce:'1000',txHash:hashOf('3')})}),
 livePosition({n:4,asset:'SPY',label:'RK-aaaaaaad',lifecycle:'queued',status:'waiting',rangeState:'no_liquidity',nextAction:'Live opening queued; inventory and costs await canonical receipts',valuation:valuationOf('unavailable',{poolImplied:null}),
  scope:{maxDurationSeconds:7200,maxEconomicActions:4,openEnded:false,expiresAt:null,economicActions:null},
  job:liveJob({id:'55555555-5555-4555-8555-555555555504',kind:'open',status:'queued',inFlight:true,createdAt:nowIso,updatedAt:nowIso})}),
 livePosition({n:5,asset:'QQQ',label:'RK-aaaaaaae',lifecycle:'blocked',status:'blocked',rangeState:'unknown',blockedReason:`transaction_reverted:55555555-5555-4555-8555-555555555505:mint`,valuation:valuationOf('unavailable',{reasons:['token1_asset_health'],poolImplied:null}),
  job:liveJob({id:'55555555-5555-4555-8555-555555555505',kind:'open',status:'blocked',inFlight:false,stage:`mint:${'f'.repeat(32)}`,stageKind:'mint',stageStatus:'blocked',nonce:'12',txHash:hashOf('4')})}),
 livePosition({n:6,asset:'MSFT',label:'RK-aaaaaaaf',lifecycle:'closed',status:'closed',history:true,rangeState:'no_liquidity',nav:'252000000',fees:'2500000',gas:'200000',
  recenters:3,paidGasWei:'300000000000000',accounting:'recorded',valuation:valuationOf('last_oracle_price',{ageHours:60,symbol:'MSFT'}),job:liveJob({kind:'close_retain',status:'succeeded'})}),
];
// RangeKeeper paper rows: one valued at the last oracle price, one whose oracle failed a structural check.
function paperPosition({n,asset,valuation,nav,hold,fees}){
 const id=campaignId(n+20);
 return {id:`paper-dep-${id}`,label:`RK-bbbbbbb${n}`,mode:'paper',asset,quote:'USDG',fee:3000,quoteIsToken0:true,hasLiquidity:true,status:'open',history:false,
  initialQuote:'170000000',navQuote:nav,holdQuote:hold,feesQuote:fees,gasQuote:null,swapQuote:null,exitEstimateQuote:null,drawdownPpm:null,
  createdAt:iso(3_600_000),endedAt:null,sourceAt:iso(20_000),heartbeatAt:iso(20_000),reasons:[],economicsSourceAt:null,invalidatedAt:null,reserveQuote:null,
  strategy:{live:false},range:['210000000000000000000','230000000000000000000'],priceQuoteX18:'219000000000000000000',
  referencePriceQuoteX18:nav===null?null:'200000000000000000000',
  inventory:{tokens:[{address:token(1),symbol:'USDG',decimals:6,allocatedRaw:'40000000',amountRaw:'50000000',lowerBoundRaw:null},
   {address:token(208),symbol:asset,decimals:18,allocatedRaw:'400000000000000000',amountRaw:'500000000000000000',lowerBoundRaw:null}],
   exposurePpm:nav===null?null:'666666',nativeWei:'10000000000000000',principalOnlyValue:null,passiveTokenValue:null},
  tokenId:null,accounting:'provisional',nextAction:'Provisional modeled scenario; earned fees and paid costs remain unobserved',valuation,
  deployment:{campaignId:id,chainId:4663,pool:token(108),strategyId:'rangekeeper_v1',lifecycle:'active',rangeState:'inside',revision:1,
   operation:{id:null,kind:null,status:null,stage:null,reason:null,updatedAt:null},sourceBlock:'12345',sourceHash:hashOf('a'),
   rangekeeper:{currentEpoch:0,latestMarkId:'5',latestMarkHash:null,latestClassification:'rangekeeper_paper_mark_v1',recenterAvailable:false},
   token0:{address:token(1),symbol:'USDG',decimals:6,allocatedRaw:'40000000',amountRaw:'50000000',lowerBoundRaw:null},
   token1:{address:token(208),symbol:asset,decimals:18,allocatedRaw:'400000000000000000',amountRaw:'500000000000000000',lowerBoundRaw:null},
   poolTick:222390,lowerBoundValue:null,passiveTokenValue:null,conversionAccountingStatus:'not_applicable',
   accounting:{policyVersion:'rangekeeper_paper_observed_flow_v1',classification:'provisional_paper_scenario',feeEvidenceId:null,limitations:[],
    referenceEligible:nav!==null,retainedModeledFees:{token0Raw:'1000000',token1Raw:'5000000000000000'},
    modeledCosts:{cumulativeBoundValue:'3000000',cumulativeBoundWei:'150',paidCostsAvailable:false},conversion:null,capitalOut:null},
   accountingInvalidation:null,unavailable:[]}};
}
const paperPositions=()=>[
 paperPosition({n:1,asset:'AAPL',nav:'180000000',hold:'150000000',fees:'2000000',valuation:valuationOf('last_oracle_price',{ageHours:38,symbol:'AAPL'})}),
 paperPosition({n:2,asset:'NVDA',nav:null,hold:null,fees:null,valuation:valuationOf('unavailable',{reasons:['token1_oracle_description_mismatch'],poolImplied:'189500000'})}),
];
const detailFor=position=>({position,performance:{from:iso(86_400_000),through:nowIso,sourceThrough:nowIso,coveredStart:iso(86_400_000),markCount:0,sampled:false,
 timeline:[],sessions:[],rows:[],gaps:[]},events:[],counts:{recenters:position.deployment.live?.recenters??null,recenterAttempts:0,swaps:0},limitations:[]});
const response=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(body));};
const sendLiveWallet=(res)=>{
 if(walletMode==='unavailable')return response(res,200,{kind:'live_wallet_review',status:'unavailable',walletAddress:token(900),source:null,
  tokens:[],native:null,blockers:['wallet_snapshot_unavailable'],reasons:['no_current_canonical_snapshot']});
 if(walletMode==='stale')return response(res,200,{kind:'live_wallet_review',status:'unavailable',walletAddress:token(900),source:{status:'stale'},
  tokens:[],native:null,blockers:['wallet_snapshot_stale']});
 if(walletMode==='malformed')return response(res,200,{kind:'live_wallet_review',status:'available',walletAddress:token(900),source:'mock_canonical',
  tokens:[{address:token(1),decimals:6,symbol:'USDG',balanceRaw:'not-a-number',allocatedRaw:'bad',pendingRaw:'?',availableRaw:null}],
  native:{balanceWei:'bad',allocatedWei:'?',pendingWei:'x',exitReserveWei:'x',availableWei:'x'},blockers:[],reasons:[]});
 return response(res,200,{kind:'live_wallet_review',status:'available',walletAddress:token(900),source:'mock_canonical',
  tokens:[{address:token(1),decimals:6,symbol:'USDG',balanceRaw:'500000000',allocatedRaw:'100000000',pendingRaw:'25000000',availableRaw:'375000000'},
   {address:token(2),decimals:18,reference:'AAPL/USD',balanceRaw:'9000000000000000000',allocatedRaw:'1000000000000000000',pendingRaw:'0',availableRaw:'8000000000000000000'},
   {address:token(208),decimals:18,reference:'GOOGL/USD',balanceRaw:'3000000000000000000',allocatedRaw:'340000000000000000',pendingRaw:'0',availableRaw:'2660000000000000000'}],
  native:{balanceWei:'20000000000000000',allocatedWei:'2000000000000000',pendingWei:'100000000000000',exitReserveWei:'5000000000000000',availableWei:'12900000000000000'},
  blockers:[],reasons:[],allocationSnapshot:{status:'available'},nftCustody:{status:'available'}});
};
const validLivePreflight=body=>({kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',status:'indicative',
 profileId:body.profileId,profileHash:'a'.repeat(64),input:body,
 profile:{pool:profiles.find(x=>x.id===body.profileId).pool,fee:profiles.find(x=>x.id===body.profileId).fee,
  tickSpacing:profiles.find(x=>x.id===body.profileId).tickSpacing,token0:profiles.find(x=>x.id===body.profileId).token0,
  token1:profiles.find(x=>x.id===body.profileId).token1,quoteToken:profiles.find(x=>x.id===body.profileId).quoteToken,
  decimals0:profiles.find(x=>x.id===body.profileId).decimals0,decimals1:profiles.find(x=>x.id===body.profileId).decimals1},
 source:{block:'12345',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)},
 wallet:{id:'shared-wallet',address:token(900),source:'mock_canonical',
  token0:{balanceRaw:'3000000000000000000',allocatedRaw:'340000000000000000',pendingRaw:'0',freeRaw:'2660000000000000000'},
  token1:{balanceRaw:'500000000',allocatedRaw:'100000000',pendingRaw:'25000000',freeRaw:preflightMode==='shortfall'?'10000000':'375000000'},
  native:{balanceWei:'20000000000000000',allocatedWei:'2000000000000000',pendingWei:'100000000000000',exitReserveWei:'5000000000000000',freeWei:'12900000000000000'}},
 requirements:{token0Raw:'340000000000000000',token1Raw:'12000000',quoteValueRaw:'250000000',freeQuoteRaw:preflightMode==='shortfall'?'200000000':'375000000',
  shortfallQuoteRaw:preflightMode==='shortfall'?'50000000':'0',nativeWei:'6000000000000000'},
 range:{tickLower:-600,tickUpper:600,centerTick:3,fullWidthSpacings:20},
 references:{price0:'1000000000000000000',price1:'2000000000000000000',nativePrice:'2000000000000000000000',proofHash:'b'.repeat(64)},
 costs:{status:'estimated',source:'owned_fork',actionCostValue:'1000000000000000',actionGasWei:'500000000000000',
  completeExitCostValue:'2000000000000000',completeExitGasWei:'1000000000000000',exitReserveWei:'4000000000000000',missing:[]},
 missing:[],blockers:[],actionAvailable:false,draftCreationAvailable:false,operationAcceptanceAvailable:false,
 executionEligible:false,admissionAvailable:workerAdmission(),
 policy:{config:{campaignScope:body.campaignScope},parameters:{campaignScope:body.campaignScope}},
 reviewPersistence:{status:'persisted',reviewId:'33333333-3333-4333-8333-333333333333',reviewHash:'c'.repeat(64),
  expiresAt:new Date(Date.now()+60_000).toISOString(),missing:[]},reason:'rangekeeper_live_execution_unavailable'});
const mockServer=createServer(async(req,res)=>{
 const url=new URL(req.url??'/',`http://${req.headers.host??'127.0.0.1'}`);
 if(url.pathname==='/__fixture-control'){
  walletMode=url.searchParams.get('wallet')??walletMode;
  preflightMode=url.searchParams.get('preflight')??preflightMode;
  admissionMode=url.searchParams.get('admission')??admissionMode;
  workerMode=url.searchParams.get('worker')??workerMode;
  positionsMode=url.searchParams.get('positions')??positionsMode;
  return response(res,200,{walletMode,preflightMode,admissionMode,workerMode,positionsMode});
 }
 if(url.pathname.startsWith('/api/')){
  let body='';for await(const chunk of req)body+=chunk;
  const parsed=body?JSON.parse(body):null;apiCalls.push({method:req.method,path:url.pathname,body:parsed,csrf:req.headers['x-csrf-token']??null});
  if(url.pathname==='/api/session'&&req.method==='POST')return response(res,200,{csrfToken:'fixture-csrf'}, {'set-cookie':'cq_session=fixture; Path=/; SameSite=Strict'});
  if(url.pathname==='/api/positions')return response(res,200,{serverTime:nowIso,positions:positionsMode==='multi'?[...multiPositions(),...paperPositions()]:[],riskAssets:[],riskFreshnessSeconds:120});
  if(url.pathname.startsWith('/api/positions/')&&req.method==='GET'){
   const found=[...multiPositions(),...paperPositions()].find(item=>item.id===decodeURIComponent(url.pathname.slice('/api/positions/'.length)));
   return found?response(res,200,detailFor(found)):response(res,404,{error:'position_not_found'});
  }
  const retainPreview=url.pathname.match(/^\/api\/deployments\/([0-9a-f-]{36})\/live\/retain-preview$/);
  if(retainPreview&&req.method==='POST'){
   if(req.headers['x-csrf-token']!=='fixture-csrf')return response(res,403,{error:'csrf_required'});
   return response(res,200,{kind:'rangekeeper_live_retain_preview',mode:'live',strategyId:'rangekeeper_v1',status:'indicative',trustedPreviewSaved:true,
    previewId:'77777777-7777-4777-8777-777777777777',contentDigest:'d'.repeat(64),expectedRevision:1,expiresAt:new Date(Date.now()+170_000).toISOString(),
    source:{block:'12345',hash:hashOf('a'),timestamp:Math.floor(Date.now()/1000)},position:{tokenId:'1000',tickLower:-600,tickUpper:600},
    costs:{status:'estimated',gasWei:'1000000000000000',exitReserveWei:'4000000000000000'},missing:[],
    ...(workerStates[workerMode]===undefined?{}:{liveWorker:workerStates[workerMode]}),
    actionAvailable:true,operationAcceptanceAvailable:true,executionEligible:false});
  }
  const retainOperation=url.pathname.match(/^\/api\/deployments\/([0-9a-f-]{36})\/live\/retain-operations$/);
  if(retainOperation&&req.method==='POST'){
   if(req.headers['x-csrf-token']!=='fixture-csrf')return response(res,403,{error:'csrf_required'});
   if(!parsed||Object.keys(parsed).sort().join(',')!=='contentDigest,expectedRevision,idempotencyKey,previewId')return response(res,400,{error:'body_shape_invalid'});
   retainQueued=true;
   return response(res,202,{status:'queued',campaignId:retainOperation[1],jobId:'55555555-5555-4555-8555-555555555501',allocationId:'66666666-6666-4666-8666-666666666601',
    replayed:false,executionEligible:false,reason:'rangekeeper_live_execution_unavailable'});
  }
  if(url.pathname==='/api/research')return response(res,200,{snapshotId:'browser-live-setup',generatedAt:new Date().toISOString(),capitalQuoteRaw:url.searchParams.get('capitalQuoteRaw')??'250000000',
   streamKey:'browser-fixture',bucketCount:0,bucketMinutes:60,retainedHours:0,budgetQuote:'250000000',costs:{roundTripQuote:null},pools:[]});
  if(url.pathname==='/api/market-profiles')return response(res,200,{profiles});
  if(url.pathname==='/api/strategies')return response(res,200,{strategies:[
   {id:'static_manual_v1',paper:true,live:false},{id:'rangekeeper_v1',paper:true,live:workerAdmission(),liveSetup:true,
    liveAdmission:workerAdmission(),
    ...(workerStates[workerMode]===undefined?{}:{liveWorker:workerStates[workerMode]})}]});
  if(url.pathname==='/api/deployments/setup-drafts')return response(res,200,{drafts:[]});
  if(url.pathname==='/api/deployments/setup-defaults')return response(res,200,{walletAddress:null});
  if(url.pathname==='/api/deployments/live-wallet'&&req.method==='GET')return sendLiveWallet(res);
  if(url.pathname==='/api/deployments/rangekeeper/live-setup-preflight'&&req.method==='POST'){
   if(req.headers['x-csrf-token']!=='fixture-csrf')return response(res,403,{error:'csrf_required'});
   if(!parsed||Object.keys(parsed).sort().join(',')!=='campaignScope,capitalQuoteRaw,fullWidthSpacings,limits,profileId')return response(res,400,{error:'body_shape_invalid'});
   const scope=parsed.campaignScope;
   if(!scope||Object.keys(scope).sort().join(',')!=='maxDurationSeconds,maxEconomicActions'||!Number.isInteger(scope.maxDurationSeconds)||
    scope.maxDurationSeconds<0||scope.maxDurationSeconds>86400||!Number.isInteger(scope.maxEconomicActions)||scope.maxEconomicActions<0||scope.maxEconomicActions>10)
    return response(res,400,{error:'campaign_scope_invalid'});
   if(preflightMode==='stale'||(preflightMode==='wallet-dependent'&&walletMode!=='available')){
    const walletBlocker=walletMode==='stale'?'wallet_snapshot_stale':walletMode==='malformed'?'wallet_response_malformed':'wallet_snapshot_unavailable';
    return response(res,200,{kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',status:'unavailable',
    wallet:{address:token(900),source:walletMode==='stale'?'stale':'unavailable'},missing:[walletBlocker],blockers:[walletBlocker],actionAvailable:false,
    draftCreationAvailable:false,operationAcceptanceAvailable:false,executionEligible:false});
   }
   if(preflightMode==='flags')return response(res,200,{...validLivePreflight(parsed),actionAvailable:true,missing:['unsafe_flag_fixture']});
   if(preflightMode==='malformed')return response(res,200,{kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',status:'indicative',
    actionAvailable:false,draftCreationAvailable:false,operationAcceptanceAvailable:false,executionEligible:false,
    missing:['malformed_response'],requirements:{token0Raw:'NaN'},costs:{status:'estimated'}});
   return response(res,200,validLivePreflight(parsed));
  }
  if(url.pathname==='/api/deployments/rangekeeper/live-setup-admit'&&req.method==='POST'){
   if(req.headers['x-csrf-token']!=='fixture-csrf')return response(res,403,{error:'csrf_required'});
   if(!parsed||Object.keys(parsed).sort().join(',')!=='requestId,reviewHash,reviewId')return response(res,400,{error:'body_shape_invalid'});
   if(!workerAdmission())return response(res,503,{error:'rangekeeper_live_worker_not_ready',status:'unavailable',missing:['rangekeeper_live_worker_not_ready'],
    actionAvailable:false,executionEligible:false,liveWorker:workerStates[workerMode]??{ready:false,missing:['live_wallet_worker_not_ready']}});
   admissionPosts++;
   if(admissionMode==='ambiguous-once'&&admissionPosts===1)return response(res,503,{error:'fixture_temporary_unavailable'});
   return response(res,201,{status:'queued',campaignId:'44444444-4444-4444-8444-444444444444',
    jobId:'55555555-5555-4555-8555-555555555555',allocationId:'66666666-6666-4666-8666-666666666666',
    replayed:false,executionEligible:false,reason:'rangekeeper_live_execution_unavailable'});
  }
  if(url.pathname==='/api/deployments/setup-preflight'&&req.method==='POST'){
   if(req.headers['x-csrf-token']!=='fixture-csrf')return response(res,403,{error:'csrf_required'});
   return response(res,200,{kind:'paper_setup_preflight',mode:'paper',strategyId:'static_manual_v1',status:'unavailable',
    missing:['paper_fixture_unavailable'],profile:{pool:profiles[0].pool,fee:profiles[0].fee}});
  }
  if(req.method==='POST'&&url.pathname.includes('draft'))return response(res,500,{error:'draft_route_must_not_be_called'});
  if(req.method==='POST'&&url.pathname.includes('open'))return response(res,500,{error:'open_route_must_not_be_called'});
  return response(res,404,{error:'fixture_route_not_found'});
 }
 const requested=url.pathname==='/operator'||url.pathname==='/operator/'?'/index.html':url.pathname;
 const file=resolve(dashboardRoot,`.${requested}`);
 if(!file.startsWith(`${dashboardRoot}/`))return response(res,403,{error:'asset_path_forbidden'});
 try{
  const info=await stat(file);if(!info.isFile())return response(res,404,{error:'asset_not_found'});
  const mime=({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(file)]??'application/octet-stream';
  res.writeHead(200,{'content-type':mime,'cache-control':'no-store'});res.end(await readFile(file));
 }catch{return response(res,404,{error:'asset_not_found'});}
});
mockServer.listen(0,'127.0.0.1');await new Promise(resolve=>mockServer.once('listening',resolve));
const origin=`http://127.0.0.1:${mockServer.address().port}`;
let browser;
const checks=[],runtimeErrors=[];
try{
 browser=await startDashboardBrowser();
 const {page}=browser;
 page.on('Runtime.exceptionThrown',params=>runtimeErrors.push(params.exceptionDetails?.exception?.description??params.exceptionDetails?.text??'runtime_exception'));
 await page.send('Page.enable');await page.send('Runtime.enable');await page.send('Network.enable');
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 const evaluate=page.evaluate, waitFor=page.waitFor;
 const check=async(name,expression)=>{assert.equal(await evaluate(expression),true,name);checks.push(name);};
 // Optional visual evidence: DASHBOARD_SCREENSHOT_DIR=/some/dir writes full-page PNGs at key moments.
 const shot=async(name,selector=null)=>{const dir=process.env.DASHBOARD_SCREENSHOT_DIR;if(!dir)return;await mkdir(dir,{recursive:true});
  const clip=selector?await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(0,r.left+scrollX),y:r.top+scrollY,width:r.width,height:Math.min(r.height,2600),scale:1}})()`):undefined;
  const {data}=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,...(clip?{clip}:{})});await writeFile(join(dir,`${name}.png`),Buffer.from(data,'base64'));};
 const fill=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const select=(selector,value)=>fill(selector,value);
 await page.send('Page.navigate',{url:`${origin}/operator`});await waitFor('document.readyState==="complete"');
 await waitFor('window.concliqOperatorAuthenticated?.()===true&&document.querySelector("#setup-pool").options.length>=3');
 await check('mock service reports live setup review while live execution remains false',
  'document.querySelector("#setup-mode").options[1].value==="live"&&document.querySelector("#setup-strategy").value==="static_manual_v1"');
 await waitFor('document.querySelectorAll("#live tr[data-live-lifecycle]").length===5');
 await waitFor('document.querySelectorAll("#live .live-retain-action-root button").length===2&&[...document.querySelectorAll("#live .live-retain-action-root button")].every(b=>!b.disabled)');
 await check('every current live campaign renders as its own row; the closed one waits in History',
  `JSON.stringify([...document.querySelectorAll("#live tr[data-live-lifecycle]")].map(r=>r.dataset.liveLifecycle))===${JSON.stringify(JSON.stringify(['holding','holding','recentering','queued','blocked']))}&&[...document.querySelectorAll("#live tr[data-live-lifecycle] .badge")].map(b=>b.textContent).join("|")==="Holding|Holding|Recentering|Queued|Blocked"&&!document.querySelector("#live").textContent.includes("RK-aaaaaaaf")`);
 await check('a recentering row names the job kind, stage, nonce and transaction hash as text',
  `(()=>{const r=document.querySelector('#live tr[data-live-lifecycle="recentering"]');const f=r.nextElementSibling.textContent;return r.textContent.includes("Recenter executing")&&r.textContent.includes("stage withdraw liquidity")&&r.textContent.includes("nonce 1000")&&r.textContent.includes("tx 0x33333333…333333")&&f.includes("Current job")&&f.includes("tx 0x${'3'.repeat(64)}")&&f.includes("Position NFT")&&f.includes("1001")&&!r.nextElementSibling.querySelector("a")})()`);
 await check('holding rows show NFT id across the 999/1000 boundary, range state, receipt-backed value and a Review retain-close action',
  `(()=>{const rows=[...document.querySelectorAll('#live tr[data-live-lifecycle="holding"]')];const facts=rows.map(r=>r.nextElementSibling);return rows.length===2&&facts[0].textContent.includes("1000")&&facts[0].textContent.includes("in range")&&facts[1].textContent.includes("999")&&facts[1].textContent.includes("outside range")&&rows[0].textContent.includes("251.25")&&facts.every(f=>[...f.querySelectorAll("button")].some(b=>b.textContent==="Review retain-close"&&!b.disabled))})()`);
 await check('queued, recentering and blocked rows offer no retain-close and say why',
  `[...document.querySelectorAll('#live tr[data-live-lifecycle]:not([data-live-lifecycle="holding"])')].every(r=>r.nextElementSibling.querySelector(".live-retain-action-root")===null&&r.nextElementSibling.querySelector(".live-row-actions").textContent.trim().length>0)`);
 await check('economics without evidence read unavailable and are never zero-filled',
  `(()=>{const q=document.querySelector('#live tr[data-live-lifecycle="queued"]');const f=q.nextElementSibling;return q.querySelectorAll(".muted").length>=3&&q.textContent.includes("unavailable")&&!/0[.]00/.test(q.cells[2].textContent+q.cells[3].textContent+q.cells[4].textContent)&&f.textContent.includes("not minted yet")&&f.textContent.includes("unavailable")})()`);
 await check('a blocked row shows its recorded reason without raw identifiers',
  `(()=>{const r=document.querySelector('#live tr[data-live-lifecycle="blocked"]');return r.textContent.includes("a transaction reverted")&&!r.textContent.includes("55555555-5555")})()`);
 await check('every live row carries its valuation basis: oracle fresh, last oracle price with age, unavailable; a queued campaign has none',
  `JSON.stringify([...document.querySelectorAll("#live tr[data-live-lifecycle]")].map(r=>r.querySelector(".basis-badge")?.textContent??null))===${JSON.stringify(JSON.stringify(['Oracle fresh','Last oracle price · 38h old','Last oracle price · 38h old',null,'Valuation unavailable']))}`);
 await check('a held live row keeps its headline NAV and states the price time, age and the indicative pool-implied figure',
  `(()=>{const rows=[...document.querySelectorAll("#live tr[data-live-lifecycle]")];const held=rows[1],f=held.nextElementSibling.textContent;return held.cells[2].textContent.includes("249.00")&&/Valuation basisLast oracle price, \\w{3} \\d\\d:\\d\\d ET, 38h old/.test(f)&&f.includes("Pool-implied NAV (indicative)248.50 · not used for P&L")&&held.querySelector(".basis-badge").title.includes("not updating")})()`);
 await check('live row facts say when each campaign expires and how many economic actions it has used',
  `(()=>{const rows=[...document.querySelectorAll("#live tr[data-live-lifecycle]")];const text=i=>rows[i].nextElementSibling.textContent;return text(0).includes("ExpiresOpen-ended")&&text(0).includes("Economic actions3 of unlimited")&&/ExpiresOct \\d+, \\d\\d:\\d\\d ET/.test(text(1))&&text(1).includes("Economic actions1 of 4")&&text(3).includes("Expires2 hours after opening")&&text(3).includes("Economic actions0 of 4")})()`);
 await check('a fresh live row says oracle fresh and a blocked row has no oracle value but never zero-fills',
  `(()=>{const rows=[...document.querySelectorAll("#live tr[data-live-lifecycle]")];return rows[0].nextElementSibling.textContent.includes("Valuation basisOracle fresh")&&rows[4].nextElementSibling.textContent.includes("Valuation basisOracle valuation unavailable")&&rows[4].nextElementSibling.textContent.includes("Pool-implied NAV (indicative)unavailable")})()`);
 await waitFor('document.querySelectorAll("#paper tr[data-position]").length===2&&document.querySelector("#paper-detail .basis-alert")!==null');
 await shot('paper-last-oracle-price-1440','#paper');
 await check('paper rows carry the same basis badge; the selected held row shows the alert, held-price notes and the pool-implied metric',
  `(()=>{const rows=[...document.querySelectorAll("#paper tr[data-position]")];const d=document.querySelector("#paper-detail").textContent;return rows.map(r=>r.querySelector(".basis-badge")?.textContent).join("|")==="Last oracle price · 38h old|Valuation unavailable"&&rows[0].cells[2].textContent.includes("180.00")&&d.includes("Valued at last oracle price")&&/Provisional · last oracle price · 38h old/.test(d)&&d.includes("Pool-implied NAV (indicative)")&&d.includes("189.50")&&d.includes("Last oracle price · USDG")})()`);
 await evaluate('document.querySelectorAll("#paper .position-select")[1].click()');
 await waitFor('document.querySelector("#paper-detail .basis-alert.unavailable")!==null');
 await check('a structurally unavailable paper row shows no oracle NAV, says why in words, and keeps the pool-implied figure',
  `(()=>{const rows=[...document.querySelectorAll("#paper tr[data-position]")];const d=document.querySelector("#paper-detail").textContent;return rows[1].cells[2].textContent.includes("unavailable")===false&&rows[1].cells[2].textContent.trim().startsWith("—")&&d.includes("risk token: the oracle feed description does not match")&&d.includes("Pool-implied NAV (indicative)")&&d.includes("189.50")&&!d.includes("Last oracle price · 38h")})()`);
 await click('#paper .position-select');
 await click('#live .view-switch button[data-value="history"]');
 await waitFor('document.querySelectorAll("#live tr[data-live-lifecycle]").length===1');
 await check('a closed live campaign keeps the basis it was last valued on in History',
  'document.querySelector("#live tr[data-live-lifecycle]").querySelector(".basis-badge").textContent==="Last oracle price · 60h old"||document.querySelector("#live tr[data-live-lifecycle]").querySelector(".basis-badge").textContent==="Last oracle price · 2d 12h old"');
 await click('#live .view-switch button[data-value="active"]');
 await waitFor('document.querySelectorAll("#live tr[data-live-lifecycle]").length===5');
 await check('while the worker is not connected a queued row says it will not start and why',
  `document.querySelector('#live tr[data-live-lifecycle="queued"]').textContent.includes("live worker is not connected")&&document.querySelector('#live tr[data-live-lifecycle="queued"]').nextElementSibling.textContent.includes("The live wallet worker is not connected.")`);
 await click('#live .view-switch button[data-value="history"]');
 await waitFor('document.querySelectorAll("#live tr[data-live-lifecycle]").length===1');
 await check('a closed live campaign moves to History',
  'document.querySelector("#live tr[data-live-lifecycle]").dataset.liveLifecycle==="closed"&&document.querySelector("#live tr[data-live-lifecycle]").textContent.includes("RK-aaaaaaaf")&&document.querySelector("#live .live-retain-action-root")===null');
 await click('#live .view-switch button[data-value="active"]');
 await waitFor('document.querySelectorAll("#live tr[data-live-lifecycle]").length===5');
 await shot('live-positions-worker-down-1440');
 // Exits are not gated on worker readiness: the review is acceptable and says it will wait for the worker.
 await click('#live .live-retain-action-root button');
 await waitFor('[...document.querySelectorAll("#live .live-retain-action-root button")].some(b=>b.textContent==="Approve retain-close")');
 await check('retain-close review while the worker is down is still acceptable and says the close waits for the worker',
  `(()=>{const t=document.querySelector("#live .live-retain-action-root").textContent;return t.includes("Persisted retain-only review")&&t.includes("The live wallet worker is not connected.")&&t.includes("queue now and run when the worker reconnects")&&${JSON.stringify(apiCalls)}.filter(x=>x.path.endsWith("/live/retain-operations")).length===0})()`);
 await click('#live .live-retain-action-root button:last-of-type');
 await waitFor('document.querySelectorAll("#live tr[data-live-lifecycle=\\"closing\\"]").length===1');
 await check('retain-close queues while the worker is disconnected: saved preview identity and durable key are posted and the row moves to Closing with the worker note',
  `(()=>{const r=${JSON.stringify(apiCalls)}.filter(x=>x.path.endsWith("/live/retain-operations"));const row=document.querySelector('#live tr[data-live-lifecycle="closing"]');return r.length===1&&r[0].csrf==="fixture-csrf"&&r[0].body.previewId==="77777777-7777-4777-8777-777777777777"&&r[0].body.contentDigest==="${'d'.repeat(64)}"&&r[0].body.expectedRevision===1&&/^[0-9a-f-]{36}$/.test(r[0].body.idempotencyKey)&&row.textContent.includes("Closing")&&row.textContent.includes("Retain-close queued")&&row.nextElementSibling.querySelector(".live-retain-action-root")===null&&row.nextElementSibling.textContent.includes("The live worker is not ready")&&row.nextElementSibling.textContent.includes("Queued work resumes when it reconnects")})()`);
 await select('#setup-mode','live');
 await waitFor('document.querySelector("#live-wallet-note").textContent.includes("Balances from the registered server wallet")');
 await check('wallet panel states the worker is not ready and lists the human-readable reason',
  'document.querySelector("#live-worker-status").textContent==="Live worker not ready"&&!document.querySelector("#live-readiness-reasons").hidden&&document.querySelector("#live-readiness-reasons").textContent.includes("The live wallet worker is not connected.")&&document.querySelector("#setup-capability-badge").textContent==="Live approval unavailable"');
 await select('#setup-strategy','rangekeeper_v1');
 await waitFor('document.querySelector("#setup-pool").options.length===12');
 await check('all twelve registered profiles are selectable in Live, including profiles without paper draft capability',
  `JSON.stringify([...document.querySelector("#setup-pool").options].map(x=>x.value))===${JSON.stringify(JSON.stringify(livePoolOrder))}&&document.querySelector("#setup-pool").options.length===12`);
 await check('Live review displays only the server wallet and its free, reserved, pending and exit funds',
  'document.querySelector("#live-wallet-facts").textContent.includes("0x0000000000000000000000000000000000000384")&&document.querySelector("#live-wallet-facts").textContent.includes("375000000")&&document.querySelector("#live-wallet-facts").textContent.includes("5000000000000000")&&document.querySelector("#operator-draft-binding").hidden');
 await check('no client supplied wallet, key, spender or calldata field is exposed for Live',
  'document.querySelector("#live-wallet-review input")===null&&document.querySelector("#setup-wallet-address").closest("#operator-draft-binding").hidden');
 await check('wallet panel shows balance, reserved by campaigns and free per token and for native gas',
  `(()=>{const rows=Object.fromEntries([...document.querySelectorAll("#live-wallet-table tbody tr")].map(r=>[r.querySelector("th").textContent,[...r.querySelectorAll("td")].map(td=>td.textContent)]));return document.querySelectorAll("#live-wallet-table thead th").length===4&&rows.USDG[0].startsWith("500")&&rows.USDG[1].startsWith("125")&&rows.USDG[1].includes("allocated 100")&&rows.USDG[1].includes("pending 25")&&rows.USDG[2].startsWith("375")&&rows.AAPL[2].startsWith("8")&&rows["Native gas"][0].startsWith("0.02")&&rows["Native gas"][1].startsWith("0.0071")&&rows["Native gas"][1].includes("exit reserve 0.005")&&rows["Native gas"][2].startsWith("0.0129")})()`);
 await check('the campaign scope inputs appear for live RangeKeeper only and are prefilled open-ended with their meaning in words',
  `(()=>{const d=document.querySelector("#setup-campaign-duration"),a=document.querySelector("#setup-campaign-actions");return !document.querySelector("#setup-campaign-duration-row").hidden&&!document.querySelector("#setup-campaign-actions-row").hidden&&d.value==="0"&&a.value==="0"&&document.querySelector("#setup-campaign-duration-hint").textContent==="Open-ended · no expiry"&&document.querySelector("#setup-campaign-actions-hint").textContent.startsWith("Unlimited")&&document.querySelector("#setup-campaign-duration-row").textContent.includes("Campaign duration")&&document.querySelector("#setup-campaign-actions-row").textContent.includes("Max economic actions")})()`);
 await select('#setup-strategy','static_manual_v1');
 await check('the scope inputs are hidden for another strategy and for paper',
  'document.querySelector("#setup-campaign-duration-row").hidden&&document.querySelector("#setup-campaign-actions-row").hidden');
 await select('#setup-strategy','rangekeeper_v1');await select('#setup-mode','paper');
 await check('paper RangeKeeper setup has no campaign scope inputs',
  'document.querySelector("#setup-campaign-duration-row").hidden&&document.querySelector("#setup-campaign-actions-row").hidden');
 await select('#setup-mode','live');
 await waitFor('document.querySelector("#live-wallet-note").textContent.includes("Balances from the registered server wallet")');
 await select('#setup-pool',profiles[8].pool);await fill('#setup-capital','250');await fill('#setup-rangekeeper-width','20');
 await click('#setup-review-button');
 await waitFor('document.querySelector("#live-setup-title").textContent==="Indicative live setup review"');
 await check('the default review posts an open-ended, unlimited scope and states it in the summary and the frozen review',
  `(()=>{const r=${JSON.stringify(apiCalls)}.filter(x=>x.path==="/api/deployments/rangekeeper/live-setup-preflight").at(-1);const t=document.querySelector("#setup-review-facts").textContent+document.querySelector("#live-setup-facts").textContent;return r.body.campaignScope.maxDurationSeconds===0&&r.body.campaignScope.maxEconomicActions===0&&t.includes("Campaign durationOpen-ended")&&t.includes("Campaign durationOpen-ended · no expiry")&&t.includes("Max economic actionsUnlimited")})()`);
 await check('Live review posts exact registered profile, raw capital, width and limits to its route',
  `(()=>{const c=${JSON.stringify(apiCalls)};const r=c.find(x=>x.path==="/api/deployments/rangekeeper/live-setup-preflight");return !!r&&r.method==="POST"&&r.csrf==="fixture-csrf"&&r.body.profileId===${JSON.stringify(profiles[8].id)}&&r.body.capitalQuoteRaw==="250000000"&&r.body.fullWidthSpacings===20&&!!r.body.limits.maxObservationGapSeconds})()`);
 await check('review renders returned token requirements, allocation balances and gas estimates in their raw units',
  'document.querySelector("#live-setup-facts").textContent.includes("12000000")&&document.querySelector("#live-setup-facts").textContent.includes("340000000000000000")&&document.querySelector("#live-setup-facts").textContent.includes("500000000000000")&&document.querySelector("#live-setup-facts").textContent.includes("375000000")');
 await check('the reviewed campaign request, shortfall and exit reserve appear beside free funds, from fields the service returned',
  `(()=>{const head=[...document.querySelectorAll("#live-wallet-table thead th")].map(th=>th.textContent);const rows=Object.fromEntries([...document.querySelectorAll("#live-wallet-table tbody tr")].map(r=>[r.querySelector("th").textContent,[...r.querySelectorAll("td")].map(td=>td.textContent)]));const s=document.querySelector("#live-wallet-summary").textContent;return head.join("|")==="Asset|Wallet balance|Reserved by campaigns|Free|This campaign needs|Shortfall"&&rows.USDG[3].startsWith("12")&&rows.USDG[4]==="0"&&rows.GOOGL[3].startsWith("0.34")&&rows["Native gas"][3].startsWith("0.006")&&rows["Native gas"][4]==="0"&&s.includes("Exit reserve0.004")&&s.includes("Capital shortfall0 USDG")&&s.includes("Capital requested250 USDG")&&document.querySelector('#live-wallet-table tr[data-reviewed="true"]')!==null})()`);
 await check('with the worker down approval is disabled, the reason is listed, and nothing was admitted',
  `(()=>{const b=document.querySelector("#live-setup-result button");return b.textContent==="Approve live opening"&&b.disabled&&document.querySelector("#live-setup-result .live-readiness-reasons").textContent.includes("The live wallet worker is not connected.")&&!document.querySelector("#live-setup-result .live-readiness-reasons").hidden&&${JSON.stringify(apiCalls)}.filter(x=>x.path==="/api/deployments/rangekeeper/live-setup-admit").length===0})()`);
 await evaluate(`fetch('/__fixture-control?worker=ready')`);
 await waitFor('document.querySelector("#live-worker-status").textContent==="Live worker ready"',25000);
 await check('approval re-enables on the same review once the worker reports ready, and the reasons clear',
  'document.querySelector("#live-setup-result button").textContent==="Approve live opening"&&!document.querySelector("#live-setup-result button").disabled&&document.querySelector("#live-setup-result .live-readiness-reasons").hidden&&document.querySelector("#setup-capability-badge").textContent==="Live approval available"&&document.querySelector("#live-setup-result .inline-note").textContent.includes("supervised live worker")&&!document.querySelector("#live-setup-result").textContent.includes("execution remains unavailable")');
 await shot('live-setup-review-ready-1440');
 await check('a queued row no longer claims the worker is down once it is ready',
  `!document.querySelector('#live tr[data-live-lifecycle="queued"]').textContent.includes("not connected")&&document.querySelector('#live tr[data-live-lifecycle="queued"]').textContent.includes("waiting for the live worker")`);
 await check('persisted indicative review exposes only explicit admission, not a draft or open execution action',
  'document.querySelector("#operator-draft-binding").hidden&&document.querySelector("#save-paper-draft").disabled&&document.querySelector("#setup-open-review").hidden&&document.querySelectorAll("#live-setup-result button").length===1&&document.querySelector("#live-setup-result button").textContent==="Approve live opening"&&!document.querySelector("#live-setup-result button").disabled');
 for(const width of [1440,390]){
  await page.send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});
  await check(`live approval remains usable at ${width}px`,
   '(()=>{const r=document.querySelector("#live-setup-result button").getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&!document.querySelector("#live-setup-result button").disabled})()');
 }
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await click('#live-setup-result button');
 await waitFor('document.querySelector("#live-setup-result").textContent.includes("Retry with the same request key")');
 await check('ambiguous admission keeps the same request available for retry',
  'document.querySelector("#live-setup-result button").textContent==="Retry same live admission"&&!document.querySelector("#live-setup-result button").disabled');
 await click('#live-setup-result button');
 await waitFor('document.querySelector("#live-setup-result").textContent.includes("Admission queued for campaign 44444444-4444-4444-8444-444444444444")');
 await check('admission posts only persisted review identity and durable key while clearly withholding execution eligibility',
  `(()=>{const rs=${JSON.stringify(apiCalls)}.filter(x=>x.path==="/api/deployments/rangekeeper/live-setup-admit");return rs.length===2&&rs.every(r=>r.method==="POST"&&r.csrf==="fixture-csrf"&&r.body.reviewId==="33333333-3333-4333-8333-333333333333"&&r.body.reviewHash==="${'c'.repeat(64)}"&&/^[0-9a-f-]{36}$/.test(r.body.requestId))&&rs[0].body.requestId===rs[1].body.requestId&&document.querySelector("#live-setup-result").textContent.includes("holding only after the opening transactions confirm")})()`);

 await check('once the worker is ready the queued close and queued opening no longer claim the worker is down',
  `(()=>{const row=document.querySelector('#live tr[data-live-lifecycle="closing"]');return !row.nextElementSibling.textContent.includes("The live worker is not ready")&&!document.querySelector("#live").textContent.includes("worker is not connected")})()`);
 for(const width of [1440,390]){
  await page.send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390});
  await check(`live rows, wallet funding and approval fit ${width}px without horizontal overflow`,
   (await shot(`live-rows-${width}`,'#live'),await shot(`live-wallet-${width}`,'#live-wallet-review'),await shot(`live-setup-scope-${width}`,'#setup-form'),`(()=>{const w=innerWidth;const inside=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=-1&&r.right<=w+1};return document.documentElement.scrollWidth<=w+1&&document.body.scrollWidth<=w+1&&inside(document.querySelector("#live .positions-table"))&&inside(document.querySelector("#live-wallet-table"))&&inside(document.querySelector("#live-setup-result button"))&&[...document.querySelectorAll("#live .live-facts dd")].every(inside)&&inside(document.querySelector("#paper .positions-table"))&&[...document.querySelectorAll(".basis-badge,.basis-alert")].every(inside)&&inside(document.querySelector("#setup-campaign-duration"))&&inside(document.querySelector("#setup-campaign-actions"))})()`));
 }
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

 // Stale, unavailable, and malformed wallet snapshots stay read-only. The mock
 // endpoint deliberately reports an unavailable live review for stale custody.
 for(const mode of ['unavailable','stale','malformed']){
  await evaluate(`fetch('/__fixture-control?wallet=${mode}&preflight=wallet-dependent')`);
  await select('#setup-mode','paper');await select('#setup-mode','live');
  await waitFor(`document.querySelector('#live-wallet-note').textContent.includes('${mode==='malformed'?'Balances from the registered server wallet':'Wallet funding is unavailable or unreconciled'}')`);
  await click('#setup-review-button');
  const blocker=mode==='malformed'?'wallet_response_malformed':mode==='stale'?'wallet_snapshot_stale':'wallet_snapshot_unavailable';
  await waitFor(`document.querySelector("#live-setup-detail").textContent.includes(${JSON.stringify(blocker)})`);
  await waitFor('document.querySelector("#live-setup-title").textContent==="Live setup review unavailable"');
  await check(`${mode} wallet or custody evidence cannot expose campaign admission`,
   'document.querySelector("#operator-draft-binding").hidden&&document.querySelector("#save-paper-draft").disabled&&document.querySelector("#setup-open-review").hidden&&document.querySelectorAll("#live-setup-result button").length===0');
 }
 await evaluate(`fetch('/__fixture-control?wallet=available&preflight=flags')`);
 await select('#setup-mode','paper');await select('#setup-mode','live');
 await waitFor('document.querySelector("#live-wallet-note").textContent.includes("Balances from the registered server wallet")');
 await select('#setup-pool',profiles[8].pool);
 await click('#setup-review-button');
 await waitFor('document.querySelector("#live-setup-detail").textContent.includes("unsafe_flag_fixture")');
 await waitFor('document.querySelector("#live-setup-title").textContent==="Live setup review unavailable"');
 await check('a malformed indicative response with actionAvailable true is rejected as unavailable',
  'document.querySelector("#live-setup-detail").textContent.includes("unsafe_flag_fixture")&&document.querySelector("#operator-draft-binding").hidden&&document.querySelector("#save-paper-draft").disabled');

 // The operator chooses a bounded campaign: 12 hours and 2 economic actions. Invalid values never leave the page, and any
 // change to the scope discards the review it was reviewed under.
 await evaluate(`fetch('/__fixture-control?wallet=available&preflight=valid&worker=ready')`);
 await select('#setup-mode','paper');await select('#setup-mode','live');
 await waitFor('document.querySelector("#live-wallet-note").textContent.includes("Balances from the registered server wallet")');
 await select('#setup-pool',profiles[8].pool);
 await fill('#setup-campaign-duration','12');await fill('#setup-campaign-actions','2');
 await check('entered scope values are restated in words next to the inputs',
  'document.querySelector("#setup-campaign-duration-hint").textContent==="12 hours after opening, then retain-close"&&document.querySelector("#setup-campaign-actions-hint").textContent==="2 including the opening, then retain-close"');
 await click('#setup-review-button');
 await waitFor('document.querySelector("#live-setup-title").textContent==="Indicative live setup review"&&document.querySelector("#live-setup-facts").textContent.includes("12 hours after opening")');
 await check('a bounded scope is posted exactly and shown in the summary and the frozen review',
  `(()=>{const r=${JSON.stringify(apiCalls)}.filter(x=>x.path==="/api/deployments/rangekeeper/live-setup-preflight").at(-1);const sum=document.querySelector("#setup-review-facts").textContent,rev=document.querySelector("#live-setup-facts").textContent;return r.body.campaignScope.maxDurationSeconds===43200&&r.body.campaignScope.maxEconomicActions===2&&sum.includes("Campaign duration12 hours")&&sum.includes("Max economic actions2")&&rev.includes("Campaign duration12 hours after opening, then retain-close")&&rev.includes("Max economic actions2 including the opening, then retain-close")})()`);
 await shot('live-setup-scope-review-1440','.setup-panel');
 await fill('#setup-campaign-actions','3');
 await check('changing the scope after a review discards that review and its approval',
  'document.querySelector("#setup-review").hidden');
 const scopeCallsBefore=apiCalls.filter(call=>call.path==='/api/deployments/rangekeeper/live-setup-preflight').length;
 for(const [duration,actions] of [['25','2'],['12','11'],['abc','2'],['12','-1'],['','2']]){
  await fill('#setup-campaign-duration',duration);await fill('#setup-campaign-actions',actions);
  await click('#setup-review-button');
  await waitFor('document.querySelector("#setup-error").hidden===false');
  await check(`an invalid scope (${duration||'blank'} h, ${actions}) is explained and nothing is sent`,
   `document.querySelector("#setup-error").textContent.length>30&&document.querySelector("#setup-status").textContent.includes("No request was sent")&&${JSON.stringify(apiCalls)}.filter(call=>call.path==="/api/deployments/rangekeeper/live-setup-preflight").length===${scopeCallsBefore}`);
 }
 await fill('#setup-campaign-duration','0');await fill('#setup-campaign-actions','0');

 // The worker drops between the last readiness poll and the click. The service refuses with its closed reasons,
 // nothing is queued, and the operator is told why in words.
 await evaluate(`fetch('/__fixture-control?wallet=available&preflight=valid&worker=ready')`);
 await select('#setup-mode','paper');await select('#setup-mode','live');
 await waitFor('document.querySelector("#live-wallet-note").textContent.includes("Balances from the registered server wallet")');
 await waitFor('document.querySelector("#live-worker-status").textContent==="Live worker ready"',25000);
 await select('#setup-pool',profiles[8].pool);
 await click('#setup-review-button');
 await waitFor('document.querySelector("#live-setup-title").textContent==="Indicative live setup review"&&!document.querySelector("#live-setup-result button").disabled');
 const admitsBefore=apiCalls.filter(call=>call.path==='/api/deployments/rangekeeper/live-setup-admit').length;
 await evaluate(`fetch('/__fixture-control?worker=multiple')`);
 await click('#live-setup-result button');
 await waitFor('document.querySelector("#live-setup-result").textContent.includes("Nothing was queued")');
 await check('a worker that drops before the click is refused with its closed reasons, nothing is queued and no pending key is kept',
  `(()=>{const t=document.querySelector("#live-setup-result").textContent;const admits=${JSON.stringify(apiCalls)}.filter(call=>call.path==="/api/deployments/rangekeeper/live-setup-admit").length;return t.includes("The live wallet worker is not connected.")&&t.includes("The shared wallet snapshot is stale")&&!t.includes("Admission queued")&&!t.includes("Admission outcome unknown")&&localStorage.getItem("concliq.operator.rangekeeper-live-admission.pending.v1")===null&&admits===${admitsBefore}+1})()`);
 await waitFor('document.querySelector("#live-worker-status").textContent==="Live worker not ready"',25000);
 await check('the readiness badge and reason list follow the worker after the refusal',
  'document.querySelector("#setup-capability-badge").textContent==="Live approval unavailable"&&document.querySelector("#live-readiness-reasons").textContent.includes("snapshot is stale")');
 await evaluate(`fetch('/__fixture-control?worker=schema')`);
 await waitFor('document.querySelector("#live-readiness-reasons").textContent.includes("database schema is not installed")',25000);
 await check('a missing live schema is reported in words and keeps approval unavailable',
  'document.querySelector("#live-worker-status").textContent==="Live worker not ready"&&document.querySelector("#setup-capability-badge").textContent==="Live approval unavailable"&&!document.querySelector("#live-readiness-reasons").textContent.includes("live_runtime")');
 await evaluate(`fetch('/__fixture-control?worker=absent')`);
 await waitFor('document.querySelector("#live-worker-status").textContent==="Live admission available"',25000);
 await check('a service that omits liveWorker is not treated as not ready',
  'document.querySelector("#live-readiness-reasons").hidden&&document.querySelector("#setup-capability-badge").textContent==="Live approval available"');
 await evaluate(`fetch('/__fixture-control?worker=ready')`);

 // Returning to the existing paper workflow must keep its old endpoint and form
 // behavior, even after live reviews and a bad live capability response.
 await evaluate(`fetch('/__fixture-control?wallet=available&preflight=valid')`);
 await select('#setup-mode','paper');await select('#setup-strategy','static_manual_v1');
 await waitFor('document.querySelector("#setup-pool").options.length===3');
 await select('#setup-pool',profiles[0].pool);await fill('#setup-capital','250');
 await click('#setup-review-button');await waitFor('document.querySelector("#setup-preflight-title").textContent==="Sizing preflight unavailable"');
 await check('switching back to Paper retains the static setup route and submits its registered profile',
  `(()=>{const r=${JSON.stringify(apiCalls)}.filter(x=>x.path==="/api/deployments/setup-preflight").at(-1);return !!r&&r.method==="POST"&&r.csrf==="fixture-csrf"&&r.body.profileId===${JSON.stringify(profiles[0].id)}&&r.body.capitalQuoteRaw==="250000000"&&Number.isSafeInteger(r.body.halfWidthTicks)})()`);
 assert.equal(apiCalls.some(call=>call.method==='POST'&&(/setup-drafts|open-operations|\/previews/.test(call.path))),false,
  'live review does not submit a draft, open operation, or preview acceptance');
 assert.equal(apiCalls.filter(call=>call.path==='/api/deployments/rangekeeper/live-setup-preflight').length,7,
  'only explicit live review clicks submit the live preflight route');
 assert.deepEqual(runtimeErrors,[],'browser completed without uncaught JavaScript exceptions');
} finally {
 await browser?.close().catch(()=>{});
 await new Promise(resolve=>mockServer.close(resolve));
}
console.log(JSON.stringify({status:'passed',checks,livePreflightCalls:apiCalls.filter(call=>call.path==='/api/deployments/rangekeeper/live-setup-preflight').length,
 paperPreflightCalls:apiCalls.filter(call=>call.path==='/api/deployments/setup-preflight').length,
 forbiddenAcceptanceCalls:apiCalls.filter(call=>call.method==='POST'&&(/setup-drafts|open-operations|\/previews/.test(call.path))).length,
 runtimeErrors},null,2));
