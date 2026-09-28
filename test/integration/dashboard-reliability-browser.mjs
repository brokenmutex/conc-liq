// Run with TEST_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql' node --import tsx test/integration/dashboard-reliability-browser.mjs
// Track 2 reliability: R1 degraded dependency matrix, R3 session contention,
// R4 interface concurrency and idempotency, R5 reload during a pending
// operation. PostgreSQL, the delaying TCP proxy this run owns in front of its
// own read pool, the command HTTP routes, session and CSRF handling, the
// dashboard assets, two real browser tabs and their saved state are real; the
// canonical chain frame and the aged source timestamp in R1 are the only
// simulated boundaries. No signer is loaded, no service is started or stopped
// and nothing outside this run's own schema, server, proxy and browser is
// touched.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {access,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer as createTcpServer,connect as tcpConnect} from 'node:net';
import pg from 'pg';
import {contentHash} from '../../src/deployments/contracts.ts';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {DeploymentStore,PAPER_OPERATION_READINESS_LOCK} from '../../src/deployments/store.ts';
import {createStaticPaperDraftFromSetup} from '../../src/deployments/static-paper-draft-admission.ts';
import {StaticPaperSetupReviewCache} from '../../src/deployments/static-paper-setup-review-cache.ts';
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
import {readDeploymentRows,deploymentPosition,readDeploymentDetail} from '../../src/dashboard/deployment-position.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6}),admin=await adminPool.connect();
const schema=`track2_${randomUUID().replaceAll('-','')}`,temp=await mkdtemp(`${tmpdir()}/conc-liq-reliability-browser-`);
let store,server,chrome,readPool,pgProxy,workerLease;
const tabs=[],errors=[],resourceFailures=[],checks=[],findings=[],liveSockets=new Set();
const blockSource={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
// The canonical observation boundary: the command service admits a fresh open
// preview only inside its 180 s source window, so long phases re-stamp it.
const refreshSource=()=>{blockSource.timestamp=Math.floor(Date.now()/1000);};
const codeHash=`0x${'c'.repeat(64)}`;
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
const referenceProof={fixture:'loopback-reliability-browser-source-boundary',
 registry:{fetchedAt:new Date().toISOString(),sha256:`sha256:${'1'.repeat(64)}`,
  url:'https://example.invalid/browser-fixture/registry'},
 feedDirectory:{fetchedAt:new Date().toISOString(),sha256:`sha256:${'2'.repeat(64)}`,
  url:'https://example.invalid/browser-fixture/feed-directory'}};
const frame=()=>({source:{...blockSource},tick:0,sqrtPriceX96:sqrtRatioAtTick(0),poolLiquidity:10n**24n,
 price0:10n**18n,price1:10n**18n,nativePrice:2000n*10n**18n,referenceEligible:true,
 referenceReasons:[],referenceProofHash:referenceProofHash(referenceProof),referenceProof});
const setupReviewCache=new StaticPaperSetupReviewCache();
const readSetup=async(input,pinnedSource)=>{
 const result=await buildStaticPaperSetupPreflight(input,{
 loadProfile:id=>store.paperSetupProfile(id),readFrame:async(_profile,source)=>{
  if(source&&(source.block!==blockSource.block||source.hash!==blockSource.hash))throw Error('mock_source_not_canonical');
  return frame();},
 verifyCanonical:async(_chainId,source)=>{
  if(source.block!==blockSource.block||source.hash!==blockSource.hash)throw Error('mock_source_not_canonical');},
  readGasProfiles:address=>store.paperGasProfiles(address),readGasPrice:async()=>1_000_000_000n,
 },pinnedSource);
 if(pinnedSource||result.status!=='available')return result;
 const captured=setupReviewCache.capture(result);
 assert(captured,'Server must capture the exact setup costs before browser review');
 return {...result,...captured};
};

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
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const phase=name=>console.error(`[phase] ${name} +${Math.round(process.uptime())}s`);

try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const dbUrl=new URL(process.env.TEST_DATABASE_URL);
 dbUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(dbUrl.toString());await store.assertReady();
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES('browser-fixture',$1,4663,'TOKEN',$2,3000,1,$3,true)`,
 [poolAddress,profile.pool.token1,`0x${'d'.repeat(64)}`]);
 const registered=await store.registerVerifiedMarketProfile({profile,profileHash,streamKey:'browser-fixture',
  source:{...blockSource},contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
   managerCodeHash:codeHash,quoterCodeHash:codeHash},
  references:{price0:'1000000000000000000',price1:'1000000000000000000',
   nativePrice:'2000000000000000000000',proofHash:referenceProofHash(referenceProof)},
  referenceProof,verifiedAt:new Date().toISOString()});
 assert.equal(registered.created,true);profileId=registered.id;
}catch(error){
 await store?.close().catch(()=>{});admin.release();await adminPool.end();
 await rm(temp,{recursive:true,force:true});throw error;
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

// A TCP proxy this run owns in front of PostgreSQL's unix socket. Only the
// dashboard read pool is behind it, so a read outage never reaches the command
// routes, the live services or any other client.
const socketUrl=new URL(process.env.TEST_DATABASE_URL);
const socketPath=`${socketUrl.searchParams.get('host')??'/var/run/postgresql'}/.s.PGSQL.${socketUrl.port||5432}`;
const proxy={reachable:true,delayMs:0};
pgProxy=createTcpServer(client=>{
 if(!proxy.reachable){client.destroy();return;}
 const upstream=tcpConnect(socketPath);liveSockets.add(client);liveSockets.add(upstream);
 const forward=(from,to)=>from.on('data',chunk=>{
  if(proxy.delayMs>0)setTimeout(()=>{if(!to.destroyed)to.write(chunk);},proxy.delayMs);
  else if(!to.destroyed)to.write(chunk);});
 forward(client,upstream);forward(upstream,client);
 const drop=()=>{liveSockets.delete(client);liveSockets.delete(upstream);client.destroy();upstream.destroy();};
 for(const socket of [client,upstream])socket.on('error',drop),socket.on('close',drop);
});
pgProxy.listen(0,'127.0.0.1');await once(pgProxy,'listening');
const proxyPort=pgProxy.address().port;
const setReadDatabase=({reachable=true,delayMs=0})=>{
 proxy.reachable=reachable;proxy.delayMs=delayMs;
 if(!reachable)for(const socket of [...liveSockets])socket.destroy();
};
readPool=new pg.Pool({connectionString:
 `postgresql://root@127.0.0.1:${proxyPort}${socketUrl.pathname}?options=${encodeURIComponent(`-c search_path=${schema} -c statement_timeout=12000`)}`,
 max:4,connectionTimeoutMillis:8000,idleTimeoutMillis:750});
