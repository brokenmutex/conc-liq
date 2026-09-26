// Minimal Chromium/CDP driver shared by canonical static/manual paper flows.
// The caller owns the command server and authoritative evidence; this module
// only drives the real operator dashboard and records browser/API outcomes.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {access,mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function findChromium(){
 if(process.env.CHROMIUM_PATH){await access(process.env.CHROMIUM_PATH);return process.env.CHROMIUM_PATH;}
 const entries=await readdir('/root/.cache/ms-playwright',{withFileTypes:true}).catch(()=>[]);
 for(const entry of entries.filter(row=>row.isDirectory()&&/^chromium-\d+$/.test(row.name))
  .sort((a,b)=>Number(b.name.slice(9))-Number(a.name.slice(9)))){
  const path=`/root/.cache/ms-playwright/${entry.name}/chrome-linux64/chrome`;
  try{await access(path);return path;}catch{}
 }
 throw Error('Chromium not found; set CHROMIUM_PATH');
}

export async function startCanonicalPaperBrowser({origin,password,onTemp=()=>{},timeoutMs=30_000}){
 const profile=await mkdtemp(`${tmpdir()}/conc-liq-canonical-browser-`);onTemp(profile);
 let debugPort=0,stderr='';
 const chrome=spawn(await findChromium(),['--headless=new','--no-sandbox','--disable-dev-shm-usage',
  '--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
  {stdio:['ignore','ignore','pipe']});
 const cleanup=async()=>{
  if(chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([once(chrome,'exit'),sleep(1500)]);
   if(chrome.exitCode===null)chrome.kill('SIGKILL');}
  await rm(profile,{recursive:true,force:true});
 };
 chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',part=>{stderr+=part;
  const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
  if(match)debugPort=Number(match[1]);});
 const start=Date.now();
 while(!debugPort&&Date.now()-start<timeoutMs){
  if(chrome.exitCode!==null){await cleanup();throw Error(`Chromium exited before DevTools started: ${stderr.slice(-1000)}`);}
  await sleep(100);
 }
 if(!debugPort){await cleanup();throw Error('Chromium remote debugging did not start');}
 let target;
 try{
  const targets=await fetch(`http://127.0.0.1:${debugPort}/json`).then(response=>response.json());
  target=targets.find(row=>row.type==='page');assert(target,'Chromium has no page target');
 }catch(error){await cleanup();throw error;}
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 try{await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});
  ws.addEventListener('error',reject,{once:true});});}
 catch(error){await cleanup();throw error;}
 const pending=new Map(),exceptions=[],httpFailures=[],posts=[];let sequence=0;
 ws.addEventListener('message',event=>{const message=JSON.parse(event.data);
  if(message.id){const row=pending.get(message.id);if(!row)return;pending.delete(message.id);
   message.error?row.reject(Error(JSON.stringify(message.error))):row.resolve(message.result);}
  else if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails.text);
  else if(message.method==='Network.responseReceived'&&message.params.response.status>=400)
   httpFailures.push({status:message.params.response.status,
    path:new URL(message.params.response.url).pathname});
  else if(message.method==='Network.requestWillBeSent'&&message.params.request.method==='POST'){
   const path=new URL(message.params.request.url).pathname;
   // Exclude /api/session entirely so the operator password never enters the
   // helper's trace. Only accepted workflow requests are retained.
   if(path.startsWith('/api/deployments/'))posts.push({path,
    postData:message.params.request.postData??null});
  }
 });
 const send=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
 });
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',
  {expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;};
 const waitFor=async(expression,label=expression,waitMs=30_000)=>{
  const deadline=Date.now()+waitMs;
  while(Date.now()<deadline){
   if(chrome.exitCode!==null)throw Error(`Chromium exited waiting for ${label}: ${stderr.slice(-1000)}`);
   if(await evaluate(expression))return;
   await sleep(100);
  }
  const state=await evaluate(`document.body?.innerText?.slice(0,1200)??'no body'`);
  throw Error(`Timed out waiting for ${label}; page=${state}`);
 };
 const click=selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
  if(!e)throw Error('missing click target: '+${JSON.stringify(selector)});
  if(!e.getClientRects().length||e.disabled)throw Error('click target is hidden or disabled: '+${JSON.stringify(selector)});
  e.click();return true;})()`);
 const fill=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
  if(!e)throw Error('missing input: '+${JSON.stringify(selector)});
  if(!e.getClientRects().length||e.disabled)throw Error('input is hidden or disabled: '+${JSON.stringify(selector)});
  e.value=${JSON.stringify(String(value))};
  e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
 const navigate=async(path)=>{await send('Page.navigate',{url:origin+path});
  await waitFor('document.readyState==="complete"','page load');};
 const login=async()=>{
  await navigate('/operator');await click('#positions-tab');
  await waitFor('!document.querySelector("#operator-logout").hidden||'+
   'document.querySelector("#operator-password")?.getClientRects().length>0','operator state');
  if(await evaluate('!document.querySelector("#operator-logout").hidden'))return;
  await fill('#operator-password',password);await click('#operator-login-form button[type=submit]');
  await waitFor('!document.querySelector("#operator-logout").hidden','operator login');
  assert.equal(await evaluate('document.querySelector("#operator-password").value'),'');
 };
 const viewport=async(width,height=900)=>{
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
  if(width<600)await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  await sleep(120);
 };
 try{
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  if(password)await login();
 }catch(error){try{ws.close();}catch{}await cleanup();throw error;}
 let closed=false;
 return {origin,chrome,ws,profile,posts,exceptions,httpFailures,send,evaluate,waitFor,click,fill,
  navigate,login,viewport,close:async()=>{
   if(closed)return;closed=true;try{ws.close();}catch{}
   await cleanup();
  }};
}

export async function openPositionsHistory(browser,campaignId){
 await browser.click('#positions-tab');
 await browser.waitFor('document.querySelector("#paper .view-switch")!==null','Positions list');
 await browser.click('#paper [data-action="scope"][data-value="history"]');
 await browser.waitFor(`document.querySelector('#paper .positions-table tbody tr[data-position="paper-dep-${campaignId}"]')!==null`,
  'closed campaign in history');
 await browser.click(`#paper .positions-table tbody tr[data-position="paper-dep-${campaignId}"] .position-select`);
 await browser.waitFor('document.querySelector("#paper .position-detail .metrics")!==null','persisted position detail');
}

