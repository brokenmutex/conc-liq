// Run with TEST_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql' node --import tsx test/integration/dashboard-setup-command-browser.mjs
// The only simulated boundary is canonical chain observation; PostgreSQL,
// command HTTP routes, session/CSRF, dashboard assets, browser and saved state
// are real. Default mode starts no worker; the optional lifecycle mode runs
// bounded in-process paper worker passes. Neither mode loads a signer.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {access,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createServer as createTcpServer} from 'node:net';
import pg from 'pg';
import {contentHash} from '../../src/deployments/contracts.ts';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {createStaticPaperDraftFromSetup} from '../../src/deployments/static-paper-draft-admission.ts';
import {buildStaticPaperSetupPreflight} from '../../src/deployments/paper-setup-preflight.ts';
import {buildIndicativePaperOpenPreview} from '../../src/deployments/paper-preview.ts';
import {costIndicativePaperOpenPreview,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from '../../src/deployments/paper-cost.ts';
import {persistTrustedPaperOpenPreview} from '../../src/deployments/paper-open-preflight.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';
import {processOnePaperOperation} from '../../src/deployments/paper-operation-worker.ts';
import {PAPER_OPERATION_READINESS_LOCK} from '../../src/deployments/store.ts';
import {persistTrustedStaticPaperRetainPreview} from '../../src/deployments/paper-close-retain-preflight.ts';
import {readDeploymentRows,deploymentPosition,readDeploymentDetail} from '../../src/dashboard/deployment-position.ts';

// Opt-in positive workflow mechanics. Chain frames/headers remain synthetic;
// this mode does not establish owned-fork economics or production readiness.
const completeLifecycle=process.argv.includes('--complete-static-lifecycle');

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),admin=await adminPool.connect();
const schema=`dashboard_command_${randomUUID().replaceAll('-','')}`,temp=await mkdtemp(`${tmpdir()}/conc-liq-command-browser-`);
let store,server,chrome,ws,workerLease;const errors=[],resourceFailures=[],checks=[];
const blockSource={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
const sourceHash=`0x${'a'.repeat(64)}`,codeHash=`0x${'c'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0:USDG,
 token1:'0xf000000000000000000000000000000000000001',quoteToken:0,decimals0:6,decimals1:6,
 fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
 poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,managerCodeHash:codeHash,
 quoterCodeHash:codeHash,reference0:'USDG/USD',reference1:'TOKEN/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const profileHash=contentHash(profile),poolAddress=profile.pool.pool;let profileId='';
const referenceProof={fixture:'loopback-command-browser-source-boundary'};
const frame=()=>({source:blockSource,tick:0,sqrtPriceX96:sqrtRatioAtTick(0),poolLiquidity:10n**24n,
 price0:10n**18n,price1:10n**18n,nativePrice:2000n*10n**18n,referenceEligible:true,
 referenceReasons:[],referenceProofHash:referenceProofHash(referenceProof),referenceProof});
const readSetup=async(input,pinnedSource)=>buildStaticPaperSetupPreflight(input,{
 loadProfile:id=>store.paperSetupProfile(id),readFrame:async(_profile,source)=>{
  if(source&&(source.block!==blockSource.block||source.hash!==blockSource.hash||source.timestamp!==blockSource.timestamp))
   throw Error('mock_source_not_canonical');
  return frame();},
 verifyCanonical:async(_chainId,source)=>{
  if(source.block!==blockSource.block||source.hash!==blockSource.hash||source.timestamp!==blockSource.timestamp)
   throw Error('mock_source_not_canonical');},
 readGasProfiles:address=>store.paperGasProfiles(address),readGasPrice:async()=>1_000_000_000n,
},pinnedSource);

async function chromiumPath(){
 if(process.env.CHROMIUM_PATH)return process.env.CHROMIUM_PATH;
 const entries=await readdir('/root/.cache/ms-playwright',{withFileTypes:true});
 for(const entry of entries.filter(item=>item.isDirectory()&&/^chromium-\d+$/.test(item.name))
  .sort((a,b)=>Number(b.name.slice(9))-Number(a.name.slice(9)))){
  const candidate=`/root/.cache/ms-playwright/${entry.name}/chrome-linux64/chrome`;
  try{await access(candidate);return candidate;}catch{}
 }
 throw Error('Chromium not found; set CHROMIUM_PATH');
}

try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const dbUrl=new URL(process.env.TEST_DATABASE_URL);dbUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(dbUrl.toString());await store.assertReady();
 const targetSetHash=`0x${'d'.repeat(64)}`;
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES('browser-fixture',$1,4663,'TOKEN',$2,3000,1,$3,true)`,
 [poolAddress,profile.pool.token1,targetSetHash]);
 const verified={profile,profileHash,streamKey:'browser-fixture',source:blockSource,
  contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
   managerCodeHash:codeHash,quoterCodeHash:codeHash},
  references:{price0:'1000000000000000000',price1:'1000000000000000000',
   nativePrice:'2000000000000000000000',proofHash:referenceProofHash(referenceProof)},
  referenceProof,verifiedAt:new Date().toISOString()};
 const registered=await store.registerVerifiedMarketProfile(verified);assert.equal(registered.created,true);
 profileId=registered.id;assert.equal((await store.paperSetupProfile(profileId)).profileHash,profileHash);
}catch(error){
 await store?.close().catch(()=>{});admin.release();await adminPool.end();await rm(temp,{recursive:true,force:true});throw error;
}