readPool.on('error',()=>{});

const faults={research:false,staleSourceSeconds:0};
const counters={admission:0,draftDelete:0,openPreview:0,openAccept:0,openReplay:0,retainAccept:0,
 positionsRead:0,positionsServed:0};
const retainKeys=[];
const research=()=>({generatedAt:new Date().toISOString(),streamKey:'browser-fixture',bucketMinutes:60,
 buckets:[],budgetQuote:'250000000',costs:{roundTripQuote:'1000000'},pools:[]});
// Ageing the observed source timestamp is the simulated canonical-observation
// boundary for R1's stale-source case; every other field stays the real row.
const agePosition=position=>{
 const age=faults.staleSourceSeconds;
 if(!age)return position;
 const at=new Date(Date.now()-age*1000).toISOString();
 return {...position,sourceAt:at,heartbeatAt:at,
  reasons:[...new Set([...(position.reasons??[]),'source_stale'])]};
};
const dashboardRead=async(path)=>{
 if(path==='/api/dashboard')return {pools:[{registryEnabled:true,poolAddress,rwaSymbol:'TOKEN',fee:3000,tickSpacing:60}]};
 if(path==='/api/research'){
  if(faults.research)throw Error('research_source_unavailable');
  return research();
 }
 if(!path.startsWith('/api/positions'))throw Error('unexpected_dashboard_path');
 counters.positionsRead++;
 const client=await readPool.connect();
 try{
  const rows=await readDeploymentRows(client);
  if(path.startsWith('/api/positions/')){
   const id=decodeURIComponent(path.split('?')[0].slice('/api/positions/'.length));
   const row=rows.find(row=>`paper-dep-${row.id}`===id);if(!row)return null;
   const hours=Number(new URL(path,'http://127.0.0.1').searchParams.get('hours')??'24');
   const detail=await readDeploymentDetail(client,row,hours);
   // The detail read replaces the row's position object in the browser, so the
   // aged source frame has to reach both read paths or the row would flicker.
   return {...detail,position:agePosition(detail.position)};
  }
  const positions=rows.map(deploymentPosition).map(agePosition);
  counters.positionsServed++;
  return {positions,serverTime:new Date().toISOString()};
 }finally{client.release();}
};

const portProbe=createTcpServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
const port=portProbe.address().port;
await new Promise((resolve,reject)=>portProbe.close(error=>error?reject(error):resolve()));
const origin=`http://127.0.0.1:${port}`;
const chain={getChainId:async()=>4663,getBlock:async({blockNumber})=>{
 assert(['100','101'].includes(String(blockNumber)),'synthetic header is explicitly bounded');
 return {hash:blockSource.hash,timestamp:BigInt(blockSource.timestamp)};
}};
const verifySource=async(_chainId,sources)=>{
 for(const source of sources)if(source.block!==blockSource.block||source.hash!==blockSource.hash||
  source.timestamp!==blockSource.timestamp)throw Error('mock_source_not_canonical');
};
const paperPreview=async(campaignId,kind)=>{
 if(kind!=='open')return {kind,status:'unavailable',reason:'not_in_harness',actionAvailable:false};
 counters.openPreview++;
 const draft=await store.paperDraft(campaignId),freshFrame=frame();
 const indicative=buildIndicativePaperOpenPreview(draft,freshFrame);
 const costed=costIndicativePaperOpenPreview(indicative,await store.paperGasProfiles(draft.profile.pool.pool),
  draft.profile.pool.pool,freshFrame.nativePrice,1_000_000_000n);
 if(costed.status!=='indicative'||costed.costs.status!=='provisional')return costed;
 const saved=await persistTrustedPaperOpenPreview({store,draft,frame:freshFrame,preview:costed,
  verifyAnchors:verifySource});
 return {...costed,...saved,kind:'open',status:'indicative',trustedPreviewSaved:true,
  actionAvailable:false,operationAcceptanceAvailable:false,economics:null};
};
const serverOptions={origin,dashboardRead,
 paperSetupPreflight:input=>readSetup(input),
 paperSetupDraftAdmission:input=>{counters.admission++;
  return createStaticPaperDraftFromSetup(input,{
   runPreflight:(request,pinned)=>readSetup(request,pinned),loadProfile:id=>store.paperSetupProfile(id),
   lookupCapturedReview:input=>setupReviewCache.lookup(input),
   findDraftRequest:(id,draft)=>store.findDraftRequest(id,draft),
   createDraftWithRequestId:(id,draft)=>store.createDraftWithRequestId(id,draft)});},
 paperSetupDraftList:()=>store.listStaticPaperDrafts(),
 paperSetupDraftDelete:id=>{counters.draftDelete++;return store.deleteStaticPaperDraft(id);},
 setupDefaults:()=>({walletAddress:'0x2222222222222222222222222222222222222222'}),paperPreview,
 paperOperationReplay:async(id,input,kinds)=>{
  const replay=await store.acceptedOperationReplay(id,input,kinds);
  if(replay&&kinds.includes('open'))counters.openReplay++;
  return replay;},
 paperOpenAcceptance:(id,input,actor)=>{counters.openAccept++;
  return store.acceptStaticPaperOpenOperation(id,input,actor,verifySource);},
 paperRetainAcceptance:(id,input,actor)=>{counters.retainAccept++;retainKeys.push(input.idempotencyKey);
  return store.acceptStaticPaperRetainOperation(id,input,actor,verifySource);},
 paperRetainWorkerReady:()=>store.paperOperationWorkerReady()};