const defaultLimits={maxDeploymentValue:String(2000n*10n**18n),minDeploymentValue:String(1n*10n**18n),
 maxExposurePpm:950000,maxLossValue:String(100n*10n**18n),maxDrawdownPpm:100000,
 maxActionCost:String(100n*10n**18n),maxRollingCost:String(200n*10n**18n),
 maxCampaignCost:String(300n*10n**18n),exitReserveWei:'1000000000000000',maxSlippageBps:50};
const limitSelectors={maxDeploymentValue:'#limit-max-deployment',minDeploymentValue:'#limit-min-deployment',
 maxExposurePpm:'#limit-max-exposure',maxLossValue:'#limit-max-loss',maxDrawdownPpm:'#limit-max-drawdown',
 maxActionCost:'#limit-max-action-cost',maxRollingCost:'#limit-max-rolling-cost',
 maxCampaignCost:'#limit-max-campaign-cost',exitReserveWei:'#limit-exit-reserve',maxSlippageBps:'#limit-slippage-bps'};

/** Start at the setup form and obtain a draft solely through operator UI.
 * profilePool is the registered pool address; all other values are operator inputs. */
export async function createDraftAndAcceptOpen(browser,{profilePool,capital='2',halfWidthTicks,
 wallet='0x1111111111111111111111111111111111111111',nativeWei='10000000000000000000',limits=defaultLimits}){
 await browser.click('#positions-tab');
 await browser.waitFor('document.querySelector("#positions-panel").hidden===false&&'+
  'document.querySelector("#setup-pool").getClientRects().length>0',
  'visible Positions setup form');
 await browser.waitFor('document.querySelector("#setup-pool option")!==null&&!document.querySelector("#setup-pool").disabled',
  'registered setup pool');
 await browser.evaluate(`(()=>{const e=document.querySelector('#setup-pool');e.value=${JSON.stringify(profilePool)};
  e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await browser.waitFor('!document.querySelector("#setup-width").disabled','registered width choices');
 await browser.fill('#setup-capital',capital);
 if(halfWidthTicks!==undefined)await browser.fill('#setup-width',String(halfWidthTicks));
 const selectedWidth=await browser.evaluate('document.querySelector("#setup-width").value');
 // The six-stage owned-fork sampler runs only when setup limits are part of
 // the authenticated preflight request. Enter them before reviewing.
 for(const [key,selector]of Object.entries(limitSelectors))await browser.fill(selector,limits[key]);
 await browser.click('#setup-review-button');
 await browser.waitFor(`['Sizing preflight available','Sizing preflight unavailable'].includes(
  document.querySelector("#setup-preflight-title")?.textContent?.trim())`,
  'canonical setup preflight result',240_000);
 const preflightState=await browser.evaluate(`(()=>({title:document.querySelector('#setup-preflight-title')?.textContent?.trim()??'',
  detail:document.querySelector('#setup-preflight-detail')?.innerText??''}))()`);
 if(preflightState.title==='Sizing preflight unavailable'){
  const reason=preflightState.detail.match(/Reason:\s*([a-z0-9_]+)/i)?.[1]??'unknown';
  throw Error(`Canonical setup preflight unavailable: ${reason}`);
 }
 const review=await browser.evaluate(`(()=>({source:document.querySelector('#setup-preflight-facts')?.innerText??'',
  bindingHidden:document.querySelector('#operator-draft-binding').hidden,
  title:document.querySelector('#setup-preflight-title').textContent}))()`);
 assert.equal(review.bindingHidden,false,'available authenticated review must expose its exact draft binding');
 await browser.fill('#setup-wallet-address',wallet);await browser.fill('#setup-allocation-native',nativeWei);
 await browser.waitFor('document.querySelector("#save-paper-draft")?.disabled===false','reviewed setup binding');
 await browser.click('#save-paper-draft');
 await browser.waitFor('document.querySelector("#setup-draft-submit-status").textContent.includes("Saved static/manual paper draft")',
  'persisted setup draft',240_000);
 const draftId=await browser.evaluate(`document.querySelector('#setup-draft-submit-status').textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]`);
 assert(draftId,'UI must show the new persisted campaign ID');
 await browser.waitFor('document.querySelector("#setup-open-status button")?.textContent==="Accept open operation"&&'+
  'document.querySelector("#setup-open-status button").disabled===false','actionable fresh open preview',240_000);
 const openStatusBefore=await browser.evaluate('document.querySelector("#setup-open-status").innerText');
 assert.match(openStatusBefore,/provisional, not paid/i);
 assert.match(openStatusBefore,/funding remains unchecked/i);
 const postStart=browser.posts.length;
 await browser.click('#setup-open-status button');
 await browser.waitFor('document.querySelector("#setup-open-status").textContent.includes("Open operation")',
  'open acceptance response');
 const openPosts=browser.posts.slice(postStart);
 assert(openPosts.some(row=>row.path.endsWith('/open-operations')),'UI did not submit open acceptance');
 return {campaignId:draftId,halfWidthTicks:Number(selectedWidth),setupReview:review,
  openPosts,openStatus:openStatusBefore};
}

export async function selectCampaignInPositions(browser,campaignId){
 await browser.click('#positions-tab');
 await browser.waitFor('document.querySelector("#paper .view-switch")!==null','Positions list');
 let present=await browser.evaluate(`document.querySelector('#paper .positions-table tbody tr[data-position="paper-dep-${campaignId}"]')!==null`);
 if(!present){await browser.click('#paper [data-action="scope"][data-value="history"]');
  await browser.waitFor(`document.querySelector('#paper .positions-table tbody tr[data-position="paper-dep-${campaignId}"]')!==null`,
   'campaign in Positions history');}
 await browser.click(`#paper .positions-table tbody tr[data-position="paper-dep-${campaignId}"] .position-select`);
 await browser.waitFor('document.querySelector("#paper .position-detail .metrics")!==null','persisted campaign detail');
}