try{

const gasSource={block:'99',hash:`0x${'9'.repeat(64)}`,estimatedAt:new Date().toISOString(),
 callHash:`0x${'8'.repeat(64)}`,method:'owned_fork_nitro_exact_call_v1'};
for(const stage of PAPER_STATIC_GAS_STAGES){
 const model={schemaVersion:1,source:gasSource,gasUnitsExpected:'100000',gasUnitsBound:'150000',
  sizeMinValue:'1',sizeMaxValue:String(500n*10n**18n),shareMinPpm:'0',shareMaxPpm:'1000000',
  tickLower:-240,tickUpper:240};
 await admin.query(`INSERT INTO deployment_calibration_profiles
  (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,component,status,
   evidence_class,model,validation,source_hash,observed_until)
  VALUES($1,1,4663,$2,$3,$4,'zero','browser_1_to_500','gas_units','provisional',
   'fork_estimated',$5,'{}',$6,$7)`,[randomUUID(),poolAddress,PAPER_STATIC_GAS_PATH,stage,
  JSON.stringify(model),contentHash(gasSource),gasSource.estimatedAt]);
}
assert.equal((await store.paperGasProfiles(poolAddress)).length,6);

let lastOpenPreview=null,openPreviewRequests=0,openAcceptRequests=0;
const previewAttempts=[];
const verifySource=async(_chainId,sources)=>{
 for(const source of sources)if(source.block!==blockSource.block||source.hash!==sourceHash||
  source.timestamp!==blockSource.timestamp)throw Error('mock_source_not_canonical');
};
const paperPreview=async(campaignId,kind)=>{
 previewAttempts.push(kind);
 if(completeLifecycle&&(kind==='pause'||kind==='resume'))return store.recordPaperLifecyclePreview(campaignId,kind);
 if(completeLifecycle&&kind==='close_retain'){
  const state=await store.paperValuationState(campaignId),terminalFrame={...frame(),
   source:{...blockSource,block:'101',hash:`0x${'b'.repeat(64)}`}};
  const gasProfiles=await store.paperGasProfiles(poolAddress);
  return persistTrustedStaticPaperRetainPreview({store,state,frame:terminalFrame,
   gasProfiles,gasPriceWei:1_000_000_000n,
   verifyAnchors:verifyWorkflowAnchors});
 }
 if(kind!=='open')return {kind,status:'unavailable',reason:'not_in_harness',actionAvailable:false};
 openPreviewRequests++;
 const draft=await store.paperDraft(campaignId),freshFrame=frame();
 const indicative=buildIndicativePaperOpenPreview(draft,freshFrame);
 const costed=costIndicativePaperOpenPreview(indicative,await store.paperGasProfiles(draft.profile.pool.pool),
  draft.profile.pool.pool,freshFrame.nativePrice,1_000_000_000n);
 if(costed.status!=='indicative'||costed.costs.status!=='provisional')return costed;
 const saved=await persistTrustedPaperOpenPreview({store,draft,frame:freshFrame,preview:costed,
  verifyAnchors:verifySource});
 lastOpenPreview={id:saved.id,contentDigest:saved.contentDigest,expectedRevision:saved.expectedRevision};
 return {...costed,...saved,kind:'open',status:'indicative',trustedPreviewSaved:true,
  actionAvailable:false,operationAcceptanceAvailable:false,economics:null};
};

const salt=randomBytes(16),password='local-integration-only-password',
 passwordHash=`scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
const portProbe=createTcpServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
const address=portProbe.address();assert(address&&typeof address!=='string');const port=address.port;
await new Promise((resolve,reject)=>portProbe.close(error=>error?reject(error):resolve()));
const origin=`http://127.0.0.1:${port}`;
const chain={getChainId:async()=>4663,getBlock:async({blockNumber})=>{
 const number=String(blockNumber);assert(['100','101'].includes(number),'synthetic header is explicitly bounded');
 return {hash:number==='100'?sourceHash:`0x${'b'.repeat(64)}`,timestamp:BigInt(blockSource.timestamp)};
}};
const verifyWorkflowAnchors=async(chainId,sources)=>{
 assert.equal(chainId,4663);
 for(const source of sources){const header=await chain.getBlock({blockNumber:BigInt(source.block)});
  assert.equal(header.hash,source.hash);assert.equal(Number(header.timestamp),source.timestamp);}
};
const dashboardRead=async(path)=>{
 if(path==='/api/dashboard')return {pools:[{registryEnabled:true,poolAddress,rwaSymbol:'TOKEN',fee:3000,tickSpacing:60}]};
 if(path==='/api/research')return {generatedAt:new Date().toISOString(),pools:[],windows:[]};
 if(path.startsWith('/api/positions')){
  const rows=completeLifecycle?await readDeploymentRows(admin):[];
  const id=decodeURIComponent(path.split('?')[0].slice('/api/positions/'.length));
  if(path.startsWith('/api/positions/')){
   const row=rows.find(row=>`paper-dep-${row.id}`===id);
   assert(row,'detail must come from persisted campaign');return readDeploymentDetail(admin,row,24);
  }
  return {positions:rows.map(deploymentPosition),serverTime:new Date().toISOString()};
 }
 throw Error('unexpected_dashboard_path');
};
server=createDeploymentCommandServer(store,{origin,passwordHash,dashboardRead,
 paperSetupPreflight:input=>readSetup(input),
 paperSetupDraftAdmission:input=>createStaticPaperDraftFromSetup(input,{
  runPreflight:(request,pinned)=>readSetup(request,pinned),loadProfile:id=>store.paperSetupProfile(id),
  findDraftRequest:(id,draft)=>store.findDraftRequest(id,draft),
  createDraftWithRequestId:(id,draft)=>store.createDraftWithRequestId(id,draft)}),
 paperSetupDraftList:()=>store.listStaticPaperDrafts(),paperPreview,
 paperOperationReplay:(id,input,kinds)=>store.acceptedOperationReplay(id,input,kinds),
 paperOpenAcceptance:async(id,input,actor)=>{openAcceptRequests++;
  return store.acceptStaticPaperOpenOperation(id,input,actor,verifySource);},
 ...(completeLifecycle?{
  paperLifecycleAcceptance:(id,input,actor)=>store.acceptStaticPaperLifecycleOperation(id,input,actor),
  paperRetainAcceptance:(id,input,actor)=>store.acceptStaticPaperRetainOperation(id,input,actor,verifyWorkflowAnchors),
 }:{}),
 paperRetainWorkerReady:()=>store.paperOperationWorkerReady()});
server.listen(port,'127.0.0.1');await once(server,'listening');

let debugPort=0,stderr='';
chrome=spawn(await chromiumPath(),['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
 '--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
 '--user-data-dir='+temp,'about:blank'],{stdio:['ignore','ignore','pipe']});
chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',part=>{stderr+=part;
 const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);if(match)debugPort=Number(match[1]);});