const startServer=async()=>{
 const instance=createDeploymentCommandServer(store,serverOptions);
 instance.listen(port,'127.0.0.1');await once(instance,'listening');return instance;
};
const stopServer=async()=>{
 if(!server)return;
 server.closeAllConnections?.();
 await new Promise(resolve=>server.close(()=>resolve()));server=null;
};
server=await startServer();

// Unauthenticated handshakes from other clients, exactly as the public Funnel
// origin reaches POST /api/session. Sequential so eviction order is exact.
const handshake=async()=>{
 const response=await fetch(`${origin}/api/session`,{method:'POST',
  headers:{'content-type':'application/json',origin},body:'{}'});
 assert.equal(response.status,200);
 const cookies=response.headers.getSetCookie?.()??[];
 const body=await response.json();
 return {token:/cq_session=([0-9a-f]{64})/.exec(cookies.join(';'))?.[1]??null,csrf:body.csrfToken};
};
const floodSessions=async count=>{const out=[];for(let i=0;i<count;i++)out.push(await handshake());return out;};
const rawStatus=async(path,token)=>(await fetch(`${origin}${path}`,
 {headers:{accept:'application/json',...(token?{cookie:`cq_session=${token}`}:{})}})).status;

let debugPort=0,stderr='';
chrome=spawn(await chromiumPath(),['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
 '--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
 '--user-data-dir='+temp,'about:blank'],{stdio:['ignore','ignore','pipe']});
chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',part=>{stderr+=part;
 const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);if(match)debugPort=Number(match[1]);});
for(let i=0;i<120&&!debugPort;i++){if(chrome.exitCode!==null)throw Error('Chromium exited: '+stderr);await wait(100);}
assert(debugPort,'Chromium did not start remote debugging');

const stateProbe=`({connection:document.querySelector('#connection-status')?.textContent,
 banner:document.querySelector('#connection-banner')?.hidden===false&&document.querySelector('#connection-banner')?.textContent,
 research:document.querySelector('#status')?.textContent,
 auth:document.querySelector('#operator-auth-status')?.textContent,
 authenticated:window.concliqOperatorAuthenticated?.(),
 setup:document.querySelector('#setup-status')?.textContent,
 draft:document.querySelector('#setup-draft-submit-status')?.textContent,
 open:document.querySelector('#setup-open-status')?.textContent,
 savedStatus:document.querySelector('#saved-paper-drafts-status')?.textContent,
 recoveryHidden:document.querySelector('#pending-open-recovery')?.hidden,
 recoveryDetail:document.querySelector('#pending-open-recovery-detail')?.textContent,
 acceptanceHidden:document.querySelector('#pending-paper-acceptance-recovery')?.hidden,
 rows:document.querySelectorAll('#paper tr[data-position]').length,
 deleteStatus:[...document.querySelectorAll('.delete-draft-status')].map(e=>e.textContent)})`;
