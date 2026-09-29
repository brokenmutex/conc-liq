// Populated Research workflow through the actual operator assets and command
// HTTP router. Economics and sources below are synthetic fixtures; arithmetic
// and repository/cache parity are covered separately in unit tests.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer as createTcpServer} from 'node:net';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {USDG} from '../../src/constants.ts';
import {startDashboardBrowser,wait} from './helpers/dashboard-browser.mjs';

const POOL_A=`0x${'a'.repeat(40)}`;
const POOL_B=`0x${'b'.repeat(40)}`;
const PROFILE_A='11111111-1111-4111-8111-111111111111';
const PROFILE_B='22222222-2222-4222-8222-222222222222';
const TOKEN_A=`0x${'1'.repeat(40)}`;
const TOKEN_B=`0x${'2'.repeat(40)}`;
const startedAt=new Date().toISOString();
const sourceAsOf=new Date(Date.now()-181_000).toISOString();
const profiles=[
 {id:PROFILE_A,pool:POOL_A,fee:500,tickSpacing:10,token0:USDG,token1:TOKEN_A,
  decimals0:6,decimals1:18,quoteToken:0,reference0:'USDG/USD',reference1:'REGALFA/USD',
  draftAvailable:true},
 {id:PROFILE_B,pool:POOL_B,fee:3000,tickSpacing:60,token0:USDG,token1:TOKEN_B,
  decimals0:6,decimals1:18,quoteToken:0,reference0:'USDG/USD',reference1:'REGBETA/USD',
  draftAvailable:true},
];
const economics=(capital,poolIndex)=>{
 // Deliberate synthetic rank reversal: ALFA wins at $250 and BETA at $1,000.
 const netByPool=capital==='250000000'
  ? [poolIndex===0?'5000000':'1000000',poolIndex===0?'2000000':'3000000']
  : [poolIndex===0?'-1000000':'6000000',poolIndex===0?'-2000000':'5000000'];
 const net=netByPool[poolIndex];
 const gross=(BigInt(net)+2_000_000n).toString();
 return {halfWidthTicks:poolIndex===0?50:60,halfWidthPercent:0.5,
  liquidity:capital==='250000000'?'500000000000000':'2000000000000000',
  sharePpm:capital==='250000000'?10000:40000,inRangeBuckets:80,
  modeledFeesQuote:gross,modeledNetQuote:net,aprPpm:Number(net)/1000};
};
const windowsFor=(capital,poolIndex)=>[0.25,1,6,24,168].map(hours=>({
 hours,windowSeconds:hours*3600,coveredSeconds:hours*3600,freshnessSeconds:10,
 maxGapSeconds:60,asOf:startedAt,swapWindowSeconds:hours*3600,swapAsOf:startedAt,
 swapAvailability:'available',observedBuckets:Math.min(hours*4,672),swaps:40,
 volumeQuote:'100000000',feesQuote:'6000000',meanLiquidity:'1000000000000',
 priceChangePpm:500,validShare:0.98,references:Array.from({length:6},(_,index)=>({
  ...economics(capital,poolIndex),halfWidthTicks:(index+1)*(poolIndex===0?10:60),
  halfWidthPercent:(index+1)*0.5,
 })),limitation:null,
}));
const summaryPool=(capital,index)=>({
 poolAddress:index===0?POOL_A:POOL_B,rwaSymbol:index===0?'ALFA':'BETA',
 fee:index===0?500:3000,feeProtocol0:0,feeProtocol1:0,
 tickSpacing:index===0?10:60,quoteIsToken0:true,rwaDecimals:18,
 tick:0,sqrtPriceX96:'79228162514264337593543950336',
 priceX18:'1000000000000000000',liquidity:'1000000000000000',
 observedAt:startedAt,registryEnabled:true,stateStatus:'current',
 windows:windowsFor(capital,index),
});
let snapshotRevision=1;
const makeSummary=capitalQuoteRaw=>({
 snapshotId:`research:synthetic:${snapshotRevision}`,generatedAt:startedAt,
 asOf:sourceAsOf,sourceFreshness:{status:'stale',asOf:sourceAsOf,ageSeconds:181,maxAgeSeconds:90},
 capitalQuoteRaw,budgetQuote:capitalQuoteRaw,streamKey:'synthetic-fixture',
 quoteDecimals:6,bucketMinutes:15,bucketCount:672,retainedHours:168,
 costs:{mintBundleQuote:'1000000',exitBundleQuote:'1000000',roundTripQuote:'2000000'},
 pools:[summaryPool(capitalQuoteRaw,0),summaryPool(capitalQuoteRaw,1)],
});
function selectedPoolDetail(capitalQuoteRaw,index,hours){
 const summary=summaryPool(capitalQuoteRaw,index),count=Math.round(hours*4);
 return {...summary,token0:USDG,token1:index===0?TOKEN_A:TOKEN_B,
  series:Array.from({length:count},(_,point)=>({
   bucket:new Date(Date.parse(startedAt)-(count-point)*900_000).toISOString(),
   swaps:1,volumeQuote:'1000000',feesQuote:'10000',meanLiquidity:'1000000000',
   priceX18:'1000000000000000000',sqrtPriceX96:'79228162514264337593543950336',
   tickLast:0,tickMin:-1,tickMax:1,validShare:1,deviationPpm:'0',
  })),
  depth:[{tick:-100,liquidity:'1000000'},{tick:0,liquidity:'2000000'},
   {tick:100,liquidity:'1000000'}],
  depthReferences:Array.from({length:6},(_,width)=>({halfWidthTicks:(width+1)*60,
   halfWidthPercent:(width+1)*0.5,liquidity:String((width+1)*1000000)})),
 };
}

