// Run with `node --import tsx test/integration/dashboard-live-setup-browser.mjs`.
// This serves the real dashboard assets from a disposable loopback mock server.
// No database, RPC, signer, worker, or production service is used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
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
   {address:token(2),decimals:18,reference:'AAPL/USD',balanceRaw:'9000000000000000000',allocatedRaw:'1000000000000000000',pendingRaw:'0',availableRaw:'8000000000000000000'}],
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
  tokens:[{address:token(1),decimals:6,symbol:'USDG',balanceRaw:'500000000',allocatedRaw:'100000000',pendingRaw:'25000000',availableRaw:'375000000'}],
  native:{balanceWei:'20000000000000000',allocatedWei:'2000000000000000',pendingWei:'100000000000000',exitReserveWei:'5000000000000000',availableWei:'12900000000000000'}},
 requirements:{token0Raw:'12000000',token1Raw:'340000000000000000',quoteValueRaw:'250000000',freeQuoteRaw:'375000000',shortfallQuoteRaw:'0',nativeWei:'6000000000000000',exitReserveWei:'4000000000000000'},
 range:{tickLower:-600,tickUpper:600,centerTick:3,fullWidthSpacings:20},
 references:{price0:'1000000000000000000',price1:'2000000000000000000',nativePrice:'2000000000000000000000',proofHash:'b'.repeat(64)},
 costs:{status:'estimated',source:'owned_fork',actionCostValue:'1000000000000000',actionGasWei:'500000000000000',
  completeExitCostValue:'2000000000000000',completeExitGasWei:'1000000000000000',exitReserveWei:'4000000000000000',missing:[]},
 missing:[],blockers:[],actionAvailable:false,draftCreationAvailable:false,operationAcceptanceAvailable:false,
 executionEligible:false,admissionAvailable:admissionMode!=='disabled',
 reviewPersistence:{status:'persisted',reviewId:'33333333-3333-4333-8333-333333333333',reviewHash:'c'.repeat(64),
  expiresAt:new Date(Date.now()+60_000).toISOString(),missing:[]},reason:'rangekeeper_live_execution_unavailable'});