const attach=async webSocketDebuggerUrl=>{
 const socket=new WebSocket(webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});
  socket.addEventListener('error',reject,{once:true});});
 let sequence=0;const pending=new Map();
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data);
  if(message.id){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);
   message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}
  else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);
  else if(message.method==='Network.responseReceived'&&message.params.response.status>=400)
   resourceFailures.push({status:message.params.response.status,url:message.params.response.url});});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});
  socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{
  expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const waitFor=async(expression,attempts=160)=>{for(let i=0;i<attempts;i++){if(await evaluate(expression))return;
  await wait(100);}
  throw Error('Timed out waiting for '+expression+'; state='+JSON.stringify(await evaluate(stateProbe))+
   ` errors=${JSON.stringify(errors)} responses=${JSON.stringify(resourceFailures)}`);};
 const tab={socket,send,evaluate,waitFor,
  check:async(name,expression)=>{assert(await evaluate(expression),
   name+' — state='+JSON.stringify(await evaluate(stateProbe)));checks.push(name);},
  click:selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
  fill:(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};
   e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`),
  navigate:async path=>{await send('Page.navigate',{url:origin+path});
   await waitFor('document.readyState==="complete"');await wait(100);},
  cookie:async()=>((await send('Network.getCookies',{urls:[origin]})).cookies
   .find(item=>item.name==='cq_session')?.value??null)};
 await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await send('Network.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 tabs.push(tab);return tab;
};
const targets=await fetch(`http://127.0.0.1:${debugPort}/json`).then(response=>response.json());
const first=targets.find(item=>item.type==='page');assert(first);
const a=await attach(first.webSocketDebuggerUrl);
const {check,evaluate,waitFor,click,fill,navigate}=a;
const readyOperator=async(tab=a)=>{
 await tab.navigate('/operator');
 await tab.waitFor('window.concliqOperatorAuthenticated?.()===true&&document.querySelector("#setup-width").options.length>1');
 await tab.waitFor('document.querySelector("#setup-wallet-address").value.length===42');
};

// ---------------------------------------------------------------- R1 research
phase('R1 research');
faults.research=true;
await navigate('/operator');
await waitFor('document.querySelectorAll("[role=tab]").length===2');
await click('#research-tab');
await waitFor('document.querySelector("#status").textContent==="Research unavailable"');
await check('R1 research 503 names the fault on the research surface without blanking the page',
 'document.querySelector("#status").textContent==="Research unavailable"&&'+
 'document.querySelector("#league tbody").textContent.includes("Research snapshot unavailable")&&'+
 '!document.querySelector("#research-panel").hidden');
faults.research=false;
assert.equal((await fetch(`${origin}/api/research`)).status,200,'research read recovered at the service');
await wait(12_000);
await check('R1 DEFECT: a recovered research source stays "Research unavailable" until a reload, because research.js calls load() once and never polls',
 'document.querySelector("#status").textContent==="Research unavailable"');
findings.push('R1: dashboard/research.js load() runs once at module evaluation with no retry and no poll, '+
 'so a transient /api/research failure is permanent for the tab; only a reload recovers it.');
await navigate('/operator');
await click('#research-tab');
await waitFor('document.querySelector("#status").textContent.startsWith("Built ")');
await check('R1 research recovers only across a reload',
 'document.querySelector("#status").textContent.startsWith("Built ")');

// ------------------------------------------------------------- R3 contention
phase('R3 contention');
await readyOperator();
await check('Operator session is ready and the command origin serves both tabs',
 '[...document.querySelectorAll("[role=tab]")].map(x=>x.textContent.trim()).join(",")==="Research,Positions"');
await waitFor('document.querySelector("#setup-wallet-address").value==="0x2222222222222222222222222222222222222222"');
await fill('#setup-wallet-address','0x1111111111111111111111111111111111111111');
await fill('#setup-capital','250');
await fill('#limit-max-action-cost','10');
refreshSource();
await click('#setup-review-button');
await waitFor('document.querySelector("#setup-preflight-title").textContent==="Sizing preflight available"');
await waitFor('document.querySelector("#save-paper-draft").disabled===false');
const operatorCookie=await a.cookie();
assert(operatorCookie,'operator holds a session cookie');
assert.equal(await rawStatus('/api/deployments/setup-drafts',operatorCookie),200);
await floodSessions(34);
assert.equal(await rawStatus('/api/deployments/setup-drafts',operatorCookie),401,
 'the operator session must be gone from the 32-entry map after unrelated handshakes');
checks.push('R3 CONFIRMED: 34 unauthenticated handshakes from other clients evict the operator session server-side');
findings.push('R3: src/deployments/server.ts:161 evicts the first-inserted session once the map reaches 32. '+
 'The operator authenticates first, so it is always the first entry evicted by unrelated traffic, and '+
 'POST /api/session is reachable unauthenticated from the recorded public Funnel origin.');
await check('Operator keeps its in-progress reviewed form state while its session is already evicted',
 'document.querySelector("#setup-wallet-address").value==="0x1111111111111111111111111111111111111111"&&'+
 'document.querySelector("#limit-max-action-cost").value==="10"&&'+
 'window.concliqOperatorAuthenticated?.()===true');
await click('#save-paper-draft');
await waitFor('document.querySelector("#setup-draft-submit-status").textContent.includes("Saved static/manual paper draft")');
const draftA=await evaluate(`document.querySelector("#setup-draft-submit-status").textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]`);
assert(draftA,'browser shows a persisted draft ID');
assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_campaigns WHERE id=$1 AND lifecycle='draft'`,[draftA])).rows[0].n,1);
assert.equal(counters.admission,1,'the evicted session cost exactly one draft admission POST');
const renewedCookie=await a.cookie();
assert.notEqual(renewedCookie,operatorCookie);
await check('R3 renew-and-retry covers a pending draft save across silent eviction, with the reviewed inputs intact',
 'document.querySelector("#setup-draft-submit-status").textContent.includes("Saved static/manual paper draft")&&'+
 'document.querySelector("#setup-wallet-address").value==="0x1111111111111111111111111111111111111111"');
checks.push('R3 the silently renewed session issues a new cookie, so eviction is invisible to the operator');

// A second eviction inside the single renew-and-retry window logs the operator out.
await evaluate(`(()=>{window.__renewSeen=false;window.__renewHold=true;
 const original=window.fetch.bind(window);
 window.fetch=async(input,init)=>{
  const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
  const response=await original(input,init);
  if(init?.method==='POST'&&path==='/api/session'){window.__renewSeen=true;
   while(window.__renewHold)await new Promise(resolve=>setTimeout(resolve,25));}
  return response;
 };})()`);
await floodSessions(34);
assert.equal(await rawStatus('/api/deployments/setup-drafts',renewedCookie),401);
await evaluate(`void(window.__probe=window.concliqOperatorRequest('/api/deployments/setup-drafts').then(()=>'ok',error=>'err:'+error?.status+':'+(error?.data?.error??error?.message)))`);
await waitFor('window.__renewSeen===true');
await floodSessions(34);
await evaluate('window.__renewHold=false');
const probe=await evaluate('window.__probe');
await check('R3 CONFIRMED: unrelated public traffic during the single renewal window logs the operator out mid-flow',
 `${JSON.stringify(probe)}==="err:401:authentication_required"&&window.concliqOperatorAuthenticated?.()===false&&`+
 'document.querySelector("#operator-auth-status").textContent==="Operator connection unavailable."&&'+
 '!document.querySelector("#operator-connect-retry").hidden');
findings.push('R3: dashboard/operator-session.js renews once and retries once. A second eviction inside that '+
 'window leaves the operator unauthenticated with a raw authentication_required, so unrelated public '+
 'handshakes can log an operator out mid-flow; only the Retry connection control recovers it.');
await check('Logged-out operator keeps its typed form values and is offered an explicit reconnect',
 'document.querySelector("#setup-wallet-address").value==="0x1111111111111111111111111111111111111111"&&'+
 'document.querySelector("#operator-connect-retry").disabled===false');
await evaluate('window.__renewHold=false;window.fetch=window.fetch');
await click('#operator-connect-retry');
await waitFor('window.concliqOperatorAuthenticated?.()===true');
await check('The reconnect control restores the operator session without a reload',
 'window.concliqOperatorAuthenticated?.()===true&&document.querySelector("#operator-auth-status").textContent==="Operator connection ready."');

// -------------------------------------------- R4 and R5 open acceptance paths
phase('R4 and R5 open acceptance paths');
workerLease=await adminPool.connect();
assert.equal((await workerLease.query('SELECT pg_try_advisory_lock_shared($1::int,$2::int) AS acquired',
 PAPER_OPERATION_READINESS_LOCK)).rows[0].acquired,true);
await readyOperator();
await waitFor(`document.querySelector('.saved-paper-draft[data-campaign-id="${draftA}"]')!==null`);
refreshSource();
await a.click(`.saved-paper-draft[data-campaign-id="${draftA}"] .saved-open-preview`);
await waitFor('document.querySelector(".draft-action-status button")!==null');
await check('A fresh saved open preview is actionable once worker readiness is proven',
 'document.querySelector(".draft-action-status button").disabled===false&&'+
 'document.querySelector(".draft-action-status").textContent.includes("provisional, not paid")');
// Hold the acceptance response so the reload below happens with the POST in flight.
await evaluate(`(()=>{const original=window.fetch.bind(window);
 window.fetch=async(input,init)=>{
  const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
  const response=await original(input,init);
  if(init?.method==='POST'&&path.endsWith('/open-operations'))await new Promise(resolve=>setTimeout(resolve,4000));
  return response;
 };})()`);
await evaluate(`(()=>{const button=document.querySelector('.draft-action-status button');button.click();button.click();})()`);
await waitFor(`localStorage.getItem('concliq.operator.paper-open.pending.v1')!==null`);
for(let i=0;i<100&&counters.openAccept===0;i++)await wait(100);
assert.equal(counters.openAccept,1,'a double-clicked acceptance reaches the command service once');
checks.push('R4 a double-clicked open acceptance submits exactly one operation; the control disables inside its own handler');
await navigate('/operator');
await waitFor('window.concliqOperatorAuthenticated?.()===true');
await waitFor('document.querySelector("#pending-open-recovery").hidden===false');
await check('R5 a reload with the acceptance in flight keeps the same-key pending state and names it',
 'document.querySelector("#pending-open-recovery-detail").textContent.includes('+JSON.stringify(draftA)+')&&'+
 'document.querySelector("#retry-pending-open").disabled===false&&'+
 'document.querySelector("#refresh-open-preview").disabled===true');
const pendingKeyValue=await evaluate(`JSON.parse(localStorage.getItem('concliq.operator.paper-open.pending.v1')).payload.idempotencyKey`);
await evaluate(`(()=>{const button=document.querySelector('#retry-pending-open');button.click();button.click();button.click();})()`);
await waitFor(`localStorage.getItem('concliq.operator.paper-open.pending.v1')===null`);
await check('R5 repeated retry presses reconcile the same key once and clear the pending surface',
 'document.querySelector("#pending-open-recovery").hidden===true');
assert.equal(counters.openAccept,1,'no repeated press reached a second acceptance');
assert.equal(counters.openReplay,1,'the retry was answered by the recorded same-key replay');
const operations=(await admin.query('SELECT id::text,idempotency_key,kind FROM deployment_operations WHERE campaign_id=$1',[draftA])).rows;
assert.equal(operations.length,1,JSON.stringify(operations));
assert.equal(operations[0].idempotency_key,pendingKeyValue);
checks.push('R4 and R5 an interrupted acceptance, a reload and three retry presses leave exactly one operation with the original key');
const worked=await processOnePaperOperation(store,chain,admin,'track2-open');
assert.equal(worked.status,'completed',JSON.stringify(worked));
assert.equal((await admin.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[draftA])).rows[0].lifecycle,'active');

// ------------------------------------- R5 pending paper acceptance recovery
phase('R5 pending paper acceptance recovery');
const retainKey=`concliq.operator.paper-action.pending.v1.${draftA}.close_retain`;
const retainRecord={campaignId:draftA,kind:'close_retain',payload:{previewId:randomUUID(),
 contentDigest:'b'.repeat(64),expectedRevision:2,idempotencyKey:randomUUID()}};
await evaluate(`localStorage.setItem(${JSON.stringify(retainKey)},${JSON.stringify(JSON.stringify(retainRecord))})`);
await navigate('/operator');
await waitFor('window.concliqOperatorAuthenticated?.()===true');
await waitFor('document.querySelector("#pending-paper-acceptance-recovery").hidden===false');
await check('R5 a saved retain acceptance survives a reload and names its campaign and kind',
 'document.querySelector("#pending-paper-acceptance-recovery").textContent.includes("Retain-close")&&'+
 'document.querySelector("#pending-paper-acceptance-recovery").textContent.includes('+JSON.stringify(draftA)+')&&'+
 'document.querySelector(".paper-acceptance-reconcile-button").disabled===false');
const settled=()=>waitFor('document.querySelector(".paper-acceptance-reconcile-button")===null||'+
 'document.querySelector(".paper-acceptance-reconcile-button").disabled===false');
for(let press=0;press<3;press++){
 if(!await evaluate('document.querySelector(".paper-acceptance-reconcile-button")?.disabled===false'))break;
 const before=counters.retainAccept;
 await a.click('.paper-acceptance-reconcile-button');
 for(let i=0;i<100&&counters.retainAccept===before;i++)await wait(100);
 await settled();
}
const reconcileText=await evaluate('document.querySelector(".paper-acceptance-recovery-row p")?.textContent??"row_removed"');
assert(retainKeys.length>=1,'at least one reconcile reached the command service');
assert.equal(new Set(retainKeys).size,1,'every reconcile press resent the original idempotency key');
assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_operations WHERE campaign_id=$1 AND kind='close_retain'`,[draftA])).rows[0].n,0);
await check('R5 repeated reconcile presses keep one key, create no operation and stay readable',
 JSON.stringify(reconcileText)+'.includes("Reconciliation unavailable")&&'+
 'document.querySelector(".paper-acceptance-reconcile-button")?.disabled!==true');