for(let i=0;i<120&&!debugPort;i++){if(chrome.exitCode!==null)throw Error('Chromium exited: '+stderr);
 await new Promise(resolve=>setTimeout(resolve,100));}
assert(debugPort,'Chromium did not start remote debugging');
const targets=await fetch(`http://127.0.0.1:${debugPort}/json`).then(response=>response.json());
const target=targets.find(item=>item.type==='page');assert(target);
ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{
 ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
let sequence=0;const pending=new Map();
ws.addEventListener('message',event=>{const message=JSON.parse(event.data);
 if(message.id){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);
  message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}
 else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);
 else if(message.method==='Network.responseReceived'&&message.params.response.status>=400)
  resourceFailures.push({status:message.params.response.status,url:message.params.response.url});});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});
 ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const result=await send('Runtime.evaluate',{
 expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const waitFor=async expression=>{for(let i=0;i<160;i++){if(await evaluate(expression))return;
 await new Promise(resolve=>setTimeout(resolve,100));}
 throw Error('Timed out waiting for '+expression+'; state='+JSON.stringify(await evaluate(`({draft:document.querySelector('#setup-draft-submit-status')?.textContent,
 setup:document.querySelector('#setup-status')?.textContent,preflight:document.querySelector('#setup-preflight-title')?.textContent,
 binding:document.querySelector('#operator-draft-binding-status')?.textContent,button:document.querySelector('#save-paper-draft')?.disabled,
 auth:document.querySelector('#operator-auth-status')?.textContent,logoutHidden:document.querySelector('#operator-logout')?.hidden,
 savedStatus:document.querySelector('#saved-paper-drafts-status')?.textContent,savedHidden:document.querySelector('#saved-paper-drafts')?.hidden,
 recoveryHidden:document.querySelector('#pending-open-recovery')?.hidden,
 actionStatus:[...document.querySelectorAll('.retain-action-status')].map(e=>e.textContent),
 localOpen:localStorage.getItem('concliq.operator.paper-open.pending.v1')})`))+
 ` errors=${JSON.stringify(errors)} previewAttempts=${JSON.stringify(previewAttempts)} responses=${JSON.stringify(resourceFailures)}`);};
const check=async(name,expression)=>{assert(await evaluate(expression),name);checks.push(name);};
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const fill=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};
 e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const navigate=async(path)=>{await send('Page.navigate',{url:origin+path});await waitFor('document.readyState==="complete"');
 await new Promise(resolve=>setTimeout(resolve,100));};
await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await navigate('/operator');await waitFor('document.querySelectorAll("[role=tab]").length===2');
await check('Authenticated command origin serves the existing two-tab dashboard and operator sign-in',
 '[...document.querySelectorAll("[role=tab]")].map(x=>x.textContent.trim()).join(",")==="Research,Positions"&&!document.querySelector("#operator-auth").hidden');
await fill('#operator-password',password);await click('#operator-login-form button[type=submit]');
await waitFor('!document.querySelector("#operator-logout").hidden&&document.querySelector("#setup-width").options.length>1');
await check('Real command server authenticates operator and loads registered DB profile',
 'document.querySelector("#setup-pool").options[0].value==='+JSON.stringify(poolAddress)+'&&document.querySelector("#operator-password").value===""');
await click('#setup-review-button');await waitFor('document.querySelector("#setup-preflight-title").textContent==="Sizing preflight available"');
await check('Preflight binds the registered quote-token index for exact draft admission',
 'document.querySelector("#setup-preflight-facts").textContent.includes("USDG")');
await fill('#setup-wallet-address','0x1111111111111111111111111111111111111111');
await fill('#setup-allocation-native','2000000000000000');
const limits=[['#limit-max-deployment','10000000000000000000000'],['#limit-min-deployment','1000000000000000000'],
 ['#limit-max-exposure','1000000'],['#limit-max-loss','10000000000000000000000'],['#limit-max-drawdown','1000000'],
 ['#limit-max-action-cost','10000000000000000000'],['#limit-max-rolling-cost','20000000000000000000'],
 ['#limit-max-campaign-cost','30000000000000000000'],['#limit-exit-reserve','1000000000000000'],
 ['#limit-slippage-bps','50']];
for(const [selector,value]of limits)await fill(selector,value);
await waitFor('document.querySelector("#save-paper-draft").disabled===false');
await click('#save-paper-draft');await waitFor('document.querySelector("#setup-draft-submit-status").textContent.includes("Saved static/manual paper draft")');
const draftId=await evaluate(`document.querySelector("#setup-draft-submit-status").textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]`);
assert(draftId,'browser shows a persisted draft ID');
await waitFor('document.querySelector(".saved-paper-draft")!==null&&document.querySelector("#setup-open-status").textContent.includes("worker readiness")');
assert.equal((await admin.query(`SELECT count(*)::int AS count FROM deployment_campaigns WHERE id=$1 AND lifecycle='draft'`,[draftId])).rows[0].count,1);
assert.equal((await admin.query('SELECT count(*)::int AS count FROM deployment_previews WHERE campaign_id=$1',[draftId])).rows[0].count,1);
await check('Browser draft POST persists one campaign and actual command list recovers it',
 'document.querySelector(".saved-paper-draft").textContent.includes('+JSON.stringify(draftId)+')&&document.querySelector("#setup-open-status").textContent.includes("worker readiness")');
await check('Fresh open preview is persisted but acceptance stays disabled without worker lease',
 'document.querySelector("#setup-open-status").textContent.includes("provisional, not paid")&&document.querySelector("#setup-open-status button").disabled===true');

await navigate('/operator');await fill('#operator-password',password);await click('#operator-login-form button[type=submit]');
await waitFor('document.querySelector(".saved-paper-draft")!==null');
await check('Reload lists DB-backed draft config without current source or costs',
 'document.querySelector("#saved-paper-drafts").textContent.includes("Saved configuration hash")&&document.querySelector("#saved-paper-drafts").textContent.includes("Current source / current costsUnavailable")');
const openKey=randomUUID(),pendingRecord={campaignId:draftId,payload:{previewId:lastOpenPreview.id,
 contentDigest:lastOpenPreview.contentDigest,expectedRevision:lastOpenPreview.expectedRevision,idempotencyKey:openKey}};
await evaluate(`localStorage.setItem('concliq.operator.paper-open.pending.v1',${JSON.stringify(JSON.stringify(pendingRecord))})`);
await navigate('/operator');await fill('#operator-password',password);await click('#operator-login-form button[type=submit]');
await waitFor('document.querySelector("#pending-open-recovery").hidden===false');
await click('#retry-pending-open');
await waitFor('document.querySelector("#pending-open-recovery-detail").textContent.includes("earlier acceptance outcome remains unknown")');
await check('Real command API 503 preserves same-key open recovery and blocks another preview',
 'document.querySelector("#retry-pending-open").disabled===false&&document.querySelector("#refresh-open-preview").disabled&&'+
 'JSON.parse(localStorage.getItem("concliq.operator.paper-open.pending.v1")).payload.idempotencyKey==='+JSON.stringify(openKey));
assert.equal((await admin.query('SELECT count(*)::int AS count FROM deployment_operations WHERE campaign_id=$1',[draftId])).rows[0].count,0);
assert.equal(openAcceptRequests,0,'worker-not-ready never reaches the operation acceptance callback');
assert.equal(openPreviewRequests,1,'one fresh open preview follows draft creation');
if(completeLifecycle){
 workerLease=await adminPool.connect();
 assert.equal((await workerLease.query('SELECT pg_try_advisory_lock_shared($1::int,$2::int) AS acquired',
  PAPER_OPERATION_READINESS_LOCK)).rows[0].acquired,true);
 const waitOperation=async(kind)=>{
  for(let attempt=0;attempt<100;attempt++){
   const row=(await admin.query(`SELECT id::text,status FROM deployment_operations
    WHERE campaign_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1`,[draftId,kind])).rows[0];
   if(row)return row;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error(`Browser did not submit ${kind}`);
 };
 const complete=async(kind,lifecycle)=>{
  const operation=await waitOperation(kind);
  const result=await processOnePaperOperation(store,chain,admin,`browser-${kind}`);
  assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.operationId,operation.id);
  assert.equal((await admin.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[draftId])).rows[0].lifecycle,lifecycle);
  assert.equal((await store.operation(operation.id)).status,'succeeded');
  return operation;
 };
 await click('#retry-pending-open');
 const opened=await complete('open','active');
 await waitFor('localStorage.getItem("concliq.operator.paper-open.pending.v1")===null');
 assert.equal(openAcceptRequests,1);
 assert.equal((await admin.query('SELECT idempotency_key FROM deployment_operations WHERE id=$1',[opened.id])).rows[0].idempotency_key,openKey);
 const rows=await readDeploymentRows(admin),row=rows.find(row=>row.id===draftId);
 assert(row);assert.equal(deploymentPosition(row).status,'open');
 assert.equal((await readDeploymentDetail(admin,row,24)).performance.timeline[0].action,'enter');
 checks.push('Browser retries the same pending open key after lease readiness; real worker books one open');
 const showPositions=async()=>{
  await navigate('/operator');await fill('#operator-password',password);await click('#operator-login-form button[type=submit]');
  await waitFor('!document.querySelector("#operator-logout").hidden');
  await evaluate('[...document.querySelectorAll("[role=tab]")].find(e=>e.textContent.trim()==="Positions").click()');
  await waitFor('document.querySelector("#paper-chart title")!==null');
  await waitFor('document.querySelector(".paper-lifecycle-preview-button")&&!document.querySelector(".paper-lifecycle-preview-button").disabled');
 };
 for(const [kind,lifecycle]of [['pause','paused'],['resume','active']]){
  await showPositions();await click('.paper-lifecycle-preview-button');
  await waitFor('document.querySelector(".paper-lifecycle-confirm-button")?.disabled===false');
  await click('.paper-lifecycle-confirm-button');await complete(kind,lifecycle);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_marks WHERE campaign_id=$1',[draftId])).rows[0].n,1);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_ledger WHERE campaign_id=$1',[draftId])).rows[0].n,3);
  checks.push(`Authenticated browser ${kind} completes through the durable paper worker`);
 }
 await showPositions();await click('.retain-preview-button');
 await waitFor('document.querySelector(".retain-confirm-button")!==null||document.querySelector(".retain-action-root .retain-action-status")?.textContent.includes("unavailable")||document.querySelector(".retain-action-root .retain-action-status")?.textContent.includes("rejected")');
 assert(await evaluate('document.querySelector(".retain-confirm-button")?.disabled===false'),
  await evaluate('document.querySelector(".retain-action-root").textContent'));
 checks.push('Retain preview is actionable at the authenticated boundary');
 await click('.retain-confirm-button');await complete('close_retain','closed');
 const closedRows=await readDeploymentRows(admin),closedRow=closedRows.find(row=>row.id===draftId);
 assert.equal(deploymentPosition(closedRow).status,'closed');
 assert.equal((await readDeploymentDetail(admin,closedRow,24)).performance.timeline.at(-1).action,'exit');
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_marks WHERE campaign_id=$1',[draftId])).rows[0].n,2);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_operations WHERE campaign_id=$1',[draftId])).rows[0].n,4);
 assert.equal((await processOnePaperOperation(store,chain,admin,'browser-restarted')).status,'idle');
 checks.push('Browser retain-close records one terminal mark; restarted worker has no duplicate action');
 await navigate('/operator');
 await evaluate('[...document.querySelectorAll("[role=tab]")].find(e=>e.textContent.trim()==="Positions").click()');
 await click('#paper [data-action="scope"][data-value="history"]');
 await waitFor('document.querySelector("#paper").textContent.includes("Campaign closed")');
 for(const [width,mobile]of [[1440,false],[390,true]]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile});
  await check(`Closed persisted workflow has no active controls or overflow at ${width}px`,
   '!document.querySelector(".paper-lifecycle-preview-button")&&!document.querySelector(".retain-preview-button")&&document.documentElement.scrollWidth<=innerWidth');
 }
}
assert.equal(errors.length,0,JSON.stringify(errors));
assert.equal(resourceFailures.filter(item=>item.status===404&&/\.(js|css)(\?|$)/.test(item.url)).length,0,
 'dashboard script/style assets load without 404s: '+JSON.stringify(resourceFailures));
console.log(JSON.stringify({checks,profileId,draftId,openPreviewId:lastOpenPreview?.id,
 openPreviewRequests,openAcceptRequests,operationsPersisted:completeLifecycle?4:0,workerStarted:completeLifecycle,signerLoaded:false,
 browserExceptions:errors,httpResponses:resourceFailures,sourceBoundary:'deterministic canonical frame and anchor verifier only'},null,2));

}finally{
 try{ws?.close();}catch{}
if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await new Promise(resolve=>{
 const timer=setTimeout(resolve,2000);chrome.once('exit',()=>{clearTimeout(timer);resolve();});});
 if(chrome.exitCode===null)chrome.kill('SIGKILL');}
if(server?.listening)await new Promise(resolve=>server.close(resolve));
await store?.close();await admin.query('SET search_path=public');
if(workerLease){await workerLease.query('SELECT pg_advisory_unlock_shared($1::int,$2::int)',PAPER_OPERATION_READINESS_LOCK);
 workerLease.release();}
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await adminPool.end();
await rm(temp,{recursive:true,force:true});
}