const mockServer=createServer(async(req,res)=>{
 const url=new URL(req.url??'/',`http://${req.headers.host??'127.0.0.1'}`);
 if(url.pathname==='/__fixture-control'){
  walletMode=url.searchParams.get('wallet')??walletMode;
  preflightMode=url.searchParams.get('preflight')??preflightMode;
  admissionMode=url.searchParams.get('admission')??admissionMode;
  return response(res,200,{walletMode,preflightMode,admissionMode});
 }
 if(url.pathname.startsWith('/api/')){
  let body='';for await(const chunk of req)body+=chunk;
  const parsed=body?JSON.parse(body):null;apiCalls.push({method:req.method,path:url.pathname,body:parsed,csrf:req.headers['x-csrf-token']??null});
  if(url.pathname==='/api/session'&&req.method==='POST')return response(res,200,{csrfToken:'fixture-csrf'}, {'set-cookie':'cq_session=fixture; Path=/; SameSite=Strict'});
  if(url.pathname==='/api/positions')return response(res,200,{positions:[],riskAssets:[],riskFreshnessSeconds:120});
  if(url.pathname==='/api/research')return response(res,200,{snapshotId:'browser-live-setup',generatedAt:new Date().toISOString(),capitalQuoteRaw:url.searchParams.get('capitalQuoteRaw')??'250000000',
   streamKey:'browser-fixture',bucketCount:0,bucketMinutes:60,retainedHours:0,budgetQuote:'250000000',costs:{roundTripQuote:null},pools:[]});
  if(url.pathname==='/api/market-profiles')return response(res,200,{profiles});
  if(url.pathname==='/api/strategies')return response(res,200,{strategies:[
   {id:'static_manual_v1',paper:true,live:false},{id:'rangekeeper_v1',paper:true,live:false,liveSetup:true,
    liveAdmission:admissionMode!=='disabled'}]});
  if(url.pathname==='/api/deployments/setup-drafts')return response(res,200,{drafts:[]});
  if(url.pathname==='/api/deployments/setup-defaults')return response(res,200,{walletAddress:null});
  if(url.pathname==='/api/deployments/live-wallet'&&req.method==='GET')return sendLiveWallet(res);
  if(url.pathname==='/api/deployments/rangekeeper/live-setup-preflight'&&req.method==='POST'){
   if(req.headers['x-csrf-token']!=='fixture-csrf')return response(res,403,{error:'csrf_required'});
   if(!parsed||Object.keys(parsed).sort().join(',')!=='capitalQuoteRaw,fullWidthSpacings,limits,profileId')return response(res,400,{error:'body_shape_invalid'});
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
 const fill=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const select=(selector,value)=>fill(selector,value);
 await page.send('Page.navigate',{url:`${origin}/operator`});await waitFor('document.readyState==="complete"');
 await waitFor('window.concliqOperatorAuthenticated?.()===true&&document.querySelector("#setup-pool").options.length>=3');
 await check('mock service reports live setup review while live execution remains false',
  'document.querySelector("#setup-mode").options[1].value==="live"&&document.querySelector("#setup-strategy").value==="static_manual_v1"');
 await select('#setup-mode','live');
 await waitFor('document.querySelector("#live-wallet-note").textContent.includes("Balances from the registered server wallet")');
 await select('#setup-strategy','rangekeeper_v1');
 await waitFor('document.querySelector("#setup-pool").options.length===12');
 await check('all twelve registered profiles are selectable in Live, including profiles without paper draft capability',
  `JSON.stringify([...document.querySelector("#setup-pool").options].map(x=>x.value))===${JSON.stringify(JSON.stringify(livePoolOrder))}&&document.querySelector("#setup-pool").options.length===12`);
 await check('Live review displays only the server wallet and its free, reserved, pending and exit funds',
  'document.querySelector("#live-wallet-facts").textContent.includes("0x0000000000000000000000000000000000000384")&&document.querySelector("#live-wallet-facts").textContent.includes("375000000")&&document.querySelector("#live-wallet-facts").textContent.includes("5000000000000000")&&document.querySelector("#operator-draft-binding").hidden');
 await check('no client supplied wallet, key, spender or calldata field is exposed for Live',
  'document.querySelector("#live-wallet-review input")===null&&document.querySelector("#setup-wallet-address").closest("#operator-draft-binding").hidden');
 await select('#setup-pool',profiles[8].pool);await fill('#setup-capital','250');await fill('#setup-rangekeeper-width','20');
 await click('#setup-review-button');
 await waitFor('document.querySelector("#live-setup-title").textContent==="Indicative live setup review"');
 await check('Live review posts exact registered profile, raw capital, width and limits to its route',
  `(()=>{const c=${JSON.stringify(apiCalls)};const r=c.find(x=>x.path==="/api/deployments/rangekeeper/live-setup-preflight");return !!r&&r.method==="POST"&&r.csrf==="fixture-csrf"&&r.body.profileId===${JSON.stringify(profiles[8].id)}&&r.body.capitalQuoteRaw==="250000000"&&r.body.fullWidthSpacings===20&&!!r.body.limits.maxObservationGapSeconds})()`);
 await check('review renders returned token requirements, allocation balances and gas estimates in their raw units',
  'document.querySelector("#live-setup-facts").textContent.includes("12000000")&&document.querySelector("#live-setup-facts").textContent.includes("340000000000000000")&&document.querySelector("#live-setup-facts").textContent.includes("500000000000000")&&document.querySelector("#live-setup-facts").textContent.includes("375000000")');
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
  `(()=>{const rs=${JSON.stringify(apiCalls)}.filter(x=>x.path==="/api/deployments/rangekeeper/live-setup-admit");return rs.length===2&&rs.every(r=>r.method==="POST"&&r.csrf==="fixture-csrf"&&r.body.reviewId==="33333333-3333-4333-8333-333333333333"&&r.body.reviewHash==="${'c'.repeat(64)}"&&/^[0-9a-f-]{36}$/.test(r.body.requestId))&&rs[0].body.requestId===rs[1].body.requestId&&document.querySelector("#live-setup-result").textContent.includes("does not mean the campaign is holding")})()`);

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
 assert.equal(apiCalls.filter(call=>call.path==='/api/deployments/rangekeeper/live-setup-preflight').length,5,
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