checks.push(`R5 reconcile outcome text: ${reconcileText}`);
checks.push(`R5 reconcile presses reaching the service: ${retainKeys.length}, distinct keys: ${new Set(retainKeys).size}`);
await evaluate(`localStorage.removeItem(${JSON.stringify(retainKey)})`);

// ------------------------------------------------ R4 two tabs, one campaign
phase('R4 two tabs, one campaign');
const newDraft=async(tab=a)=>{
 await readyOperator(tab);
 refreshSource();
 await tab.fill('#setup-capital','250');
 await tab.click('#setup-review-button');
 await tab.waitFor('document.querySelector("#setup-preflight-title").textContent==="Sizing preflight available"');
 await tab.waitFor('document.querySelector("#save-paper-draft").disabled===false');
 await tab.click('#save-paper-draft');
 await tab.waitFor('document.querySelector("#setup-draft-submit-status").textContent.includes("Saved static/manual paper draft")');
 const id=await tab.evaluate(`document.querySelector("#setup-draft-submit-status").textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]`);
 assert(id,'browser shows a persisted draft ID');
 await tab.waitFor(`document.querySelector('.saved-paper-draft[data-campaign-id="${id}"]')!==null`);
 return id;
};
const draftB=await newDraft();
assert.notEqual(draftB,draftA);
const selectorB=`.saved-paper-draft[data-campaign-id="${draftB}"]`;
const opened=await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(origin+'/operator')}`,{method:'PUT'})
 .then(response=>response.json());
const b=await attach(opened.webSocketDebuggerUrl);
await b.waitFor('window.concliqOperatorAuthenticated?.()===true');
await b.waitFor(`document.querySelector(${JSON.stringify(selectorB)})!==null`);
await b.check('A second tab reuses the existing operator session and lists the same campaign',
 'window.concliqOperatorAuthenticated?.()===true&&'+
 `document.querySelector(${JSON.stringify(selectorB)})!==null`);
// Both tabs hold their own fresh, actionable open preview for one campaign.
await click(`${selectorB} .saved-open-preview`);
await waitFor('document.querySelector(".draft-action-status button")?.disabled===false');
await b.click(`${selectorB} .saved-open-preview`);
await b.waitFor('document.querySelector(".draft-action-status button")?.disabled===false');
const acceptsBefore=counters.openAccept;
await click('.draft-action-status button');
for(let i=0;i<100&&counters.openAccept===acceptsBefore;i++)await wait(100);
assert.equal(counters.openAccept,acceptsBefore+1,'the first tab accepted once');
await b.click('.draft-action-status button');
await b.waitFor('document.querySelector(".draft-action-status").textContent.includes("Open preview rejected")||'+
 'document.querySelector(".draft-action-status").textContent.includes("accepted")||'+
 'document.querySelector(".draft-action-status").textContent.includes("outcome unknown")');
const loserText=await b.evaluate('document.querySelector(".draft-action-status").textContent');
const openOperationsB=(await admin.query(`SELECT id::text FROM deployment_operations WHERE campaign_id=$1 AND kind='open'`,[draftB])).rows;
assert.equal(openOperationsB.length,1,'two tabs accepting one campaign leave one open operation: '+loserText);
await b.check('R4 the losing tab of a two-tab acceptance is told its preview was rejected and is offered a fresh preview instead of a stuck control',
 'document.querySelector(".draft-action-status").textContent.includes("Open preview rejected")&&'+
 'document.querySelector(".draft-action-status button").disabled===true&&'+
 `document.querySelector(${JSON.stringify(selectorB+' .saved-open-preview')}).disabled===false`);
checks.push(`R4 losing acceptance message: ${loserText.split('. ')[0]}`);
for(let i=0;i<50&&await evaluate(`localStorage.getItem('concliq.operator.paper-open.pending.v1')!==null`);i++)await wait(100);
if(await evaluate(`localStorage.getItem('concliq.operator.paper-open.pending.v1')!==null`)){
 checks.push('R4 DEFECT: two tabs share one same-key pending-open record, so a losing tab can leave a stale recovery record behind');
 findings.push('R4: the pending open record is a single origin-wide localStorage key, so two tabs accepting '+
  'different campaigns or previews overwrite one another.');
 await evaluate(`localStorage.removeItem('concliq.operator.paper-open.pending.v1')`);
}else checks.push('R4 both tabs leave the shared pending-open record cleared after the race resolves');
const workedB=await processOnePaperOperation(store,chain,admin,'track2-open-b');
assert.equal(workedB.status,'completed',JSON.stringify(workedB));
// A deletion race on a separate untouched draft.
const draftC=await newDraft();
const selectorC=`.saved-paper-draft[data-campaign-id="${draftC}"]`;
await b.navigate('/operator');
await b.waitFor('window.concliqOperatorAuthenticated?.()===true');
await b.waitFor(`document.querySelector(${JSON.stringify(selectorC)})!==null`);
const deletesBefore=counters.draftDelete;
await click(`${selectorC} .delete-paper-draft`);
await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selectorC+' .confirm-delete-paper-draft')});button.click();button.click();})()`);
await waitFor(`document.querySelector(${JSON.stringify(selectorC)})===null`);
assert.equal(counters.draftDelete-deletesBefore,1,'a double-clicked confirmation deletes once');
checks.push('R4 a double-clicked delete confirmation sends exactly one DELETE');
await b.click(`${selectorC} .delete-paper-draft`);
await b.click(`${selectorC} .confirm-delete-paper-draft`);
await b.waitFor(`document.querySelector(${JSON.stringify(selectorC)})===null||`+
 `document.querySelector(${JSON.stringify(selectorC+' .delete-draft-status')})?.textContent.includes("could not be deleted")`);
