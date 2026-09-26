// Process-level exercise for the authenticated command server and supervised
// paper worker. Pause/resume need no chain reads; other action paths remain
// covered by deployment integration fixtures with injected canonical clients.
// Run with TEST_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql'
//   node --import tsx test/integration/paper-command-worker-process.mjs
// Opt-in sealed mode additionally requires TEST_SEALED_RELEASE_DIR and
// --sealed-release; both application processes use that verified release.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createTcpServer} from 'node:net';
import {access,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore,PAPER_OPERATION_READINESS_LOCK} from '../../src/deployments/store.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER,USDG} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {verifyRelease} from '../../scripts/release-files.mjs';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const testDatabaseUrl=new URL(process.env.TEST_DATABASE_URL),databaseSocket=testDatabaseUrl.searchParams.get('host');
const databaseHost=testDatabaseUrl.hostname.toLowerCase();
if(!['localhost','127.0.0.1','[::1]','::1'].includes(databaseHost)&&
 !(databaseSocket&&databaseSocket.startsWith('/')))
 throw Error('TEST_DATABASE_URL must point to a local database or Unix socket');
const sealedReleaseMode=process.argv.includes('--sealed-release');
if(sealedReleaseMode&&!process.env.TEST_SEALED_RELEASE_DIR)
 throw Error('TEST_SEALED_RELEASE_DIR is required with --sealed-release');
if(!sealedReleaseMode&&process.env.TEST_SEALED_RELEASE_DIR)
 throw Error('Use --sealed-release to opt into TEST_SEALED_RELEASE_DIR');