/** Clicks an actual Positions action, waits for its browser acceptance response,
 * and returns the captured authenticated POST path for persisted-operation checks. */
export async function acceptPositionsAction(browser,campaignId,kind,
 {beforeAccept=async()=>{},beforePreviewRequest=async()=>{},onPreviewRetry=()=>{},retryUnavailableReason,waitBeforePreviewRetry,
  previewTimeoutMs=300_000,dropAcceptedResponse=false}={}){
 await selectCampaignInPositions(browser,campaignId);
 const specs={pause:{preview:'.paper-lifecycle-action-root .paper-lifecycle-preview-button',confirm:'.paper-lifecycle-action-root .paper-lifecycle-confirm-button',
  acceptPath:'/lifecycle-operations'},
  resume:{preview:'.paper-lifecycle-action-root .paper-lifecycle-preview-button',confirm:'.paper-lifecycle-action-root .paper-lifecycle-confirm-button',
  acceptPath:'/lifecycle-operations'},
  close_retain:{preview:'.retain-action-root .retain-preview-button',confirm:'.retain-action-root .retain-confirm-button',
  acceptPath:'/operations'},
  close_convert:{preview:'.convert-action-root button',confirm:'.convert-action-root .retain-confirm-button',
  acceptPath:'/close-convert-operations'}};
 const spec=specs[kind];assert(spec,`unsupported action ${kind}`);
 if(kind==='resume')await browser.waitFor('document.querySelector(".paper-lifecycle-preview-button")?.textContent.includes("resume")',
  'resume action');
 if(kind==='pause')await browser.waitFor('document.querySelector(".paper-lifecycle-preview-button")?.textContent.includes("pause")',
  'pause action');
 await browser.waitFor(`document.querySelector(${JSON.stringify(spec.preview)})!==null`,`${kind} preview action`);
 if(kind==='close_convert')await browser.evaluate(`(()=>{const original=window.fetch.bind(window),target=
  ${JSON.stringify(`/api/deployments/${campaignId}/previews`)};window.__canonicalConvertPreview=null;
  window.__canonicalConvertPreviewCount=0;
  window.fetch=async(input,init)=>{const response=await original(input,init),path=new URL(
   typeof input==='string'?input:input.url,location.href).pathname;
   if(path===target&&init?.method==='POST'){try{const body=await response.clone().json(),model=
    body.paperCloseConvertModel??body.proposal?.paperCloseConvertModel??{};
    window.__canonicalConvertPreview={httpStatus:response.status,previewStatus:body.status??null,
     error:body.error??null,reason:body.reason??null,kind:body.kind??null,keys:Object.keys(body),
     previewId:body.id??body.previewId??null,trustedPreviewSaved:body.trustedPreviewSaved??null,
     actionAvailable:body.actionAvailable??null,operationAcceptanceAvailable:body.operationAcceptanceAvailable??null,
     terminalModelVersion:model.terminalModelVersion??null,sourceBlock:model.source?.block??body.source?.block??null,
     sourceTimestamp:model.source?.timestamp??body.source?.timestamp??null,
     pathVersion:model.costs?.pathVersion??body.costs?.pathVersion??null,
     paidGasAvailable:model.costs?.paidGasAvailable??body.costs?.paidGasAvailable??null,
     quote:body.quote?{inputAmountRaw:body.quote.inputAmountRaw??null,
      expectedOutputRaw:body.quote.expectedOutputRaw??null,minimumOutputRaw:body.quote.minimumOutputRaw??null}:null};
   }catch{window.__canonicalConvertPreview={httpStatus:response.status,error:'response_json_unavailable'};}
    window.__canonicalConvertPreviewCount++;}
   return response;};})()`);
 const before=browser.posts.length,previewDeadline=Date.now()+previewTimeoutMs;let previewResponse=null,
  previewText='',previewAttempts=0;
 while(true){
  if(Date.now()>=previewDeadline)throw Error(`${kind} preview deadline expired before a fresh request`);
  previewAttempts++;
  const previousPreviewCount=kind==='close_convert'?
   await browser.evaluate('window.__canonicalConvertPreviewCount'):null;
  await beforePreviewRequest({attempt:previewAttempts,kind,deadline:previewDeadline});
  if(Date.now()>=previewDeadline)throw Error(`${kind} preview deadline expired before a fresh request`);
  await browser.click(spec.preview);
  const remaining=Math.max(1,previewDeadline-Date.now());
  if(kind==='close_convert'){
   await browser.waitFor(`window.__canonicalConvertPreviewCount>${previousPreviewCount}`,
    `${kind} API preview response`,remaining);
   await browser.waitFor('document.querySelector(".convert-action-root .retain-action-review")?.hidden===false',
    `${kind} rendered preview response`,remaining);
  }else await browser.waitFor(`document.querySelector(${JSON.stringify(spec.confirm)})!==null`,
   `${kind} preview response`,remaining);
  const confirmState=await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(spec.confirm)});
   return {disabled:e.disabled,hidden:!e.getClientRects().length};})()`);
  previewText=await browser.evaluate(`document.querySelector(".position-detail")?.innerText??''`);
  previewResponse=kind==='close_convert'?await browser.evaluate('window.__canonicalConvertPreview'):null;
  if(!confirmState.hidden&&!confirmState.disabled)break;
  const retryReason=kind==='close_convert'&&previewResponse?.reason===
   'static_manual_conversion_preparation_busy'?'static_manual_conversion_preparation_busy':
   kind==='close_convert'&&previewResponse?.reason==='paper_close_convert_fee_interval_gap'?
    'paper_close_convert_fee_interval_gap':
   kind==='close_convert'&&previewResponse?.reason==='static_manual_conversion_prestate_unavailable'&&
    retryUnavailableReason?await retryUnavailableReason({attempt:previewAttempts,previewResponse,
     deadline:previewDeadline}):null;
  if(retryReason&&Date.now()<previewDeadline&&previewAttempts<120){
   onPreviewRetry({attempt:previewAttempts,reason:retryReason,
    responseReason:previewResponse?.reason??null});
   if(waitBeforePreviewRetry)await waitBeforePreviewRetry({attempt:previewAttempts,
    reason:retryReason,deadline:previewDeadline});
   else await sleep(Math.min(2_500,Math.max(1,previewDeadline-Date.now())));
   await browser.waitFor(`document.querySelector(${JSON.stringify(spec.preview)})?.disabled===false`,
    'fresh convert preview action after busy preparation lease',
    Math.max(1,previewDeadline-Date.now()));
   continue;
  }
  throw Error(`${kind} preview is nonactionable: ${previewText.slice(-1600)}; response=${JSON.stringify(previewResponse)}`);
 }
 if(kind==='close_retain')assert.match(previewText,/provisional, not paid/i);
 if(kind==='close_convert')assert.match(previewText,/provisional/i);
 await beforeAccept({kind,previewText,previewResponse});
 const acceptancePath=`/api/deployments/${campaignId}${spec.acceptPath}`;
 await browser.evaluate(`(()=>{const original=window.fetch.bind(window),target=${JSON.stringify(acceptancePath)};
  window.__canonicalAcceptedResponse=null;window.fetch=async(input,init)=>{const response=await original(input,init),
   path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
   if(path===target&&init?.method==='POST'){try{const body=await response.clone().json();
    window.__canonicalAcceptedResponse={httpStatus:response.status,id:body.id??null,
     status:body.status??null,error:body.error??null,reason:body.reason??null};
   }catch{window.__canonicalAcceptedResponse={httpStatus:response.status,responseJsonUnavailable:true};}}
   return response;};})()`);
 if(dropAcceptedResponse){
  await browser.evaluate(`(()=>{const original=window.fetch.bind(window),target=${JSON.stringify(acceptancePath)};
   let dropped=false;window.__canonicalDroppedAcceptedResponse=false;
   window.fetch=async(input,options)=>{const response=await original(input,options),
    requestPath=new URL(typeof input==='string'?input:input.url,location.href).pathname;
    if(!dropped&&options?.method==='POST'&&requestPath===target&&response.status===202){
     dropped=true;window.__canonicalDroppedAcceptedResponse=true;
     throw new TypeError('fixture_lost_accepted_response');}return response;};})()`);
 }
 await browser.click(spec.confirm);
 if(dropAcceptedResponse){
  await browser.waitFor('window.__canonicalDroppedAcceptedResponse===true',
   `${kind} injected accepted-response loss`,60_000);
  assert.equal(await browser.evaluate('window.__canonicalDroppedAcceptedResponse'),true,
   `${kind} recovery fixture did not drop the actual accepted 202 response`);
  const recoverySelector=`#pending-paper-acceptance-recovery .paper-acceptance-reconcile-button`+
   `[data-campaign-id="${campaignId}"][data-kind="${kind}"]`;
  await browser.waitFor(`document.querySelector(${JSON.stringify(recoverySelector)})!==null&&
   document.querySelector(${JSON.stringify(recoverySelector)}).disabled===false&&
   document.querySelector(${JSON.stringify(recoverySelector)}).getClientRects().length>0`,
   `${kind} saved-acceptance reconciliation control`,60_000);
 }
 await browser.waitFor('window.__canonicalAcceptedResponse!==null',
  `${kind} captured acceptance response`,60_000);
 const acceptedResponse=await browser.evaluate('window.__canonicalAcceptedResponse');
 assert.equal(acceptedResponse.httpStatus,202,`${kind} should receive persisted 202 acceptance: ${JSON.stringify(acceptedResponse)}`);
 assert(acceptedResponse.id&&acceptedResponse.status,
  `${kind} acceptance response must include operation identity and status: ${JSON.stringify(acceptedResponse)}`);
 const posts=browser.posts.slice(before),path=acceptancePath;
 assert(posts.some(row=>row.path===path),`UI did not submit ${path}`);
 return {kind,posts,previewText,previewResponse,previewAttempts,acceptedResponse,
  status:await browser.evaluate('document.querySelector(".position-detail")?.innerText??""')};
}