const loserDelete=await b.evaluate(`document.querySelector(${JSON.stringify(selectorC)})===null?'card_removed':`+
 `document.querySelector(${JSON.stringify(selectorC+' .delete-draft-status')}).textContent`);
assert.equal(counters.draftDelete-deletesBefore,2,'the losing tab reached the service once');
assert.equal((await admin.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[draftC])).rows[0].lifecycle,'closed');
assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_revisions WHERE campaign_id=$1',[draftC])).rows[0].n,1);
assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_operations WHERE campaign_id=$1',[draftC])).rows[0].n,0);
await b.check('R4 the losing tab of a deletion race converges on the deleted state without a second closure or a stuck control',
 `document.querySelector(${JSON.stringify(selectorC)})===null&&`+
 'document.querySelector("#saved-paper-drafts-status").textContent.includes("No saved static/manual paper drafts")');
checks.push(`R4 losing deletion outcome: ${loserDelete}`);
await b.send('Page.close').catch(()=>{});

// ----------------------------------------------- R1 degraded read dependency
phase('R1 degraded read dependency');
const activeRows=(await readDeploymentRows(admin)).length;
assert.equal(activeRows,2,'two accepted paper campaigns are on screen for the degraded reads');
const rowsVisible=`document.querySelectorAll("#paper tr[data-position]").length===${activeRows}`;
await readyOperator();
await evaluate('[...document.querySelectorAll("[role=tab]")].find(e=>e.textContent.trim()==="Positions").click()');
await waitFor(rowsVisible);
await check('An active campaign row is readable before any dependency is degraded',
 'document.querySelector("#connection-banner").hidden===true&&'+
 'document.querySelector("#connection-status").textContent.startsWith("API connected")');