const releaseRoot=sealedReleaseMode?resolve(process.env.TEST_SEALED_RELEASE_DIR):null;
const releaseManifest=releaseRoot?verifyRelease(releaseRoot):null;
if(releaseManifest&&process.env.TEST_EXPECTED_RELEASE_COMMIT&&
 releaseManifest.sourceCommit!==process.env.TEST_EXPECTED_RELEASE_COMMIT)
 throw Error(`Sealed release source commit mismatch: ${releaseManifest.sourceCommit}`);
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4}),admin=await adminPool.connect();
const schema=`paper_process_${randomUUID().replaceAll('-','')}`;
let store,command,worker,rpc,chrome,ws,chromeProfile,runtimeTemp,commandPort,rpcPort,rpcRequestCount=0,workerOutput='',commandOutput='';
const checks=[],browserExceptions=[],browserPosts=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const dbUrl=new URL(process.env.TEST_DATABASE_URL);
 dbUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(dbUrl.toString());await store.assertReady();

 const poolAddress='0x8000000000000000000000000000000000000001',
  token1='0xf000000000000000000000000000000000000001',codeHash=`0x${'c'.repeat(64)}`,
  targetSetHash=`0x${'d'.repeat(64)}`;
 const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
  pool:poolAddress,token0:USDG,token1,quoteToken:0,decimals0:6,decimals1:6,fee:3000,tickSpacing:60,
  positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
  poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
  managerCodeHash:codeHash,quoterCodeHash:codeHash,
  reference0:'USDG/USD',reference1:'TOKEN/USD',nativeReference:'ETH/USD',numeraire:'USD'},
  referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES('worker-process-fixture',$1,4663,'TOKEN',$2,3000,1,$3,true)`,
 [poolAddress,token1,targetSetHash]);
 const referenceProof={fixture:'process-boundary-only'};
 const registration=await store.registerVerifiedMarketProfile({profile,profileHash:contentHash(profile),
  streamKey:'worker-process-fixture',
  source:{block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)},
  contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
   managerCodeHash:codeHash,quoterCodeHash:codeHash},
  references:{price0:'1000000000000000000',price1:'1000000000000000000',
   nativePrice:'2000000000000000000000',proofHash:referenceProofHash(referenceProof)},
  referenceProof,verifiedAt:new Date().toISOString()});
 const password='process-local-paper-operator',salt=randomBytes(16),passwordHash=
  `scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
 const campaign=await store.createDraft({mode:'paper',chainId:4663,
  wallet:'0x1111111111111111111111111111111111111111',marketProfileId:registration.id,
  strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:'100000000',token1Raw:'0',nativeWei:'1000000000000000'},
  config:{halfWidthTicks:180}});
 await admin.query(`UPDATE deployment_campaigns SET lifecycle='active' WHERE id=$1`,[campaign.id]);
 assert.equal(await store.paperOperationWorkerReady(),false);

 const commandProbe=createTcpServer();commandProbe.listen(0,'127.0.0.1');await once(commandProbe,'listening');
 commandPort=commandProbe.address().port;await new Promise((resolve,reject)=>commandProbe.close(error=>error?reject(error):resolve()));
 const rpcServer=createHttpServer(async(request,response)=>{
  rpcRequestCount++;let body='';for await(const chunk of request)body+=chunk;
  let parsed;try{parsed=JSON.parse(body);}catch{parsed={id:null};}
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({jsonrpc:'2.0',id:parsed.id,
   error:{code:-32000,message:'chain RPC intentionally unavailable in lifecycle-only fixture'}}));
 });
 rpcServer.listen(0,'127.0.0.1');await once(rpcServer,'listening');rpcPort=rpcServer.address().port;rpc=rpcServer;
 const env={...process.env,DATABASE_URL:dbUrl.toString(),COMMAND_PORT:String(commandPort),
  COMMAND_PASSWORD_HASH:passwordHash};
 let runtimeEnvFile=null;
 if(sealedReleaseMode){
  runtimeTemp=await mkdtemp(`${tmpdir()}/conc-liq-paper-release-process-`);
  runtimeEnvFile=join(runtimeTemp,'runtime.env');
  const runtime={DATABASE_URL:dbUrl.toString(),DEPLOYMENT_OPERATOR_PASSWORD_HASH:passwordHash,
   DEPLOYMENT_HOST:'127.0.0.1',DEPLOYMENT_PORT:String(commandPort),
   ROBINHOOD_READ_HTTP_URL:`http://127.0.0.1:${rpcPort}`,DEPLOYMENT_RPC_TIMEOUT_MS:'1000',
   DEPLOYMENT_PAPER_OPERATION_WORKER:'1',DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',
   DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'1',DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'1',
   DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4',INDEXER_STREAM_KEY:'worker-process-fixture',
   ADAPTIVE_PAPER_STATE_PATH:join(runtimeTemp,'absent-adaptive-state.json'),DASHBOARD_HOST:'127.0.0.1',
   DASHBOARD_PORT:'4173'};
  await writeFile(runtimeEnvFile,Object.entries(runtime).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',
   {mode:0o600});
 }
 const launch=(entrypoint,...args)=>sealedReleaseMode?
  spawn(join(releaseRoot,'bin/node'),[join(releaseRoot,'launch.mjs'),runtimeEnvFile,entrypoint,...args],
   {cwd:releaseRoot,env:{PATH:'/usr/bin:/bin',HOME:runtimeTemp},stdio:['ignore','pipe','pipe']}):
  spawn(process.execPath,['--import','tsx',entrypoint,...args],
   {cwd:process.cwd(),env:entrypoint==='test/fixtures/paper-command-server-process.mjs'?env:workerEnv,
    stdio:['ignore','pipe','pipe']});
 command=sealedReleaseMode?launch('deployments'):launch('test/fixtures/paper-command-server-process.mjs');
 command.stdout.setEncoding('utf8');command.stdout.on('data',chunk=>commandOutput+=chunk);
 command.stderr.setEncoding('utf8');command.stderr.on('data',chunk=>commandOutput+=chunk);
 const origin=`http://127.0.0.1:${commandPort}`;
 await waitFor(async()=>sealedReleaseMode?
  await fetch(origin+'/healthz').then(response=>response.status===200).catch(()=>false):
  commandOutput.includes('COMMAND_SERVER_READY'),'command server child ready');
 const post=async(path,body,headers={})=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const unauthenticatedProfiles=await fetch(origin+'/api/market-profiles');
 assert.equal(unauthenticatedProfiles.status,401,'profile reads require an authenticated operator session');
 const login=await post('/api/session',{password},{origin});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();
 const authHeaders={origin,cookie,'x-csrf-token':session.csrfToken};
 const profilesResponse=await fetch(origin+'/api/market-profiles',{headers:{cookie}});
 assert.equal(profilesResponse.status,200);const profiles=await profilesResponse.json();
 assert(profiles.profiles.some(row=>row.id===registration.id&&row.pool===poolAddress&&row.draftAvailable));
 const initialPositionsResponse=await fetch(origin+'/api/positions?hours=24',{headers:{cookie}});
 assert.equal(initialPositionsResponse.status,200);
 const initialPositions=await initialPositionsResponse.json();
 assert(initialPositions.positions.some(row=>row.id===`paper-dep-${campaign.id}`),
  'real deployment Positions projection lists the seeded campaign');
 checks.push(sealedReleaseMode?
  'sealed command entrypoint authenticates operator and serves registered profile plus Positions APIs':
  'command process authenticates operator and serves registered profile plus Positions APIs');
 const initialPreview=await post(`/api/deployments/${campaign.id}/previews`,{kind:'pause'},authHeaders);
 assert.equal(initialPreview.status,200);assert.equal((await initialPreview.json()).actionAvailable,false);
 const beforeReady=await post(`/api/deployments/${campaign.id}/lifecycle-operations`,
  {previewId:'11111111-1111-4111-8111-111111111111',contentDigest:'0'.repeat(64),
   expectedRevision:1,idempotencyKey:'process-pause-before-worker-1'},authHeaders);
 assert.equal(beforeReady.status,503);
 checks.push('command process serves authenticated pause preview and disables action without worker lease');

 const workerEnv={...process.env,DATABASE_URL:dbUrl.toString(),
  ROBINHOOD_READ_HTTP_URL:`http://127.0.0.1:${rpcPort}`,DEPLOYMENT_PAPER_OPERATION_WORKER:'1',
  DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'1',
  DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'1',DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4'};
 const startWorker=async()=>{
  workerOutput='';worker=sealedReleaseMode?launch('deployments-paper-worker'):
   spawn(process.execPath,['--import','tsx','src/deployments-paper-worker.ts'],
    {cwd:process.cwd(),env:workerEnv,stdio:['ignore','pipe','pipe']});
  worker.stdout.setEncoding('utf8');worker.stderr.setEncoding('utf8');
  worker.stdout.on('data',chunk=>workerOutput+=chunk);worker.stderr.on('data',chunk=>workerOutput+=chunk);
  await waitFor(async()=>await store.paperOperationWorkerReady(),'worker shared readiness lease');
 };
 const stopWorker=async()=>{
  if(!worker)return;const current=worker;worker=null;
  if(current.exitCode===null){current.kill('SIGTERM');await Promise.race([once(current,'exit'),sleep(5000)]);}
  if(current.exitCode===null)current.kill('SIGKILL');
  await waitFor(async()=>!(await store.paperOperationWorkerReady()),'worker lease release after process stop');
 };
 const runTransition=async(kind,stage,lifecycle)=>{
  const previewResponse=await post(`/api/deployments/${campaign.id}/previews`,{kind},authHeaders);
  assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
  assert.equal(preview.actionAvailable,true,JSON.stringify(preview));
  const acceptance=await post(`/api/deployments/${campaign.id}/lifecycle-operations`,
   {previewId:preview.id,contentDigest:preview.contentDigest,expectedRevision:preview.expectedRevision,
    idempotencyKey:`process-${kind}-${randomUUID()}`},authHeaders);
  assert.equal(acceptance.status,202);const operation=await acceptance.json();
  assert.equal(operation.status,'queued');
  const journal=await waitFor(async()=>{
   const response=await fetch(origin+`/api/operations/${operation.id}`,{headers:{cookie}});
   if(response.status!==200)return null;const row=await response.json();
   return row.status==='succeeded'&&row.stage===stage?row:null;
  },`${kind} process operation reaches ${stage}`);
  assert.equal(journal.id,operation.id);
  const positionsResponse=await fetch(origin+'/api/positions?hours=24',{headers:{cookie}});
  assert.equal(positionsResponse.status,200);const listing=await positionsResponse.json();
  const position=listing.positions.find(row=>row.id===`paper-dep-${campaign.id}`);
  assert(position);assert.equal(position.deployment.lifecycle,lifecycle);
  assert.equal(position.deployment.operation.id,operation.id);
  assert.equal(position.deployment.operation.stage,stage);
  assert.equal(position.deployment.operation.status,'succeeded');
  return {operationId:operation.id,stage,lifecycle};
 };
 await startWorker();
 const paused=await runTransition('pause','paper_paused','paused');
 await stopWorker();
 const offlineResumePreview=await post(`/api/deployments/${campaign.id}/previews`,{kind:'resume'},authHeaders);
 assert.equal((await offlineResumePreview.json()).actionAvailable,false);
 const offlineResume=await post(`/api/deployments/${campaign.id}/lifecycle-operations`,
  {previewId:'22222222-2222-4222-8222-222222222222',contentDigest:'1'.repeat(64),
   expectedRevision:1,idempotencyKey:'process-resume-offline-1'},authHeaders);
 assert.equal(offlineResume.status,503);
 checks.push('worker process termination releases advisory readiness lease and disables lifecycle admission');
 await startWorker();
 const resumed=await runTransition('resume','paper_resumed','active');
 await stopWorker();
 checks.push('worker process claims pause and resume and Positions exposes terminal operation stages');
 assert.equal(await store.paperOperationWorkerReady(),false);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_operations WHERE campaign_id=$1',[campaign.id])).rows[0].n,2);
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_ledger WHERE campaign_id=$1`,[campaign.id])).rows[0].n,0,
  'pause/resume add no economic ledger entries');
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_marks WHERE campaign_id=$1`,[campaign.id])).rows[0].n,0,
  'pause/resume add no valuation marks');
 await verifyPositionsBrowser({origin,password,expectedCampaign:campaign.id,expectedStage:'paper_resumed'});
 checks.push('desktop and mobile browser render real Positions operation activity and unavailable economics');
 console.log(JSON.stringify({checks,campaignId:campaign.id,paused,resumed,
  release:releaseManifest?{buildId:releaseManifest.buildId,sourceCommit:releaseManifest.sourceCommit,verified:true}:null,
  workerProcess:sealedReleaseMode?'sealed launch.mjs deployments-paper-worker':'src/deployments-paper-worker.ts',
  commandProcess:sealedReleaseMode?'sealed launch.mjs deployments':'createDeploymentCommandServer in isolated fixture process',workerRestarts:1,
  readinessLeaseReleased:true,chainRpcRequests:rpcRequestCount,chainRpcBoundary:'local error-only JSON-RPC stub',
  signerLoaded:false,ledgerRows:0,markRows:0},null,2));
}finally{
 if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await Promise.race([once(worker,'exit'),sleep(2000)]);}
  if(command&&command.exitCode===null){command.kill('SIGTERM');await Promise.race([once(command,'exit'),sleep(2000)]);}
 if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([once(chrome,'exit'),sleep(1500)]);
  if(chrome.exitCode===null)chrome.kill('SIGKILL');}
 try{ws?.close();}catch{}
 if(rpc?.listening)await new Promise(resolve=>rpc.close(resolve));
 await store?.close();await admin.query('SET search_path=public');
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await adminPool.end();
 if(chromeProfile)await rm(chromeProfile,{recursive:true,force:true});
 if(runtimeTemp)await rm(runtimeTemp,{recursive:true,force:true});
}

