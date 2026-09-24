// Isolated source dashboard smoke using a local mock API and disposable Chromium.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {access,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const root=process.cwd(),password='mock-only-password',csrf='mock-csrf-token';
const profileId='67b2b303-e821-4450-bb7b-27171b12079f';
const pool='0x1111111111111111111111111111111111111111';
const token0='0x2222222222222222222222222222222222222222';
const token1='0x3333333333333333333333333333333333333333';
const counts={setup:[],operations:0,drafts:0,session:0};
const profile={id:profileId,chainId:4663,pool,token0,token1,decimals0:18,decimals1:6,
 quoteToken:1,fee:3000,tickSpacing:60,draftAvailable:true,deploymentAvailable:false};
const research={generatedAt:'2026-09-24T10:00:00.000Z',streamKey:'mock-stream',bucketMinutes:60,
 buckets:[],budgetQuote:'250000000',costs:{roundTripQuote:null},pools:[{poolAddress:pool,
 rwaSymbol:'MOCK',fee:3000,feeProtocol0:0,feeProtocol1:0,tickSpacing:60,quoteIsToken0:false,
 rwaDecimals:18,tick:null,priceX18:null,liquidity:null,observedAt:null,registryEnabled:true,
 stateStatus:'unavailable',series:[],windows:[{hours:24,swaps:null,swapAvailability:'unavailable',
 swapAsOf:null,volumeQuote:null,feesQuote:null,validShare:null,references:[]}],depth:[],depthReferences:[]}]};
const preview={schemaVersion:1,kind:'paper_setup_preflight',status:'available',mode:'paper',
 strategyId:'static_manual_v1',profileId,input:{capitalQuoteRaw:'250000000',halfWidthTicks:240},
 source:{block:100,hash:'0x'+'a'.repeat(64),timestamp:1780000000},
 profile:{pool,fee:3000,tickSpacing:60,token0,token1,quoteToken:1},
 range:{centerTick:120,centerAnchorTick:120,halfWidthTicks:240,tickLower:-120,tickUpper:360,
 fullWidthTicks:480,lowerPriceQuotePerBaseX18:'988072305665616000',upperPriceQuotePerBaseX18:'1036610933216553000'},
 requirements:{liquidity:'99',token0Raw:'123456789',token1Raw:'250000000',
 referenceValueQuoteRaw:'249000000',budgetResidualQuoteRaw:'1000000'},
 references:{price0:'100000000000000000000',price1:'1000000000000000000',
 nativePrice:'2000000000000000000',proofHash:'b'.repeat(64)},
 costs:{status:'provisional',scope:'open_and_close_retain_gas_only',
 open:{expectedGasUnits:'100',boundGasUnits:'120',expectedValue:'3000000000000000000',boundValue:'4000000000000000000'},
 closeRetain:{expectedGasUnits:'90',boundGasUnits:'110',expectedValue:'2000000000000000000',boundValue:'3000000000000000000'},
 missing:['fee_capture','close_convert_swap']},
 admissionLimits:{status:'not_evaluated',reason:'static_manual_limits_not_submitted'},
 missing:[],actionAvailable:false,draftCreated:false,operationCreated:false,
 limitations:['read_only_no_draft_or_operation','does_not_claim_wallet_balances_or_funding_availability','costs_are_provisional_fork_estimates']};