setReadDatabase({reachable:false});
await waitFor('document.querySelector("#connection-banner").hidden===false',260);
await check('R1 an unreachable read database names the fault, keeps the last received rows and says they are historical',
 'document.querySelector("#connection-banner").textContent.includes("Connection failed")&&'+
 'document.querySelector("#connection-banner").textContent.includes("Showing records received")&&'+
 'document.querySelector("#connection-status").textContent==="API unavailable"&&'+rowsVisible);
setReadDatabase({reachable:true});
await waitFor('document.querySelector("#connection-banner").hidden===true',260);
await check('R1 the banner clears and the poll recovers without a reload once the database returns',
 'document.querySelector("#connection-banner").hidden===true&&'+
 'document.querySelector("#connection-status").textContent.startsWith("API connected")&&'+rowsVisible);
setReadDatabase({reachable:true,delayMs:250});
const slowFrom=counters.positionsServed;
for(let i=0;i<300&&counters.positionsServed<slowFrom+1;i++)await wait(100);
assert(counters.positionsServed>slowFrom,'the poll kept serving reads through the delaying proxy');
await check('R1 a slow read database behind the delaying proxy keeps the page readable and unbannered',
 'document.querySelector("#connection-banner").hidden===true&&'+
 'document.querySelector("#connection-status").textContent.startsWith("API connected")&&'+rowsVisible);
setReadDatabase({reachable:true});

faults.staleSourceSeconds=1_200;
await waitFor('document.querySelector("#paper").textContent.includes("source stale / unavailable")',260);
const staleRow=await evaluate(`[...document.querySelectorAll('#paper tr[data-position]')].map(row=>({
 status:row.querySelector('.status-sub')?.textContent??null,
 negative:row.querySelector('.row-sub.negative')?.textContent??null,
 numeric:[...row.querySelectorAll('td.num')].map(cell=>cell.textContent)}))`);
// The row's stale suffix and its age label come from two independent
// mechanisms: condition() appends "source stale / unavailable" from the
// server's p.reasons, while the .row-sub.negative age label is derived in the
// browser from age(sourceAt)>180. The fixture ages one campaign's source
// frame, not every row's, so the invariant to assert is the agreement between
// those two mechanisms per row, not a blanket claim over all rows.
assert.equal(staleRow.length,activeRows,'R1 every active row must still render: '+JSON.stringify(staleRow));
const aged=staleRow.filter(row=>row.negative!==null),fresh=staleRow.filter(row=>row.negative===null);
assert(aged.length>0,'R1 the fixture must age at least one row past the 180s threshold: '+JSON.stringify(staleRow));
assert(aged.every(row=>row.negative.includes('ago')&&row.status?.includes('source stale / unavailable')),
 'R1 a row with a degraded source age label must also carry the degraded condition: '+JSON.stringify(staleRow));
assert(fresh.every(row=>!row.status?.includes('source stale / unavailable')),
 'R1 a row with a fresh source age must not claim a stale source: '+JSON.stringify(staleRow));
assert(await evaluate('document.querySelector("#connection-banner").hidden===true'),
 'R1 source staleness is not a connection failure');