async function waitFor(read,label){
 for(let i=0;i<240;i++){
  if(worker?.exitCode!==null&&worker?.exitCode!==undefined)throw Error(`worker exited early (${worker.exitCode}): ${workerOutput}`);
  if(command?.exitCode!==null&&command?.exitCode!==undefined)throw Error(`command process exited early (${command.exitCode}): ${commandOutput}`);
  const value=await read();if(value)return value;await sleep(100);
 }
 throw Error(`Timed out waiting for ${label}; worker=${workerOutput}; command=${commandOutput}`);
}

async function verifyPositionsBrowser({origin,password,expectedCampaign,expectedStage}){
 const candidates=process.env.CHROMIUM_PATH? [process.env.CHROMIUM_PATH]:[
  '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'];
 let binary=null;for(const candidate of candidates){try{await access(candidate);binary=candidate;break;}catch{}}
 if(!binary)throw Error('Chromium not found; set CHROMIUM_PATH');
 chromeProfile=await mkdtemp(`${tmpdir()}/conc-liq-paper-positions-`);
 let stderr='',debugPort=0;
 chrome=spawn(binary,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
  '--user-data-dir='+chromeProfile,'about:blank'],{stdio:['ignore','ignore','pipe']});
 chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',chunk=>{stderr+=chunk;
  const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);if(match)debugPort=Number(match[1]);});
 for(let i=0;i<120&&!debugPort;i++){if(chrome.exitCode!==null)throw Error(`Chromium exited: ${stderr}`);await sleep(100);}
 assert(debugPort,'Chromium remote debugging did not start');
 const targets=await fetch(`http://127.0.0.1:${debugPort}/json`).then(response=>response.json()),target=targets.find(row=>row.type==='page');
 assert(target);ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let sequence=0;const pending=new Map();
 ws.addEventListener('message',event=>{const message=JSON.parse(event.data);
  if(message.id){const item=pending.get(message.id);if(item){pending.delete(message.id);
   message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}}
  else if(message.method==='Runtime.exceptionThrown')browserExceptions.push(message.params.exceptionDetails.text);
  else if(message.method==='Network.requestWillBeSent'&&message.params.request.method==='POST')
   browserPosts.push(new URL(message.params.request.url).pathname);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const wait=async(expression,label)=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await sleep(100);}
  throw Error(`Browser timed out: ${label}; state=${JSON.stringify(await evaluate(`({connection:document.querySelector('#connection-status')?.textContent,
   paper:document.querySelector('#paper')?.innerText?.slice(0,1200),activity:document.querySelector('#paper-bottom')?.innerText})`))}`);};
 const fill=async(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};
  input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:origin+'/operator'});await wait('document.readyState==="complete"','operator document');
 await wait('document.querySelectorAll("[role=tab]").length===2&&!document.querySelector("#operator-auth").hidden',
  'two-tab operator dashboard');
 await fill('#operator-password',password);await evaluate('document.querySelector("#operator-login-form button[type=submit]").click()');
 await wait('!document.querySelector("#operator-logout").hidden','operator login');
 await evaluate('window.dispatchEvent(new Event("positions-refresh-requested"))');
 await wait('document.querySelector("#positions-tab").click(),document.querySelector("#paper .positions-table tbody tr")!==null',
  'paper position list');
 await evaluate(`document.querySelector('#paper .positions-table tbody tr[data-position="paper-dep-${expectedCampaign}"] button').click()`);
 await wait('document.querySelector("#paper .position-detail .metrics")!==null','deployment metrics');
 await evaluate('document.querySelector("#paper .bottom-tabs button[data-value=activity]").click()');
 await wait(`document.querySelector('#paper .activity-list')?.textContent.includes(${JSON.stringify(expectedStage)})`,
  'operation activity stage');
 const desktop=await evaluate(`(()=>{const text=document.querySelector('#paper').innerText,items=[...document.querySelectorAll('#paper .activity-list li')].map(x=>x.innerText),
  metrics=[...document.querySelectorAll('#paper .metric')].map(x=>x.innerText);return {text,items,metrics,
  scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth};})()`);
 assert(desktop.items.some(text=>text.includes('pause')&&text.includes('succeeded')&&text.includes('paper_paused'))&&
  desktop.items.some(text=>text.includes('resume')&&text.includes('succeeded')&&text.includes(expectedStage)),
  `desktop view omits operation status/stage: ${JSON.stringify(desktop)}`);
 assert(desktop.text.toLowerCase().includes('unavailable'),
  `desktop view implies unavailable economics are present: ${JSON.stringify(desktop)}`);
 assert(desktop.metrics.some(text=>text.includes('Net value')&&text.includes('—'))&&
  desktop.metrics.some(text=>text.includes('Paid execution costs')&&text.includes('—')),
  `desktop metrics do not preserve unavailable costs: ${JSON.stringify(desktop.metrics)}`);
 assert.equal(desktop.scrollWidth<=desktop.viewport+1,true,`desktop page overflows horizontally: ${desktop.scrollWidth}/${desktop.viewport}`);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await sleep(250);
 const mobile=await evaluate(`(()=>({text:document.querySelector('#paper')?.innerText,
  scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,
  detailVisible:!!document.querySelector('#paper .position-detail'),activityVisible:!!document.querySelector('#paper .activity-list')}))()`);
 assert(mobile.text.includes(expectedStage)&&mobile.activityVisible&&mobile.detailVisible,
  `mobile view lost operation/detail content: ${JSON.stringify(mobile)}`);
 assert.equal(mobile.scrollWidth<=mobile.viewport+1,true,`mobile page overflows horizontally: ${mobile.scrollWidth}/${mobile.viewport}`);
 assert.deepEqual(browserExceptions,[]);assert.deepEqual(browserPosts,['/api/session'],`browser submitted command routes: ${browserPosts}`);
 try{ws.close();}catch{}ws=null;
}