const requests=[];
const failures=[];
let startupResearchFailures=2;
let startupResearchFailuresSeen=0;
let next250Failure=false;
let delayCapital1000=false;
let delayEnteredResolve;
let releaseDelayedResolve;
let delayEntered=new Promise(resolve=>{delayEnteredResolve=resolve;});
let releaseDelayed=new Promise(resolve=>{releaseDelayedResolve=resolve;});
let detailFailure=null;
let mismatchDetails=null;
let preflightCalls=0;
const store={
 async listMarketProfiles(){return profiles;},
 async createDraft(){throw Error('draft creation not part of this fixture');},
 async acceptOperation(){throw Error('acceptance not part of this fixture');},
 async operation(){return null;},
};
const sourceRead=async path=>{
 const url=new URL(path,origin);
 if(url.pathname==='/api/positions')return {positions:[],totals:{}};
 if(url.pathname.startsWith('/api/positions/'))return null;
 if(url.pathname==='/api/dashboard')return {pools:[],positions:[]};
 if(url.pathname==='/api/research'){
  const capital=url.searchParams.get('capitalQuoteRaw')??'250000000';
  const parameterized=url.searchParams.has('capitalQuoteRaw');
  requests.push({kind:'summary',capital,parameterized,at:Date.now()});
  if(startupResearchFailures>0){startupResearchFailures--;startupResearchFailuresSeen++;throw Error('fixture_initial_503');}
  if(parameterized&&capital==='250000000'&&next250Failure){next250Failure=false;throw Error('fixture_refresh_503');}
  const revision=snapshotRevision;
  if(capital==='1000000000'&&delayCapital1000){
   delayCapital1000=false;delayEnteredResolve();await releaseDelayed;
  }
  return {...makeSummary(capital),snapshotId:`research:synthetic:${revision}`};
 }
 if(url.pathname==='/api/research/details'){
  const input={pool:url.searchParams.get('pool'),capital:url.searchParams.get('capitalQuoteRaw'),
   hours:Number(url.searchParams.get('hours')),width:Number(url.searchParams.get('width')),
   snapshotId:url.searchParams.get('snapshotId')};
  requests.push({kind:'detail',...input,at:Date.now()});
  if(detailFailure&&input.pool===detailFailure.pool&&input.hours===detailFailure.hours&&
      input.width===detailFailure.width&&detailFailure.remaining>0){
   detailFailure.remaining--;throw Error('fixture_detail_503');
  }
  if(mismatchDetails&&input.pool===mismatchDetails.pool&&input.hours===mismatchDetails.hours&&
      input.width===mismatchDetails.width&&mismatchDetails.remaining>0){
   mismatchDetails.remaining--;
   if(mismatchDetails.bumpRevision&&mismatchDetails.remaining===1)snapshotRevision++;
   return {error:'research_snapshot_changed'};
  }
  const index=input.pool===POOL_A?0:input.pool===POOL_B?1:-1;
  if(index<0)return null;
  return {snapshotId:input.snapshotId,generatedAt:startedAt,asOf:sourceAsOf,
   sourceFreshness:{status:'stale',asOf:sourceAsOf,ageSeconds:181,maxAgeSeconds:90},
   capitalQuoteRaw:input.capital,hours:input.hours,width:input.width,
   pool:selectedPoolDetail(input.capital,index,input.hours)};
 }
 throw Error(`unexpected fixture route ${url.pathname}`);
};
const checks=[];
let browser;
let targetBackground;
let port;
let origin;
let commandServer;
async function until(predicate,message,timeout=12_000){
 const deadline=Date.now()+timeout;
 do{if(predicate())return;await wait(30);}while(Date.now()<deadline);
 throw Error(`Timed out waiting for ${message}`);
}
function countRequests(predicate){return requests.filter(predicate).length;}
async function researchTab(page){
 await page.evaluate("document.querySelector('#research-tab').click()");
 await page.waitFor("document.querySelector('#research-panel').hidden===false");
}
async function setResearchCapital(page,value){
 await page.evaluate(`(()=>{const x=document.querySelector('#research-capital');x.value=${JSON.stringify(String(value))};x.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function clickPool(page,address){
 await page.evaluate(`document.querySelector('tr[data-value="${address}"]').click()`);
}
async function clickWindow(page,hours){
 await page.evaluate(`document.querySelector('#window-select [data-value="${hours}"]').click()`);
}
async function clickWidth(page,width){
 await page.evaluate(`document.querySelector('#width-select [data-value="${width}"]').click()`);
}

try{
 const probe=createTcpServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 origin=`http://127.0.0.1:${port}`;
 // Command server origin must match the browser URL used by automatic session setup.
 commandServer=createDeploymentCommandServer(store,{origin,
  setupDefaults:()=>({walletAddress:`0x${'c'.repeat(40)}`}),
  paperSetupDraftList:async()=>[],
  paperSetupPreflight:async()=>{preflightCalls++;return {status:'unavailable',reason:'Synthetic browser fixture; source preflight disabled.'};},
  dashboardRead:sourceRead});
 await new Promise((resolve,reject)=>{commandServer.once('error',reject);commandServer.listen(port,'127.0.0.1',resolve);});
 browser=await startDashboardBrowser();const {page}=browser;
 await page.send('Page.enable');await page.send('Runtime.enable');await page.send('Performance.enable');
 page.on('Runtime.exceptionThrown',event=>failures.push(event.exceptionDetails.text));
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await page.send('Page.navigate',{url:`${origin}/operator`});
 await page.waitFor("document.querySelector('#research-tab')!==null");
 await page.waitFor("document.querySelector('#operator-connect-retry')!==null");
 await until(()=>countRequests(r=>r.kind==='summary'&&r.parameterized&&r.capital==='250000000')>=1,
  'initial $250 summary request');
 await until(()=>startupResearchFailuresSeen===2,'initial summary and setup-registry reads both fail');
 await page.waitFor("document.querySelector('#league tbody').textContent.includes('Research is unavailable')");
 assert.equal((await page.evaluate("document.querySelector('#league tbody').textContent")).includes('Research is unavailable'),true,
  'first summary 503 should show an unavailable empty state');
 assert.equal((await page.evaluate("document.querySelector('#research-panel').hidden")),true,
  'Research starts behind the Positions tab');
 await page.waitFor("document.querySelector('#setup-pool').options.length===2");
 assert.match(await page.evaluate("document.querySelector('#setup-pool').options[0].textContent"),/REGALFA/,
  'setup begins with profile-only labels while Research is unavailable');
 await researchTab(page);
 await page.waitFor("document.querySelectorAll('#league tbody tr[data-value]').length===2");
 await page.waitFor("document.querySelector('#setup-pool').options[0].textContent.includes('ALFA')");
 assert.match(await page.evaluate("document.querySelector('#setup-pool').options[0].textContent"),/ALFA/,
  'successful research-summary-updated event must restore the Research-backed setup pool registry');
 await page.waitFor("!document.querySelector('#research-refresh').disabled");
 await page.evaluate("document.querySelector('#research-refresh').click()");
 await page.waitFor("document.querySelectorAll('#league tbody tr[data-value]').length===2");
 assert(countRequests(r=>r.kind==='summary'&&r.parameterized&&r.capital==='250000000')>=3,
  `tab activation and explicit Refresh must retry after the initial 503; got ${JSON.stringify(requests.filter(r=>r.kind==='summary'))}`);
 assert.equal(await page.evaluate("document.querySelector('#league tbody tr[data-value]')?.dataset.value"),POOL_A);
 assert.match(await page.evaluate("document.querySelector('#status').textContent"),/source stale/);
 checks.push('initial 503 recovered by tab activation and explicit Refresh without reload');

 // A failed next refresh retains the visible rows and labels their source age.
 next250Failure=true;const beforeFailureRows=await page.evaluate("document.querySelectorAll('#league tbody tr[data-value]').length");
 await page.evaluate("document.querySelector('#research-refresh').click()");
 await page.waitFor("document.querySelector('#status').textContent.includes('refresh failed; showing last snapshot')");
 assert.equal(await page.evaluate("document.querySelectorAll('#league tbody tr[data-value]').length"),beforeFailureRows);
 assert.match(await page.evaluate("document.querySelector('#status').textContent"),/source stale/);
 checks.push('failed refresh retained rows and showed stale source age');

 // Start a slower $1,000 request, then supersede it with $250. Its late response
 // must not replace the newer summary or reverse the current rank.
 delayCapital1000=true;delayEntered=new Promise(resolve=>{delayEnteredResolve=resolve;});
 releaseDelayed=new Promise(resolve=>{releaseDelayedResolve=resolve;});
 await setResearchCapital(page,'1000');await delayEntered;
 const beforeNewer250=countRequests(r=>r.kind==='summary'&&r.parameterized&&r.capital==='250000000');
 await setResearchCapital(page,'250');
 await until(()=>countRequests(r=>r.kind==='summary'&&r.parameterized&&r.capital==='250000000')>beforeNewer250,
  'newer $250 summary request');
 try{await page.waitFor("document.querySelector('#assumptions').textContent.includes('Selected capital: 250 USDG')");}
 catch(error){console.error(JSON.stringify({debug:await page.evaluate("({status:document.querySelector('#status').textContent,assumptions:document.querySelector('#assumptions').textContent,capital:document.querySelector('#research-capital').value,rows:document.querySelector('#league tbody').textContent})"),requests}));throw error;}
 await page.waitFor("document.querySelector('#league tbody tr[data-value]')?.dataset.value==="+JSON.stringify(POOL_A));
 releaseDelayedResolve();await wait(350);
 assert.equal(await page.evaluate("document.querySelector('#research-capital').value"),'250');
 assert.equal(await page.evaluate("document.querySelector('#league tbody tr[data-value]')?.dataset.value"),POOL_A);
 assert.match(await page.evaluate("document.querySelector('#assumptions').textContent"),/Selected capital: 250 USDG/);
 checks.push('late $1,000 summary could not overwrite the newer $250 ranking');

 // The selected chart read carries the complete summary identity and controls.
 await clickPool(page,POOL_B);await clickWindow(page,6);await clickWidth(page,3);
 await page.waitFor("document.querySelector('#detail h2')?.textContent.includes('BETA')");
 const selectedDetail=requests.filter(r=>r.kind==='detail'&&r.pool===POOL_B).at(-1);
 assert.deepEqual({capital:selectedDetail.capital,hours:selectedDetail.hours,width:selectedDetail.width,
  snapshotId:selectedDetail.snapshotId},{capital:'250000000',hours:6,width:3,
  snapshotId:`research:synthetic:${snapshotRevision}`});
 checks.push('selected-pool detail matched summary snapshot, capital, six-hour window and width');

 // A transient selected-detail 503 is rendered once and does not form a poll loop.
 detailFailure={pool:POOL_A,hours:1,width:1,remaining:1};
 await clickPool(page,POOL_A);await clickWindow(page,1);await clickWidth(page,1);
 await page.waitFor("document.querySelector('#detail').textContent.includes('Selected-pool detail refresh failed')");
 const failedDetailCount=countRequests(r=>r.kind==='detail'&&r.pool===POOL_A&&r.hours===1&&r.width===1);
 await wait(700);assert.equal(countRequests(r=>r.kind==='detail'&&r.pool===POOL_A&&r.hours===1&&r.width===1),failedDetailCount);
 checks.push('detail 503 retained summary and stopped automatic retries for the failed selection');

 // A detail 409 can refresh once to a new summary identity, then stops after a
 // second mismatch instead of spinning or mixing charts across snapshots.
 mismatchDetails={pool:POOL_B,hours:6,width:4,remaining:2,bumpRevision:true};
 await clickPool(page,POOL_B);await clickWindow(page,6);await clickWidth(page,4);
 await page.waitFor("document.querySelector('#detail').textContent.includes('snapshot changed repeatedly')");
 const mismatches=requests.filter(r=>r.kind==='detail'&&r.pool===POOL_B&&r.hours===6&&r.width===4);
 assert.equal(mismatches.length,2,`expected exactly two guarded mismatches, got ${mismatches.length}`);
 assert.notEqual(mismatches[0].snapshotId,mismatches[1].snapshotId,
  'second detail read should bind to the refreshed summary identity');
 await wait(700);assert.equal(requests.filter(r=>r.kind==='detail'&&r.pool===POOL_B&&r.hours===6&&r.width===4).length,2);
 checks.push('repeated 409 refreshed once and then stopped, with no cross-snapshot detail merge');

 // A real background page toggles visibility. Hidden tabs do not refresh; the
 // visible Research tab requests a fresh summary when brought forward.
 const newTarget=await browser.browser.send('Target.createTarget',{url:'about:blank'});
 const targets=await(await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
 targetBackground=await browser.connect(targets.find(t=>t.id===newTarget.targetId).webSocketDebuggerUrl);
 await targetBackground.send('Page.enable');await targetBackground.send('Page.bringToFront');
 await page.waitFor("document.visibilityState==='hidden'");
 const visibleCount=countRequests(r=>r.kind==='summary');
 await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))");await wait(250);
 assert.equal(countRequests(r=>r.kind==='summary'),visibleCount,'hidden visibility event must not poll');
 await page.send('Page.bringToFront');await page.waitFor("document.visibilityState==='visible'");
 await until(()=>countRequests(r=>r.kind==='summary')>visibleCount,'visible-tab Research refresh');
 checks.push('hidden Research stayed idle and refreshed when its page became visible');

 // Return to Research and apply a matching pool/capital to setup; then prove a
 // visible reviewed setup refuses to accept a second Research handoff.
 await researchTab(page);
 await setResearchCapital(page,'1000');
 await page.waitFor("document.querySelector('#assumptions').textContent.includes('Selected capital: 1,000 USDG')");
 await page.waitFor("document.querySelector('#league tbody tr[data-value]')?.dataset.value==="+JSON.stringify(POOL_B));
 await clickPool(page,POOL_B);
 await page.evaluate("document.querySelector('#research-use-in-setup').click()");
 await page.waitFor("document.querySelector('#positions-tab').getAttribute('aria-selected')==='true'");
 assert.equal(await page.evaluate("document.querySelector('#setup-capital').value"),'1000');
 assert.equal((await page.evaluate("document.querySelector('#setup-pool').value")).toLowerCase(),POOL_B);
 assert.match(await page.evaluate("document.querySelector('#setup-status').textContent"),/Research selection applied/);
 checks.push('Research handoff applied matching capital and registered pool to setup');

 await page.evaluate("document.querySelector('#setup-review-button').click()");
 await page.waitFor("document.querySelector('#setup-review').hidden===false");
 await until(()=>preflightCalls===1,'setup review preflight request');
 await researchTab(page);
 await setResearchCapital(page,'250');
 await page.waitFor("document.querySelector('#assumptions').textContent.includes('Selected capital: 250 USDG')");
 await clickPool(page,POOL_A);
 await page.evaluate("document.querySelector('#research-use-in-setup').click()");
 await page.waitFor("document.querySelector('#positions-tab').getAttribute('aria-selected')==='true'");
 assert.equal(await page.evaluate("document.querySelector('#setup-capital').value"),'1000');
 assert.equal((await page.evaluate("document.querySelector('#setup-pool').value")).toLowerCase(),POOL_B);
 assert.match(await page.evaluate("document.querySelector('#setup-status').textContent"),/not applied because a setup review/);
 assert.equal(preflightCalls,1,'Research handoff must not rerun or replace the existing setup review');
 checks.push('Research handoff preserved setup inputs while a setup review was visible');
 assert.deepEqual(failures,[],'browser runtime exceptions');
 console.log(JSON.stringify({status:'passed',startedAt,finishedAt:new Date().toISOString(),
  syntheticOnly:true,checks,summaryRequests:requests.filter(r=>r.kind==='summary').length,
  detailRequests:requests.filter(r=>r.kind==='detail').length,
  mismatchSnapshots:mismatches.map(r=>r.snapshotId)}));
}finally{
 releaseDelayedResolve?.();
 await targetBackground?.send('Page.close').catch(()=>{});
 await browser?.close().catch(error=>failures.push(String(error)));
 if(commandServer?.listening)await new Promise(resolve=>commandServer.close(resolve));
}