const mime={'/':'text/html; charset=utf-8','/operator':'text/html; charset=utf-8',
 '/app.js':'text/javascript; charset=utf-8','/tabs.js':'text/javascript; charset=utf-8',
 '/deployment-actions.js':'text/javascript; charset=utf-8',
 '/research.js':'text/javascript; charset=utf-8','/styles.css':'text/css; charset=utf-8',
 '/research.css':'text/css; charset=utf-8'};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url||'/', 'http://'+req.headers.host),path=url.pathname;
 const json=(status,value,headers={})=>{res.writeHead(status,{'cache-control':'no-store',
  'content-type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(value));};
 const session=(req.headers.cookie||'').split(';').some(x=>x.trim()==='cq_session=mock-session');
 if((req.method==='GET'||req.method==='HEAD')&&mime[path]){
  const file=path==='/'||path==='/operator'?'index.html':path.slice(1);
  const body=await readFile(resolve(root,'dashboard',file));
  res.writeHead(200,{'cache-control':'no-cache','content-type':mime[path],
   'content-security-policy':(path==='/'||path==='/operator')?
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",'x-content-type-options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:body);return;
 }
 if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(req.method==='GET'&&path==='/api/research'){json(200,research);return;}
 if(req.method==='GET'&&path==='/api/positions'){json(200,{positions:[],serverTime:new Date().toISOString()});return;}
 if(req.method==='POST'&&path==='/api/session'){
  counts.session++;
  if(req.headers.origin!=='http://'+req.headers.host){json(403,{error:'origin_mismatch'});return;}
  let body='';for await(const chunk of req)body+=chunk;
  if(JSON.parse(body).password!==password){json(401,{error:'invalid_credentials'});return;}
  json(200,{csrfToken:csrf,expiresInSeconds:60},{'set-cookie':'cq_session=mock-session; HttpOnly; SameSite=Strict; Path=/; Max-Age=60'});return;
 }
 if(req.method==='GET'&&path==='/api/market-profiles'){
  if(!session){json(401,{error:'authentication_required'});return;}
  json(200,{profiles:[profile]});return;
 }
 if(req.method==='POST'&&path==='/api/deployments/setup-preflight'){
  if(!session){json(401,{error:'authentication_required'});return;}
  if(req.headers.origin!=='http://'+req.headers.host||req.headers['x-csrf-token']!==csrf){json(403,{error:'csrf_mismatch'});return;}
  let body='';for await(const chunk of req)body+=chunk;
  const input=JSON.parse(body);counts.setup.push(input);
  if(input.halfWidthTicks===480){json(200,{kind:'paper_setup_preflight',status:'unavailable',
   missing:['fresh_source_stale'],actionAvailable:false,draftCreated:false,operationCreated:false,
   costs:{status:'unavailable'},admissionLimits:{status:'not_evaluated'}});return;}
  json(200,preview);return;
 }
 if(path==='/api/deployments/drafts'){counts.drafts++;json(503,{error:'draft_not_expected_in_smoke'});return;}
 if(/\/operations(?:\/|$)/.test(path)){counts.operations++;json(503,{error:'operation_acceptance_unavailable'});return;}
 json(404,{error:'not_found'});
});
async function chromiumPath(){
 if(process.env.CHROMIUM_PATH)return process.env.CHROMIUM_PATH;
 const entries=await readdir('/root/.cache/ms-playwright',{withFileTypes:true});
 const versions=entries.filter(x=>x.isDirectory()&&/^chromium-\d+$/.test(x.name)).map(x=>x.name)
  .sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)));
 for(const version of versions){const path='/root/.cache/ms-playwright/'+version+'/chrome-linux64/chrome';try{await access(path);return path;}catch{}}
 throw Error('Chromium not found; set CHROMIUM_PATH to a local Chromium executable.');
}
const tmp=await mkdtemp(join(tmpdir(),'conc-liq-setup-smoke-'));
const errors=[],checks=[],shots=[];let child,ws,serverPort=0,debugPort=0;
try{
 server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const address=server.address();assert(address&&typeof address!=='string');serverPort=address.port;
 child=spawn(await chromiumPath(),['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
  '--user-data-dir='+tmp,'about:blank'],{stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{stderr+=part;
  const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);if(match)debugPort=Number(match[1]);});
 for(let i=0;i<120&&!debugPort;i++){if(child.exitCode!==null)throw Error('Chromium exited: '+stderr);await new Promise(r=>setTimeout(r,100));}
 assert(debugPort,'Chromium did not start remote debugging');
 const targets=await fetch('http://127.0.0.1:'+debugPort+'/json').then(r=>r.json());
 const target=targets.find(x=>x.type==='page');assert(target);
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{
  ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let seq=0;const pending=new Map();
 ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);
  if(msg.id){const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);
   msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}
  else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.text);
  else if(msg.method==='Log.entryAdded'&&msg.params.entry.level==='error'&&!msg.params.entry.url?.endsWith('favicon.ico'))errors.push(msg.params.entry.text);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const waitFor=async expression=>{for(let i=0;i<120;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}
  throw Error('Timed out waiting for '+expression);};
 const check=async(name,expression)=>{assert(await evaluate(expression),name);checks.push(name);};
 const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
 const fill=(selector,value)=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+
  JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));})()');
 const size=(width,height,mobile)=>send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
 const nav=async path=>{await send('Page.navigate',{url:'http://127.0.0.1:'+serverPort+path});
  await waitFor('document.readyState==="complete"');await new Promise(r=>setTimeout(r,120));};
 await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await send('Network.enable');
 await size(1440,1000,false);await nav('/');
 await waitFor('document.querySelectorAll("[role=tab]").length===2');
 await check('Public page renders Research and Positions tabs','[...document.querySelectorAll("[role=tab]")].map(x=>x.textContent.trim()).join(",")==="Research,Positions"');
 await check('Public page hides password entry','document.querySelector("#operator-auth").hidden&&getComputedStyle(document.querySelector("#operator-auth")).display==="none"');
 await check('Public desktop layout has no horizontal overflow','document.documentElement.scrollWidth<=innerWidth');
 await click('#research-tab');await check('Research tab remains renderable','!document.querySelector("#research-panel").hidden&&!!document.querySelector("#league")');
 await click('#positions-tab');await waitFor('!document.querySelector("#setup-pool").disabled');
 await click('#setup-review-button');
 await check('Public setup reports blocked preflight and sends no command','document.querySelector("#setup-status").textContent.includes("public read-only dashboard")&&!document.querySelector("#setup-review").hidden');
 assert.equal(counts.setup.length,0,'Public dashboard attempted an authenticated preflight');
 await evaluate(`(async()=>{const {mountStaticRetainAction}=await import('/deployment-actions.js');const root=document.createElement('div');document.body.append(root);let calls=0;mountStaticRetainAction(root,{campaignId:'${profileId}',authenticated:()=>true,request:async()=>{calls++;throw Error('public_must_not_call');}});window.publicRetainTest={empty:root.childElementCount===0,calls};})()`);
 await waitFor('window.publicRetainTest!==undefined');
 await check('Public page mounts no retain-close controls','window.publicRetainTest.empty&&window.publicRetainTest.calls===0');
 await size(390,844,true);await check('Public mobile layout has no horizontal overflow','document.documentElement.scrollWidth<=innerWidth');
 const pshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});shots.push(['public-mobile.png',Buffer.from(pshot.data,'base64')]);
 await size(1440,1000,false);await nav('/operator');await waitFor('!document.querySelector("#operator-auth").hidden');
 await check('Loopback operator page exposes sign in','document.querySelector("#operator-password").type==="password"');
 await check('Operator desktop layout has no horizontal overflow','document.documentElement.scrollWidth<=innerWidth');
 await click('#research-tab');await check('Operator Research tab remains renderable','!document.querySelector("#research-panel").hidden&&!!document.querySelector("#league")');
 await click('#positions-tab');
 await waitFor('!document.querySelector("#setup-pool").disabled');
 await fill('#operator-password',password);await click('#operator-login-form button[type=submit]');
 await waitFor('!document.querySelector("#operator-logout").hidden&&document.querySelector("#setup-pool").options.length>0');
 await check('Login loads authenticated pool and tier profile','document.querySelector("#setup-pool").options[0].textContent.includes("USDG")');
 await click('#setup-review-button');await waitFor('document.querySelector("#setup-preflight-title").textContent==="Sizing preflight available"');
 await check('Available preflight shows bounds, provisional estimate and unevaluated limits',
  'document.querySelector("#setup-preflight-facts").textContent.includes("-120 to 360")&&document.querySelector("#setup-preflight-facts").textContent.includes("Provisional fork estimate")&&document.querySelector("#setup-preflight-facts").textContent.includes("Not evaluated")&&document.querySelector("#setup-preflight-detail").textContent.includes("does not create a draft")');
 await check('Password input clears after login','document.querySelector("#operator-password").value===""');
 const actionTest=await evaluate(`(async()=>{const {mountStaticRetainAction}=await import('/deployment-actions.js');const root=document.createElement('div');document.body.append(root);const campaign='${profileId}',operation='90f0a8ba-b1ec-4fac-a8a3-cdfe28e7cb10',previewId='7b2309a4-a301-4869-a385-995ef8d12344';let accepts=0;const preview={kind:'close_retain',status:'indicative',actionAvailable:true,operationAcceptanceAvailable:true,id:previewId,contentDigest:'${'a'.repeat(64)}',expectedRevision:2,expiresAt:new Date(Date.now()+30000).toISOString(),retainedLowerBound:{token0Raw:'123',token1Raw:'456'},costs:{closeRetain:{expectedGasUnits:'90',boundGasUnits:'110',expectedValue:'2000000000000000000',boundValue:'3000000000000000000'}}};mountStaticRetainAction(root,{campaignId:campaign,authenticated:()=>true,request:async(path)=>{if(path.endsWith('/previews'))return preview;if(path.endsWith('/operations')){accepts++;return{id:operation,status:'queued'};}if(path==='/api/operations/'+operation)return{id:operation,status:'succeeded',stage:'paper_close_retain_recorded'};throw Error('unexpected_path');},onAccepted:async()=>{},now:Date.now});root.querySelector('.retain-preview-button').click();for(let i=0;i<30&&!root.querySelector('.retain-confirm-button');i++)await new Promise(r=>setTimeout(r,10));const enabled=root.querySelector('.retain-confirm-button')?.disabled===false;const facts=root.textContent.includes('123')&&root.textContent.includes('456')&&root.textContent.includes('2.000000 / 3.000000')&&root.textContent.includes('provisional, not paid');root.querySelector('.retain-confirm-button')?.click();for(let i=0;i<120&&!root.textContent.includes('succeeded · paper_close_retain_recorded');i++)await new Promise(r=>setTimeout(r,20));const accepted=root.textContent.includes('succeeded · paper_close_retain_recorded')&&accepts===1;root.remove();return{enabled,facts,accepted};})()`);
 assert.deepEqual(actionTest,{enabled:true,facts:true,accepted:true},'Reviewed retain-close preview should be confirmable only with complete action binding and then show journal stage');
 checks.push('Authenticated retain-close review and accepted operation stage');
 const unavailableAction=await evaluate(`(async()=>{const {mountStaticRetainAction}=await import('/deployment-actions.js');const root=document.createElement('div');document.body.append(root);let accepts=0;mountStaticRetainAction(root,{campaignId:'${profileId}',authenticated:()=>true,request:async(path)=>{if(path.endsWith('/previews'))return{kind:'close_retain',status:'indicative',actionAvailable:false,operationAcceptanceAvailable:false,id:'7b2309a4-a301-4869-a385-995ef8d12344',contentDigest:'${'a'.repeat(64)}',expectedRevision:2,expiresAt:new Date(Date.now()+30000).toISOString()};if(path.endsWith('/operations'))accepts++;throw Error('unexpected_path');}});root.querySelector('.retain-preview-button').click();for(let i=0;i<30&&!root.querySelector('.retain-confirm-button');i++)await new Promise(r=>setTimeout(r,10));const result={disabled:root.querySelector('.retain-confirm-button')?.disabled===true,explained:root.textContent.includes('worker readiness'),accepts};root.remove();return result;})()`);
 assert.deepEqual(unavailableAction,{disabled:true,explained:true,accepts:0},'Saved previews without explicit worker actionability must not expose acceptance');
 checks.push('Non-actionable retain preview remains disabled');
 const rejectedTest=await evaluate(`(async()=>{const {mountStaticRetainAction}=await import('/deployment-actions.js');const root=document.createElement('div');document.body.append(root);const campaign='${profileId}',previewId='7b2309a4-a301-4869-a385-995ef8d12344';let accepts=0;const preview={kind:'close_retain',status:'indicative',actionAvailable:true,operationAcceptanceAvailable:true,id:previewId,contentDigest:'${'a'.repeat(64)}',expectedRevision:2,expiresAt:new Date(Date.now()+30000).toISOString()};mountStaticRetainAction(root,{campaignId:campaign,authenticated:()=>true,request:async(path)=>{if(path.endsWith('/previews'))return preview;if(path.endsWith('/operations')){accepts++;throw Object.assign(new Error('stale_preview'),{status:409,data:{error:'stale_preview'}});}throw Error('unexpected_path');}});root.querySelector('.retain-preview-button').click();for(let i=0;i<30&&!root.querySelector('.retain-confirm-button');i++)await new Promise(r=>setTimeout(r,10));root.querySelector('.retain-confirm-button')?.click();for(let i=0;i<30&&!root.textContent.includes('stale or conflicting');i++)await new Promise(r=>setTimeout(r,10));const result={stale:root.textContent.includes('stale or conflicting (stale_preview)'),disabled:root.querySelector('.retain-confirm-button')?.disabled===true,accepts};root.remove();return result;})()`);
 assert.deepEqual(rejectedTest,{stale:true,disabled:true,accepts:1},'Stale preview acceptance must be shown as rejected and cannot be retried without a fresh preview');
 checks.push('Stale retain-close acceptance rejected and disabled');
 const readinessTest=await evaluate(`(async()=>{const {mountStaticRetainAction}=await import('/deployment-actions.js');const root=document.createElement('div');document.body.append(root);const preview={kind:'close_retain',status:'indicative',actionAvailable:true,operationAcceptanceAvailable:true,id:'7b2309a4-a301-4869-a385-995ef8d12344',contentDigest:'${'a'.repeat(64)}',expectedRevision:2,expiresAt:new Date(Date.now()+30000).toISOString()};let accepts=0;mountStaticRetainAction(root,{campaignId:'${profileId}',authenticated:()=>true,request:async(path)=>{if(path.endsWith('/previews'))return preview;if(path.endsWith('/operations')){accepts++;throw Object.assign(new Error('operation_worker_not_ready'),{status:503,data:{error:'operation_worker_not_ready'}});}throw Error('unexpected_path');}});root.querySelector('.retain-preview-button').click();for(let i=0;i<30&&!root.querySelector('.retain-confirm-button');i++)await new Promise(r=>setTimeout(r,10));root.querySelector('.retain-confirm-button')?.click();for(let i=0;i<30&&!root.textContent.includes('Worker readiness expired');i++)await new Promise(r=>setTimeout(r,10));const result={unavailable:root.textContent.includes('Worker readiness expired'),previewEnabled:root.querySelector('.retain-preview-button')?.disabled===false,acceptDisabled:root.querySelector('.retain-confirm-button')?.disabled===true,accepts};root.remove();return result;})()`);
 assert.deepEqual(readinessTest,{unavailable:true,previewEnabled:true,acceptDisabled:true,accepts:1},'A worker lease lost after preview must remain a known no-acceptance response');
 checks.push('Worker readiness 503 blocks acceptance and re-enables fresh preview');
 const ambiguousTest=await evaluate(`(async()=>{const {mountStaticRetainAction}=await import('/deployment-actions.js');const root=document.createElement('div');document.body.append(root);const operation='90f0a8ba-b1ec-4fac-a8a3-cdfe28e7cb10',preview={kind:'close_retain',status:'indicative',actionAvailable:true,operationAcceptanceAvailable:true,id:'7b2309a4-a301-4869-a385-995ef8d12344',contentDigest:'${'a'.repeat(64)}',expectedRevision:2,expiresAt:new Date(Date.now()+30000).toISOString()};const keys=[];let posts=0;mountStaticRetainAction(root,{campaignId:'${profileId}',authenticated:()=>true,request:async(path,options={})=>{if(path.endsWith('/previews'))return preview;if(path.endsWith('/operations')){posts++;keys.push(options.body.idempotencyKey);if(posts===1)throw Error('network_timeout');return{id:operation,status:'queued',replayed:true};}if(path==='/api/operations/'+operation)return{id:operation,status:'succeeded',stage:'paper_close_retain_recorded'};throw Error('unexpected_path');},onAccepted:async info=>{if(info?.status==='reconcile_required')root.remove();}});root.querySelector('.retain-preview-button').click();for(let i=0;i<30&&!root.querySelector('.retain-confirm-button');i++)await new Promise(r=>setTimeout(r,10));root.querySelector('.retain-confirm-button')?.click();for(let i=0;i<30&&!root.textContent.includes('outcome is unknown');i++)await new Promise(r=>setTimeout(r,10));const retryEnabled=root.querySelector('.retain-confirm-button')?.disabled===false,previewDisabled=root.querySelector('.retain-preview-button')?.disabled===true,rootMounted=root.isConnected;root.querySelector('.retain-confirm-button')?.click();for(let i=0;i<120&&!root.textContent.includes('succeeded · paper_close_retain_recorded');i++)await new Promise(r=>setTimeout(r,20));const result={retryEnabled,previewDisabled,rootMounted,sameKey:keys.length===2&&keys[0]===keys[1],accepted:root.textContent.includes('succeeded · paper_close_retain_recorded'),posts};root.remove();return result;})()`);
 assert.deepEqual(ambiguousTest,{retryEnabled:true,previewDisabled:true,rootMounted:true,sameKey:true,accepted:true,posts:2},'Ambiguous acceptance must preserve the action UI and retry only with its retained idempotency key');
 checks.push('Ambiguous POST keeps idempotency key for safe reconcile retry');
 await fill('#setup-width','480');await click('#setup-review-button');await waitFor('document.querySelector("#setup-preflight-title").textContent==="Sizing preflight unavailable"');
 await check('Unavailable preflight shows fresh source reason','document.querySelector("#setup-preflight-detail").textContent.includes("fresh_source_stale")&&document.querySelector("#setup-preflight-detail").textContent.includes("No draft or operation")');
 const count=counts.setup.length;
 await fill('#setup-strategy','rangekeeper_v1');await click('#setup-review-button');
 await check('RangeKeeper remains explicitly unavailable','document.querySelector("#setup-status").textContent.includes("only static/manual paper")&&document.querySelector("#setup-preflight-result").hidden');
 assert.equal(counts.setup.length,count,'Unsupported strategy sent a preflight');
 await fill('#setup-strategy','static_manual_v1');await fill('#setup-mode','live');await click('#setup-review-button');
 await check('Live mode remains explicitly unavailable','document.querySelector("#setup-status").textContent.includes("only static/manual paper")');
 assert.equal(counts.setup.length,count,'Live mode sent a preflight');
 await size(390,844,true);await check('Operator mobile layout has no horizontal overflow','document.documentElement.scrollWidth<=innerWidth');
 const oshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});shots.push(['operator-mobile.png',Buffer.from(oshot.data,'base64')]);
 assert.equal(counts.session,1);assert.equal(counts.setup.length,2);assert.equal(counts.operations,0);assert.equal(counts.drafts,0);
 assert.deepEqual(counts.setup,[{profileId,capitalQuoteRaw:'250000000',halfWidthTicks:240},
  {profileId,capitalQuoteRaw:'250000000',halfWidthTicks:480}],'Setup payload must bind the registered profile, USDG budget and selected width');
 assert.deepEqual(errors,[],'Browser errors');
 for(const [name,data] of shots)await writeFile(join(tmp,name),data);
 console.log(JSON.stringify({checks,setupRequests:counts.setup.length,draftSubmissions:counts.drafts,
  operationSubmissions:counts.operations,browserErrors:errors,screenshots:'captured and removed with temporary profile'},null,2));
}finally{
 try{ws?.close();}catch{}
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(resolve,2500);
  child.once('exit',()=>{clearTimeout(timer);resolve();});});if(child.exitCode===null)child.kill('SIGKILL');}
 if(server.listening)await new Promise(resolve=>server.close(resolve));
 await rm(tmp,{recursive:true,force:true});
}