export async function inspectPositionAtWidths(browser,campaignId,expectedStages,
 {expectedVisibleValues=[],expectedGapLabels=['unavailable'],expectedMarkCount,history=true}={}){
 if(history)await openPositionsHistory(browser,campaignId);
 else await selectCampaignInPositions(browser,campaignId);
 await browser.click('#paper .bottom-tabs button[data-action="tab"][data-value="activity"]');
 await browser.waitFor('document.querySelector("#paper .activity-list")!==null','activity tab');
 for(const stage of expectedStages)await browser.waitFor(
  `document.querySelector("#paper .activity-list")?.textContent.includes(${JSON.stringify(stage)})`,
  `persisted activity ${stage}`);
 const result={};
 for(const [name,width,height]of [['desktop',1440,1000],['mobile',390,844]]){
  await browser.viewport(width,height);
  result[name]=await browser.evaluate(`(()=>({text:document.querySelector('#paper')?.innerText??'',
   activity:document.querySelector('#paper .activity-list')?.innerText??'',
   chartTitle:document.querySelector('#paper-chart title')?.textContent??'',
   chartElements:document.querySelectorAll('#paper-chart path,#paper-chart line,#paper-chart circle').length,
   chartFootnote:document.querySelector('#paper .chart-footnote')?.innerText??'',
   chartPeriods:[...document.querySelectorAll('#paper .periods button')].map(button=>({text:button.textContent,pressed:button.getAttribute('aria-pressed')})),
   metrics:[...document.querySelectorAll('#paper .metric')].map(node=>node.innerText),
   scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,
   detail:!!document.querySelector('#paper .position-detail')}))()`);
  assert(result[name].detail,`${name} view lost position detail`);
  assert(result[name].chartTitle,`${name} view lacks chart title`);
  assert(result[name].chartElements>0,`${name} view chart has no rendered content`);
  if(expectedMarkCount!==undefined)assert(result[name].chartFootnote.includes(`${expectedMarkCount} marks`),
   `${name} chart mark count differs from persisted history: ${result[name].chartFootnote}`);
  assert(result[name].chartPeriods.some(period=>period.text==='24h'&&period.pressed==='true'),
   `${name} chart does not show the 24h window selected`);
  assert(result[name].scrollWidth<=result[name].viewport+1,
   `${name} view overflows ${result[name].scrollWidth}/${result[name].viewport}`);
  for(const stage of expectedStages)assert(result[name].activity.includes(stage),`${name} view omits ${stage}`);
  for(const value of expectedVisibleValues)assert(result[name].text.includes(String(value)),
   `${name} view does not match persisted value ${value}`);
  for(const label of expectedGapLabels)assert(result[name].text.toLowerCase().includes(label.toLowerCase()),
   `${name} view omitted explicit gap ${label}`);
  if(process.env.TEST_BROWSER_EVIDENCE_DIR){
   const directory=`${process.env.TEST_BROWSER_EVIDENCE_DIR}/${campaignId}`;
   await mkdir(directory,{recursive:true});
   await browser.evaluate("document.querySelector('#paper .position-detail')?.scrollIntoView({block:'start'})");
   const layout=await browser.send('Page.getLayoutMetrics'),size=layout.cssContentSize??layout.contentSize;
   const screenshot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,
    clip:{x:0,y:0,width:size.width,height:size.height,scale:1}});
   await writeFile(`${directory}/${name}.png`,Buffer.from(screenshot.data,'base64'));
  }
 }
 return result;
}

export function assertBrowserHealthy(browser){
 assert.deepEqual(browser.exceptions,[],'dashboard threw a browser exception');
 assert.deepEqual(browser.httpFailures.filter(row=>/\.(js|css)$/.test(row.path)),[],
  'dashboard asset failed to load');
}