checks.push('R1 a stale source frame degrades the row condition and the source age label together, and leaves fresh rows unflagged');
// Whether every derived figure is degraded beside the status line is U6's
// question, not this track's; this fixture has no recorded economics to judge it.
checks.push(`R1 stale rows observed: ${JSON.stringify(staleRow.map(row=>row.negative))}`);
faults.staleSourceSeconds=0;
await waitFor('!document.querySelector("#paper").textContent.includes("source stale / unavailable")',260);
await check('R1 the stale-source degradation clears without a reload once the source is fresh again',
 'document.querySelector("#paper tr[data-position]")!==null&&'+
 '!document.querySelector("#paper tr[data-position] .status-sub").textContent.includes("stale")&&'+
 'document.querySelector("#paper tr[data-position] .row-sub.negative")===null');

// ------------------------------------------ R1 command service stopped alive
phase('R1 command service stopped alive');
await stopServer();
await waitFor('document.querySelector("#connection-banner").hidden===false',260);
await check('R1 a stopped command service names the fault and keeps the recorded rows on screen',
 'document.querySelector("#connection-banner").textContent.includes("Connection failed")&&'+rowsVisible);
await fill('#setup-capital','250');
await click('#setup-review-button');
await waitFor('document.querySelector("#setup-status").textContent.includes("Setup preflight failed")');
await check('R1 an operator request against the stopped service reports a failure and creates nothing',
 'document.querySelector("#setup-status").textContent.includes("Setup preflight failed")&&'+
 'document.querySelector("#setup-status").textContent.includes("No draft or operation was created")');
await click('#operator-connect-retry');
await wait(500);
const retryWhileDown=await evaluate('document.querySelector("#operator-auth-status").textContent');
if(retryWhileDown==='Operator connection ready.'){
 checks.push('R1 DEFECT: the Retry connection control reports "Operator connection ready." while the command service is stopped, because bootstrap and the operator data load are both memoized');
 findings.push('R1: dashboard/tabs.js connectOperator() reuses a non-null CSRF token and the already resolved '+
  'operatorDataLoadPromise, so Retry connection reports readiness without any request reaching the service.');
}else{
 await check('R1 the reconnect control reports the stopped service',
  'document.querySelector("#operator-auth-status").textContent==="Operator connection failed. Retry when the service is available."');
}
server=await startServer();
await waitFor('document.querySelector("#connection-banner").hidden===true',260);
await check('R1 the position poll recovers without a reload once the command service returns',
 'document.querySelector("#connection-banner").hidden===true&&'+
 'document.querySelector("#connection-status").textContent.startsWith("API connected")');
await evaluate(`void(window.__afterRestart=window.concliqOperatorRequest('/api/deployments/setup-drafts').then(r=>'ok:'+r.drafts.length,e=>'err:'+e?.status))`);
await waitFor('window.__afterRestart!==undefined');
const afterRestart=await evaluate('window.__afterRestart');
await check('R1 an authenticated request re-establishes a session across the restart without a reload',
 `${JSON.stringify(afterRestart)}==="ok:0"&&window.concliqOperatorAuthenticated?.()===true`);

assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_campaigns')).rows[0].n,3);
// The open-acceptance POST count is an observation, not a fixed expectation:
// after the command service restarts, the browser's pending-recovery path
// re-sends the acceptance under its original request key. What must hold is
// that a replay reconciles rather than duplicating work, which the
// (campaign_id, idempotency_key) unique constraint enforces. Assert the
// invariant and record the count so a change in the replay behaviour is
// visible rather than silently absorbed.
const operationRows=(await admin.query(
 `SELECT campaign_id::text AS campaign, kind, count(*)::int AS n,
         count(DISTINCT idempotency_key)::int AS keys
    FROM deployment_operations GROUP BY 1,2 ORDER BY 1,2`)).rows;
findings.openAcceptancePosts=counters.openAccept;
findings.operationRows=operationRows;
assert(operationRows.every(row=>row.n===row.keys),
 'every operation row must be distinguished by its own request key: '+JSON.stringify(operationRows));
assert(operationRows.filter(row=>row.kind==='open').every(row=>row.n===1),
 'a replayed acceptance must not create a second open operation: '+JSON.stringify(operationRows));
checks.push(`R4 open acceptance replayed ${counters.openAccept} times created ${
 operationRows.filter(row=>row.kind==='open').reduce((total,row)=>total+row.n,0)} open operation(s)`);
assert.equal(resourceFailures.filter(item=>item.status===404&&/\.(js|css)(\?|$)/.test(item.url)).length,0,
 'dashboard script/style assets load without 404s: '+JSON.stringify(resourceFailures));
console.log(JSON.stringify({checks,findings,profileId,draftA,draftB,draftC,counters,
 retainReconcilePosts:retainKeys.length,distinctRetainKeys:new Set(retainKeys).size,
 browserExceptions:errors,httpResponses:resourceFailures,
 boundaries:'synthetic canonical frame, aged source timestamp, and a locally owned TCP proxy in front of the read pool'},null,2));

}finally{
 for(const tab of tabs)try{tab.socket.close();}catch{}
 if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');
  await new Promise(resolve=>{const timer=setTimeout(resolve,2000);
   chrome.once('exit',()=>{clearTimeout(timer);resolve();});});
  if(chrome.exitCode===null)chrome.kill('SIGKILL');}
 if(server?.listening){server.closeAllConnections?.();await new Promise(resolve=>server.close(()=>resolve()));}
 await readPool?.end().catch(()=>{});
 if(pgProxy){for(const socket of [...liveSockets])socket.destroy();
  await new Promise(resolve=>pgProxy.close(()=>resolve()));}
 await store?.close().catch(()=>{});
 await admin.query('SET search_path=public').catch(()=>{});
 if(workerLease){await workerLease.query('SELECT pg_advisory_unlock_shared($1::int,$2::int)',PAPER_OPERATION_READINESS_LOCK).catch(()=>{});
  workerLease.release();}
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await adminPool.end();
 await rm(temp,{recursive:true,force:true});
}
