// Production command API + worker lifecycle for RangeKeeper paper. This
// fixture seeds only a verified market profile and setup draft; operations,
// previews, confirmation, observation, and close all use production paths.
// Canonical RPC reads are read-only. Every execution simulation uses a local
// owned Anvil fork. Run with TEST_DATABASE_URL targeting a disposable local DB.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer as createTcpServer} from 'node:net';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {hash,verifyRelease} from '../../scripts/release-files.mjs';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {contentHash,rangeKeeperParameters} from '../../src/deployments/contracts.ts';
import {verifyMarketProfile,marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {rangeKeeperConfirmedSource} from '../../src/strategy/rangekeeper/source.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {readDeploymentRows,readDeploymentDetail} from '../../src/dashboard/deployment-position.ts';
import {verifyCanonicalPaperAnchors} from '../../src/deployments/paper-canonical-anchors.ts';
import {verifyRangeKeeperPaperBrowserView} from './rangekeeper-paper-browser-view.mjs';

const safeError=error=>{
 const message=error instanceof Error?error.message:'RangeKeeper paper lifecycle failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,500)}\n`);
 process.exitCode=1;
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const preparationDiagnostics=output=>output.split('\n').filter(line=>
 line.includes('paper_setup_preparation_diagnostic')||line.includes('rangekeeper_paper_preparation_timing'))
 .slice(-12).map(line=>line.replace(/https?:\/\/\S+/gi,'[redacted-url]'));
const sealedReleaseMode=process.argv.includes('--sealed-release');
const releaseRoot=sealedReleaseMode?resolve(process.env.TEST_SEALED_RELEASE_DIR??''):null;
if(sealedReleaseMode&&!process.env.TEST_SEALED_RELEASE_DIR)
 throw Error('TEST_SEALED_RELEASE_DIR is required with --sealed-release');
const releaseManifest=releaseRoot?verifyRelease(releaseRoot):null;
if(sealedReleaseMode){
 assert.match(process.env.TEST_EXPECTED_RELEASE_COMMIT??'',/^[0-9a-f]{40}$/i,
  'sealed lifecycle requires TEST_EXPECTED_RELEASE_COMMIT');
 assert.equal(releaseManifest.sourceCommit,process.env.TEST_EXPECTED_RELEASE_COMMIT,
  'sealed release source commit mismatch');
}
async function waitFor(predicate,label,timeoutMs=180_000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){if(await predicate())return;await sleep(500);}
 throw Error(`Timed out waiting for ${label}`);
}
async function stop(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGTERM');await Promise.race([once(child,'exit'),sleep(5_000)]);
 if(child.exitCode===null)child.kill('SIGKILL');
}

try{
 assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
 const testUrl=new URL(process.env.TEST_DATABASE_URL),socket=testUrl.searchParams.get('host');
 assert(['localhost','127.0.0.1','[::1]','::1'].includes(testUrl.hostname.toLowerCase())||
  (socket&&socket.startsWith('/')),'TEST_DATABASE_URL must target a local PostgreSQL socket or host');
 const dotenv=parseEnv(readFileSync('.env','utf8')),
  archive=dotenv.RH_ARCHIVE_RPC_URL,readRpc=dotenv.ROBINHOOD_READ_HTTP_URL??archive,
  streamKey=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
 assert(archive&&readRpc,'Read-only RPC configuration unavailable');
 const rpc=createRobinhoodClient(readRpc,20_000,{retryCount:0}),rawConfig=JSON.parse(
  readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')),
  parsed=parseRangeKeeperConfig(rawConfig),profile=marketProfileSchema.parse({pool:parsed.pool,
   referencePolicy:parsed.referencePolicy});
 assert.equal(parsed.broadcastEnabled,false);
 const {fullWidthSpacings,...limits}=parsed.limits,
  parameters=rangeKeeperParameters.parse({fullWidthSpacings,
   limits:{...Object.fromEntries(Object.entries(limits).map(([key,value])=>
    [key,typeof value==='bigint'?String(value):value])),minDeploymentValue:'0'}}),
  configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
  buildId='a'.repeat(64),identity=JSON.stringify({buildId,configHash:'f'.repeat(64),nodeVersion:process.version});
 process.env.CONC_LIQ_RUNTIME_IDENTITY=identity;
 const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await adminPool.connect(),
  schema=`rk_lifecycle_${randomUUID().replaceAll('-','')}`;
 let store,command,worker,commandOutput='',workerOutput='',campaignId,operationIds=[],runtimeTemp;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
  await migrateDatabase(admin);
  const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
  scopedUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=30000`);
  store=new DeploymentStore(scopedUrl.toString());await store.assertReady();
  const targetSetHash=`0x${'f'.repeat(64)}`;
  await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
   created_block,target_set_hash,enabled) VALUES($1,$2,$3,'AAPL',$4,$5,1,$6,true)`,
   [streamKey,profile.pool.pool,profile.pool.chainId,
    profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0,profile.pool.fee,targetSetHash]);
  const proof=await verifyMarketProfile(rpc,profile,streamKey),
   registered=(await store.registerVerifiedMarketProfile(proof)).id;

  const probe=createTcpServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const commandPort=probe.address().port;await new Promise((resolve,reject)=>
   probe.close(error=>error?reject(error):resolve()));
  const origin=`http://127.0.0.1:${commandPort}`,
   baseEnv={...process.env,DATABASE_URL:scopedUrl.toString(),ROBINHOOD_READ_HTTP_URL:readRpc,
    PAPER_FORK_RPC_URL:archive,INDEXER_STREAM_KEY:streamKey,CONC_LIQ_RUNTIME_IDENTITY:identity,
    DEPLOYMENT_HOST:'127.0.0.1',DEPLOYMENT_PORT:String(commandPort),DASHBOARD_HOST:'127.0.0.1',
    DASHBOARD_PORT:String(commandPort+1),DEPLOYMENT_RPC_TIMEOUT_MS:'20000',
    DEPLOYMENT_PAPER_SETUP_DIAGNOSTICS:'1'},
   workerEnv={...baseEnv,DEPLOYMENT_PAPER_OPERATION_WORKER:'1',
    DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'1',
    DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'1',DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4'};
  const runtimeEnvPath=sealedReleaseMode?join(runtimeTemp=await mkdtemp(
   `${tmpdir()}/conc-liq-rk-lifecycle-sealed-`),'runtime.env'):null;
  if(sealedReleaseMode){
   const runtime={DATABASE_URL:scopedUrl.toString(),ROBINHOOD_READ_HTTP_URL:readRpc,
    PAPER_FORK_RPC_URL:archive,INDEXER_STREAM_KEY:streamKey,DEPLOYMENT_HOST:'127.0.0.1',
    DEPLOYMENT_PORT:String(commandPort),DEPLOYMENT_RPC_TIMEOUT_MS:'20000',
    DEPLOYMENT_PAPER_SETUP_DIAGNOSTICS:'1',DEPLOYMENT_PAPER_OPERATION_WORKER:'1',
    DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'1',
    DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'1',DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4',
    DASHBOARD_HOST:'127.0.0.1',DASHBOARD_PORT:String(commandPort+1),
    ADAPTIVE_PAPER_STATE_PATH:join(runtimeTemp,'absent-adaptive-state.json')};
   await writeFile(runtimeEnvPath,Object.entries(runtime)
    .map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});
   process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify({buildId:releaseManifest.buildId,
    configHash:hash(JSON.stringify(Object.fromEntries(Object.entries(runtime)
     .sort(([a],[b])=>a.localeCompare(b,'en'))))),nodeVersion:releaseManifest.nodeVersion});
  }
  const launchSealed=entrypoint=>spawn(join(releaseRoot,'bin/node'),
   [join(releaseRoot,'launch.mjs'),runtimeEnvPath,entrypoint],
   {cwd:releaseRoot,env:{PATH:'/usr/bin:/bin',HOME:runtimeTemp},stdio:['ignore','pipe','pipe']});
  command=sealedReleaseMode?launchSealed('deployments'):
   spawn(process.execPath,['--import','tsx','src/deployments.ts'],
    {cwd:process.cwd(),env:baseEnv,stdio:['ignore','pipe','pipe']});
  command.stdout.setEncoding('utf8');command.stderr.setEncoding('utf8');
  command.stdout.on('data',part=>commandOutput+=part);command.stderr.on('data',part=>commandOutput+=part);
  await waitFor(async()=>{
   if(command.exitCode!==null)throw Error(`deployment command exited ${command.exitCode}: ${
    commandOutput.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(-700)}`);
   return fetch(origin+'/healthz').then(response=>response.status===200).catch(()=>false);
  },'production deployment command API',30_000);
  const startWorker=async()=>{
   worker=sealedReleaseMode?launchSealed('deployments-paper-worker'):
    spawn(process.execPath,['--import','tsx','src/deployments-paper-worker.ts'],
     {cwd:process.cwd(),env:workerEnv,stdio:['ignore','pipe','pipe']});
   worker.stdout.setEncoding('utf8');worker.stderr.setEncoding('utf8');
   worker.stdout.on('data',part=>workerOutput+=part);worker.stderr.on('data',part=>workerOutput+=part);
   await waitFor(async()=>{
    if(worker.exitCode!==null)throw Error(`paper worker exited ${worker.exitCode}: ${
     workerOutput.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(-700)}`);
    return store.paperOperationWorkerReady();
   },'production paper worker readiness',30_000);
  };
  await startWorker();

  const post=async(path,body,headers={})=>fetch(origin+path,{method:'POST',
   headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}),
   login=await post('/api/session',{}, {origin});
  assert.equal(login.status,200,`operator session status ${login.status}`);
  const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json(),
   auth={origin,cookie,'x-csrf-token':session.csrfToken};
  const setupStartedAt=Date.now(),setupBody={profileId:registered,capitalQuoteRaw:'250000000',fullWidthSpacings:parameters.fullWidthSpacings,
   limits:parameters.limits},setupResponse=await post('/api/deployments/rangekeeper/setup-preflight',setupBody,auth),
   setup=await setupResponse.json();
  process.stdout.write(JSON.stringify({event:'setup_preflight',status:setup.status,source:setup.source??null,
   elapsedMs:Date.now()-setupStartedAt})+'\n');
  assert.equal(setupResponse.status,200,`setup preflight ${setupResponse.status}: ${JSON.stringify(setup)}`);
  assert.equal(setup.status,'available',JSON.stringify(setup));
  const reviewed={profileId:setup.profileId,profileHash:setup.profileHash,input:setup.input,source:setup.source,
   profile:setup.profile,range:setup.range,requirements:setup.requirements,references:setup.references,
   costs:setup.costs},
   retainReserve=BigInt(setup.costs.retainExit.boundWei)>
    BigInt(parameters.limits.exitReserveWei)?BigInt(setup.costs.retainExit.boundWei):
     BigInt(parameters.limits.exitReserveWei),
   requiredNative=BigInt(setup.costs.open.boundWei)+retainReserve,
   nativeWei=requiredNative+(requiredNative+4n)/5n,
   setupDraftBody={requestId:randomUUID(),reviewId:setup.setupReviewId,profileId:registered,
    capitalQuoteRaw:setup.input.capitalQuoteRaw,fullWidthSpacings:setup.input.fullWidthSpacings,
    wallet:rawConfig.operator,allocation:{token0Raw:setup.requirements.token0Raw,
     token1Raw:setup.requirements.token1Raw,nativeWei:String(nativeWei)},limits:parameters.limits,reviewed},
   draftResponse=await post('/api/deployments/rangekeeper/setup-drafts',setupDraftBody,auth),
   savedDraft=await draftResponse.json();
  process.stdout.write(JSON.stringify({event:'setup_draft_admission',status:draftResponse.status,
   resultStatus:savedDraft.status??null,missing:savedDraft.missing??[],reason:savedDraft.error??null})+'\n');
  assert.equal(draftResponse.status,201,JSON.stringify(savedDraft));
  assert.equal(savedDraft.status,'draft_created',JSON.stringify(savedDraft));
  campaignId=savedDraft.draftId;
  const previewOpen=async()=>{
    const response=await post(`/api/deployments/${campaignId}/previews`,{kind:'open'},auth),body=await response.json();
    return {...body,httpStatus:response.status};
   };
  let first,firstStarted=Date.now();const firstAttempts=[];
  for(let attempt=1;attempt<=3;attempt++){
   first=await previewOpen();
   const summary={attempt,httpStatus:first.httpStatus,status:first.status,
    reason:first.blockingReason??first.reason??first.unavailable?.[0]??null,
    decision:first.decision?{action:first.decision.action,reason:first.decision.reason,
     kernelAction:first.decision.kernelAction,kernelReason:first.decision.kernelReason}:null,
    unavailable:Array.isArray(first.unavailable)?first.unavailable.slice(0,8):[],
    candidate:first.candidate?{kind:first.candidate.kind,range:first.candidate.range,
     sourceBlock:first.candidate.sourceBlock,swap:Boolean(first.candidate.swap)}:null,
    source:first.source??null,elapsedMs:Date.now()-firstStarted,
    preparationDiagnostics:preparationDiagnostics(commandOutput)};
   firstAttempts.push(summary);process.stdout.write(JSON.stringify({event:'open_preview_first',...summary})+'\n');
   if(first.status==='indicative')break;
   if(first.status!=='blocked')break;
   const state=await store.rangeKeeperPaperOpenPreviewState(campaignId);
   if(state.livePreview)break;
   if(attempt<3){await sleep(2_000);firstStarted=Date.now();}
  }
  if(first.status!=='indicative')process.stdout.write(JSON.stringify({event:'open_preview_unavailable',
   attempts:firstAttempts,exitReserveWei:parameters.limits.exitReserveWei,
   nativeAllocationWei:String(nativeWei)})+'\n');
  assert.equal(first.status,'indicative',JSON.stringify(first));
  assert.equal(first.confirmation?.status,'first_observation_recorded',JSON.stringify(first));
  assert.equal(first.actionAvailable,false);
  const secondAt=Date.parse(first.confirmation.secondObservationFrom);
  assert(Number.isFinite(secondAt),'First observation did not expose the second-observation window');
  const secondWaitStarted=Date.now(),eligibleTimestamp=Math.floor(secondAt/1000),
   maximumObservationTimestamp=Number(first.source.timestamp)+parameters.limits.maxObservationGapSeconds,
   sourceWaitDeadline=maximumObservationTimestamp*1000;
  let confirmedSecondSource=null;
  while(Date.now()<sourceWaitDeadline){
   const confirmed=await rangeKeeperConfirmedSource(rpc);
   if(confirmed.timestamp>=eligibleTimestamp){confirmedSecondSource=confirmed;break;}
   await sleep(Math.min(1_000,Math.max(1,sourceWaitDeadline-Date.now())));
  }
  assert(confirmedSecondSource,'Confirmed canonical source did not reach the second-observation interval before the frozen gap limit');
  const secondWaitMs=Date.now()-secondWaitStarted,secondStarted=Date.now(),
   sourceAgeAtSecondStartSeconds=Math.floor(secondStarted/1000)-Number(first.source.timestamp),
   confirmedSourceAgeSeconds=confirmedSecondSource.timestamp-Number(first.source.timestamp),
   second=await previewOpen(),sourceAgeAtSecondEndSeconds=
   Math.floor(Date.now()/1000)-Number(first.source.timestamp);
  if(second.httpStatus!==200)process.stdout.write(JSON.stringify({event:'open_preview_second_http_error',
   httpStatus:second.httpStatus,body:second,elapsedMs:Date.now()-secondStarted,
   secondWaitMs,sourceAgeAtSecondStartSeconds,sourceAgeAtSecondEndSeconds,
   confirmedSecondSource:{block:String(confirmedSecondSource.block),hash:confirmedSecondSource.hash,
    timestamp:confirmedSecondSource.timestamp,gapSeconds:confirmedSourceAgeSeconds},
   producerDiagnostics:preparationDiagnostics(commandOutput)})+'\n');
  if(second.confirmation?.status!=='confirmed'){
   const savedState=await store.rangeKeeperPaperOpenPreviewState(campaignId);
   process.stdout.write(JSON.stringify({event:'open_confirmation_unavailable',reason:second.reason??null,
    firstSourceTimestamp:first.source.timestamp,nowSeconds:Math.floor(Date.now()/1000),
    savedPreviewExpiry:savedState.binding?.expiresAt?.toISOString()??null,
    livePreview:savedState.livePreview,producerDiagnostics:preparationDiagnostics(commandOutput)})+'\n');
  }
  process.stdout.write(JSON.stringify({event:'open_preview_second',status:second.status,
   httpStatus:second.httpStatus,confirmation:second.confirmation?.status??null,reason:second.reason??null,
   source:second.confirmationObservation?.source??null,elapsedMs:Date.now()-secondStarted,secondWaitMs,
   sourceAgeAtSecondStartSeconds,sourceAgeAtSecondEndSeconds,
   confirmedSecondSource:{block:String(confirmedSecondSource.block),hash:confirmedSecondSource.hash,
    timestamp:confirmedSecondSource.timestamp,gapSeconds:confirmedSourceAgeSeconds},
   producerDiagnostics:preparationDiagnostics(commandOutput)})+'\n');
  assert.equal(second.httpStatus,200,JSON.stringify(second));
  assert.equal(second.confirmation?.status,'confirmed',JSON.stringify(second));
  assert.equal(second.strategyId,'rangekeeper_v1');
  assert.equal(second.actionAvailable,true,JSON.stringify(second));
  const acceptedAt=Date.now(),openResponse=await post(
   `/api/deployments/${campaignId}/rangekeeper/open-operations`,
   {previewId:second.id,contentDigest:second.contentDigest,expectedRevision:second.expectedRevision,
    idempotencyKey:`rk-lifecycle-open-${randomUUID()}`},auth),openOperation=await openResponse.json();
  assert.equal(openResponse.status,202,JSON.stringify(openOperation));
  assert.equal(openOperation.status,'queued');operationIds.push(openOperation.id);
  await waitFor(async()=>{
   const status=(await admin.query('SELECT status FROM deployment_operations WHERE id=$1',[openOperation.id])).rows[0]?.status;
   return status==='succeeded'||status==='blocked';
  },'production RangeKeeper open worker booking',300_000);
  const openJournal=(await admin.query('SELECT status,stage,reason FROM deployment_operations WHERE id=$1',
   [openOperation.id])).rows[0];
  if(openJournal.status!=='succeeded'){
   const confirmation=(await admin.query(`SELECT first_source_block::text,first_source_hash,
    confirmation_source_block::text,confirmation_source_hash,envelope_hash
    FROM deployment_rangekeeper_paper_confirmations WHERE campaign_id=$1`,[campaignId])).rows[0]??null,
    receipt=(await admin.query(`SELECT producer_run_id,producer_build_id,receipt_hash
     FROM deployment_rangekeeper_paper_confirmation_producers WHERE campaign_id=$1`,[campaignId])).rows[0]??null;
   process.stdout.write(JSON.stringify({event:'open_worker_terminal',journal:openJournal,confirmation,receipt,
    workerLogTail:workerOutput.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(-2400)})+'\n');
  }
  assert.equal(openJournal.status,'succeeded',`Open worker stopped at ${openJournal.stage}: ${openJournal.reason??''}`);
  const confirmationSources=(await admin.query(`SELECT first_source_block::text AS first_block,
   first_source_hash AS first_hash,confirmation_source_block::text AS confirmation_block,
   confirmation_source_hash AS confirmation_hash,envelope_hash
   FROM deployment_rangekeeper_paper_confirmations WHERE campaign_id=$1`,[campaignId])).rows[0];
  process.stdout.write(JSON.stringify({event:'open_worker_completed',operationId:openOperation.id,
   status:openJournal.status,stage:openJournal.stage,confirmationSources})+'\n');
  const openDashboardRow=(await readDeploymentRows(admin)).find(row=>row.id===campaignId);
  assert(openDashboardRow,'Open RangeKeeper campaign missing from shared dashboard rows');
  const openDetail=await readDeploymentDetail(admin,openDashboardRow,24);
  assert.equal(openDetail.position.status,'open');assert.equal(openDetail.position.hasLiquidity,true);
  assert.equal(openDetail.position.accounting,'unavailable');
  const sharedOpenResponse=await fetch(`${origin}/api/positions/paper-dep-${campaignId}?hours=24`,
   {headers:{cookie}}),sharedOpen=await sharedOpenResponse.json();
  assert.equal(sharedOpenResponse.status,200);assert.equal(sharedOpen.position.status,'open');
  const openBrowserView=await verifyRangeKeeperPaperBrowserView({origin,campaignId,status:'open'});
  process.stdout.write(JSON.stringify({event:'dashboard_browser_open',checks:openBrowserView.checks})+'\n');

  await waitFor(async()=>Number((await admin.query(`SELECT count(*)::int AS count FROM deployment_marks
   WHERE campaign_id=$1 AND provenance->>'classification'='rangekeeper_paper_mark_v1'`,[campaignId])).rows[0].count)>=1,
   'default paper worker RangeKeeper observation',300_000);
  const observation=(await admin.query(`SELECT id::text,source_block::text AS block,source_hash AS hash,
   provenance FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'classification'='rangekeeper_paper_mark_v1'
   ORDER BY id::numeric DESC LIMIT 1`,[campaignId])).rows[0];
  assert(observation,'Worker observation mark was not persisted');
  assert.equal(observation.provenance.kernelSnapshot.pending,false);
  assert.equal(observation.provenance.kernelSnapshot.entryAllowed,false);
  process.stdout.write(JSON.stringify({event:'worker_observation',block:observation.block,hash:observation.hash,
   markId:observation.id,decision:observation.provenance.decision??null,
   kernelEntryAllowed:observation.provenance.kernelSnapshot.entryAllowed,
   kernelExecutionReady:observation.provenance.kernelSnapshot.executionReady})+'\n');
  const firstObservationId=observation.id;
  await stop(worker);worker=null;
  await waitFor(()=>store.paperOperationWorkerReady().then(ready=>!ready),
   'worker readiness lease release after restart stop',30_000);
  await startWorker();
  await waitFor(async()=>BigInt((await admin.query(`SELECT max(id)::text AS id FROM deployment_marks
   WHERE campaign_id=$1 AND provenance->>'classification'='rangekeeper_paper_mark_v1'`,[campaignId])).rows[0].id??'0')>
    BigInt(firstObservationId),
   'worker restart recovery observation',240_000);
  const restartedObservation=(await admin.query(`SELECT id::text,source_block::text AS block,source_hash AS hash,
   provenance FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'classification'='rangekeeper_paper_mark_v1'
   ORDER BY id::numeric DESC LIMIT 1`,[campaignId])).rows[0];
  assert(restartedObservation);assert.equal(restartedObservation.provenance.kernelSnapshot.entryAllowed,false);
  assert.equal(restartedObservation.provenance.kernelSnapshot.executionReady,false);
  process.stdout.write(JSON.stringify({event:'worker_restart_observation',block:restartedObservation.block,
   hash:restartedObservation.hash,markId:restartedObservation.id,
   entryAllowed:restartedObservation.provenance.kernelSnapshot.entryAllowed,
   executionReady:restartedObservation.provenance.kernelSnapshot.executionReady})+'\n');
  const closeStarted=Date.now(),closePreviewResponse=await post(
   `/api/deployments/${campaignId}/previews`,{kind:'close_retain'},auth),closePreview=await closePreviewResponse.json();
  assert.equal(closePreviewResponse.status,200,JSON.stringify(closePreview));
  process.stdout.write(JSON.stringify({event:'close_retain_preview',status:closePreview.status,
   reason:closePreview.blockingReason??closePreview.reason??null,source:closePreview.source??null,
   actionAvailable:closePreview.actionAvailable,elapsedMs:Date.now()-closeStarted})+'\n');
  if(closePreview.status!=='indicative'){
   process.stdout.write(JSON.stringify({event:'close_retain_diagnostic',reason:closePreview.reason??null,
    commandLogTail:commandOutput.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(-1400)})+'\n');
  }
  assert.equal(closePreview.status,'indicative',JSON.stringify(closePreview));
  assert.equal(closePreview.exitKind,'retain');assert.equal(closePreview.actionAvailable,true,JSON.stringify(closePreview));
  const closeResponse=await post(`/api/deployments/${campaignId}/rangekeeper/close-operations`,
   {previewId:closePreview.id,contentDigest:closePreview.contentDigest,
    expectedRevision:closePreview.expectedRevision,idempotencyKey:`rk-lifecycle-close-${randomUUID()}`},auth),
   closeOperation=await closeResponse.json();
  assert.equal(closeResponse.status,202,JSON.stringify(closeOperation));
  assert.equal(closeOperation.status,'queued');operationIds.push(closeOperation.id);
  await waitFor(async()=>{
   const status=(await admin.query('SELECT status FROM deployment_operations WHERE id=$1',[closeOperation.id])).rows[0]?.status;
   return status==='succeeded'||status==='blocked';
  },'production RangeKeeper retain-close worker completion',300_000);
  const closeJournal=(await admin.query('SELECT status,stage,reason FROM deployment_operations WHERE id=$1',
   [closeOperation.id])).rows[0];
  assert.equal(closeJournal.status,'succeeded',`Retain close stopped at ${closeJournal.stage}: ${closeJournal.reason??''}`);
  const closedRow=(await readDeploymentRows(admin)).find(row=>row.id===campaignId);
  assert(closedRow,'Closed RangeKeeper campaign missing from shared dashboard rows');
  const closedDetail=await readDeploymentDetail(admin,closedRow,24);
  assert.equal(closedDetail.position.status,'closed');
  assert(closedDetail.performance.markCount>=4,'Shared dashboard history lacks open, restarted observations, and close marks');
  assert(closedDetail.performance.timeline.some(row=>row.action==='enter'));
  assert(closedDetail.performance.timeline.some(row=>row.action==='exit'));
  assert(closedDetail.performance.timeline.every(row=>row.economicNavQuote===null&&
   row.feesThisIntervalQuote===null&&row.gasThisMarkQuote===null&&row.swapThisMarkQuote===null),
   'Unavailable economic values were filled from modeled evidence');
  assert(closedDetail.performance.rows.every(row=>row.netPnlQuote===null&&row.alphaQuote===null&&
   row.feeIncomeQuote===null&&row.gasQuote===null&&row.swapCostQuote===null),
   'Unavailable performance aggregates were filled from modeled evidence');
  const sharedClosedResponse=await fetch(`${origin}/api/positions/paper-dep-${campaignId}?hours=24`,
   {headers:{cookie}}),sharedClosed=await sharedClosedResponse.json();
  assert.equal(sharedClosedResponse.status,200);assert.equal(sharedClosed.position.status,'closed');
  assert(sharedClosed.performance.timeline.some(row=>row.action==='enter'));
  assert(sharedClosed.performance.timeline.some(row=>row.action==='exit'));
  const closedBrowserView=await verifyRangeKeeperPaperBrowserView({origin,campaignId,status:'closed'});
  process.stdout.write(JSON.stringify({event:'dashboard_browser_closed',checks:closedBrowserView.checks})+'\n');

  const restart=new DeploymentStore(scopedUrl.toString());await restart.assertReady();
  const restartedRows=await readDeploymentRows(admin),restarted=restartedRows.find(row=>row.id===campaignId);
  assert(restarted,'Restart projection lost closed campaign history');
  const restartedDetail=await readDeploymentDetail(admin,restarted,24);
  assert.equal(restartedDetail.position.status,'closed');
  await restart.close();
  process.stdout.write(JSON.stringify({status:'lifecycle_passed',campaignId,operationIds,
   setupDraftId:savedDraft.draftId,firstObservationSource:first.source,
   secondObservationSource:second.confirmationObservation?.source??null,
   openActionAvailable:second.actionAvailable,postOpenObservation:{block:observation.block,hash:observation.hash},
   closePreviewSource:closePreview.source,closeActionAvailable:closePreview.actionAvailable,
   closedMarkCount:closedDetail.performance.markCount,restartHistoryPreserved:true,
   productionCommandProcess:true,productionWorkerProcess:true,signerLoaded:false,broadcasts:0,
   phaseSeconds:{firstPreview:(secondStarted-firstStarted)/1000,
    firstToSecondSource:(second.confirmationObservation.source.timestamp-first.source.timestamp),
    acceptedToDashboard:(Date.now()-acceptedAt)/1000,closePreparationAndAcceptance:(Date.now()-closeStarted)/1000}})+'\n');
 }finally{
  await stop(worker);await stop(command);
  if(store)await store.close().catch(()=>{});
  if(runtimeTemp)await rm(runtimeTemp,{recursive:true,force:true});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await adminPool.end();
 }
}catch(error){safeError(error);}
