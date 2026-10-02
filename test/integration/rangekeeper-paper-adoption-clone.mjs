// Canonical continuity harness for an isolated clone of one real RangeKeeper
// paper campaign. The caller creates the disposable DB from the approved dump.
// Source-only mode uses source processes and an explicit synthetic identity.
// Sealed mode launches predecessor and target release artifacts using the same
// env file; its sole test-only rewrite is runtime_identity.configHash on the
// cloned campaign, with mark/model fingerprints checked unchanged. Neither
// mode targets production.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer as createTcpServer} from 'node:net';
import {resolve,join} from 'node:path';
import pg from 'pg';
import {hash,verifyRelease} from '../../scripts/release-files.mjs';
import {contentHash} from '../../src/deployments/contracts.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {verifyCanonicalPaperAnchors} from '../../src/deployments/paper-canonical-anchors.ts';
import {readDeploymentRows,readDeploymentDetail} from '../../src/dashboard/deployment-position.ts';
import {startCanonicalPaperBrowser,acceptPositionsAction,assertBrowserHealthy,
 selectCampaignInPositions,inspectPositionAtWidths} from './helpers/canonical-paper-browser.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safeError=error=>String(error?.message??'RangeKeeper clone lifecycle failed')
 .replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,500);
async function waitFor(predicate,label,timeoutMs=600_000,onProgress=()=>{}){
 const started=Date.now(),deadline=started+timeoutMs;let nextProgress=started+30_000;
 while(Date.now()<deadline){
  const result=await predicate();if(result)return result;
  if(Date.now()>=nextProgress){onProgress({label,elapsedSeconds:Math.floor((Date.now()-started)/1000)});
   nextProgress=Date.now()+30_000;}
  await sleep(500);
 }
 throw Error(`Timed out waiting for ${label} after ${Math.floor(timeoutMs/1000)} seconds`);
}
async function stop(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGTERM');await Promise.race([once(child,'exit'),sleep(5000)]);
 if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([once(child,'exit'),sleep(2000)]);}
 if(child.exitCode===null)throw Error('Child process did not stop after bounded shutdown');
}
const phase=(name,details={})=>process.stdout.write(JSON.stringify({phase:name,...details})+'\n');

let command,worker,browser,store,adminPool,admin;
try{
 const sealedMode=process.env.TEST_SEALED_MODE==='1';
 assert(sealedMode||process.env.TEST_SOURCE_ONLY_IDENTITY==='1',
  'Set TEST_SOURCE_ONLY_IDENTITY=1 or TEST_SEALED_MODE=1 to select the explicit harness mode');
 assert.match(process.env.TEST_CAMPAIGN_ID??'',/^[0-9a-f-]{36}$/i,'TEST_CAMPAIGN_ID is required');
 assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
 const databaseUrl=new URL(process.env.TEST_DATABASE_URL),socket=databaseUrl.searchParams.get('host');
 assert(['localhost','127.0.0.1','[::1]','::1'].includes(databaseUrl.hostname.toLowerCase())||
  (socket&&socket.startsWith('/')),'clone harness requires a loopback database or local socket');
 const exitKind=process.env.TEST_RK_EXIT_KIND??'retain';
 assert(['retain','convert'].includes(exitKind),'TEST_RK_EXIT_KIND must be retain or convert');
 const oldReleaseDir=resolve(process.env.TEST_PREDECESSOR_RELEASE_DIR??'');
 assert(process.env.TEST_PREDECESSOR_RELEASE_DIR,'TEST_PREDECESSOR_RELEASE_DIR is required');
 const oldRelease=verifyRelease(oldReleaseDir),targetReleaseDir=sealedMode?
  resolve(process.env.TEST_TARGET_RELEASE_DIR??''):null;
 if(sealedMode)assert(process.env.TEST_TARGET_RELEASE_DIR,'TEST_TARGET_RELEASE_DIR is required in sealed mode');
 const targetRelease=targetReleaseDir?verifyRelease(targetReleaseDir):null,
  envFile=sealedMode?resolve(process.env.TEST_RUNTIME_ENV_FILE??''):null;
 if(sealedMode)assert(process.env.TEST_RUNTIME_ENV_FILE,'TEST_RUNTIME_ENV_FILE is required in sealed mode');
 const dotenv=sealedMode?parseEnv(readFileSync(envFile,'utf8')):parseEnv(readFileSync('.env','utf8')),
  readRpc=dotenv.ROBINHOOD_READ_HTTP_URL??dotenv.RH_ARCHIVE_RPC_URL,
  forkRpc=dotenv.PAPER_FORK_RPC_URL??dotenv.RH_ARCHIVE_RPC_URL,
  streamKey=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
 assert(readRpc&&forkRpc,'Read-only RPC and local owned-fork RPC configuration are required');
 let sealedEnvHash;
 if(sealedMode){
  delete process.env.CONC_LIQ_RUNTIME_IDENTITY;
  assert.equal(targetRelease.nodeVersion,process.version,'target sealed release must use this pinned Node version');
  assert(Object.keys(dotenv).every(key=>!key.startsWith('CONC_LIQ_')&&
   !['NODE_OPTIONS','NODE_PATH','ANVIL_BIN','PATH','HOME','LD_PRELOAD','LD_LIBRARY_PATH'].includes(key)),
   'sealed runtime environment contains a reserved launcher setting');
  assert.equal(resolve(envFile),envFile,'sealed runtime env path must be absolute');
  const orderedEnv=Object.fromEntries(Object.entries(dotenv).sort(([a],[b])=>a.localeCompare(b,'en')));
  sealedEnvHash=hash(JSON.stringify(orderedEnv));
  phase('sealed_releases_verified',{predecessorBuildId:oldRelease.buildId,targetBuildId:targetRelease.buildId,
   sameRuntimeEnvFile:true,launcherEnvironmentOverrides:false});
 }
 const rpc=createRobinhoodClient(readRpc,20_000,{retryCount:0});
 adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});admin=await adminPool.connect();
 const campaignId=process.env.TEST_CAMPAIGN_ID;
 const base=(await admin.query(`SELECT c.id::text,c.mode,c.lifecycle,c.current_revision,
  c.runtime_identity,r.strategy_id,r.config_hash,r.config,p.profile_hash,p.profile
  FROM deployment_campaigns c JOIN deployment_revisions r ON r.campaign_id=c.id AND
  r.revision=c.current_revision JOIN deployment_market_profiles p ON p.id=c.market_profile_id
  WHERE c.id=$1`,[campaignId])).rows[0];
 assert(base,'cloned campaign does not exist');assert.equal(base.mode,'paper');
 if(sealedMode){
  const envDatabase=new URL(dotenv.DATABASE_URL??''),testDatabase=new URL(process.env.TEST_DATABASE_URL),
   envDatabaseName=decodeURIComponent(envDatabase.pathname.slice(1)),testDatabaseName=decodeURIComponent(testDatabase.pathname.slice(1));
  assert.equal(dotenv.DATABASE_URL,process.env.TEST_DATABASE_URL,
   'sealed process and clone harness must use the exact same disposable database URL');
  assert(envDatabaseName.startsWith('conc_liq_rk_')&&testDatabaseName.startsWith('conc_liq_rk_'),
   'sealed environment relocation is restricted to a conc_liq_rk_ disposable database');
  const marksFingerprint=async()=>contentHash((await admin.query(`SELECT id::text,revision,source_block::text,
   source_hash,inventory,economics,provenance FROM deployment_marks WHERE campaign_id=$1 ORDER BY id`,
   [campaignId])).rows);
  const beforeMarksHash=await marksFingerprint(),previousIdentity=base.runtime_identity;
  assert.equal(previousIdentity?.buildId,oldRelease.buildId);
  assert.equal(previousIdentity?.nodeVersion,process.version);
  if(previousIdentity.configHash!==sealedEnvHash){
   await admin.query('BEGIN');
   try{
    const relocated=await admin.query(`UPDATE deployment_campaigns SET runtime_identity=
     jsonb_set(runtime_identity,'{configHash}',to_jsonb($2::text),false)
     WHERE id=$1 AND mode='paper' AND runtime_identity->>'buildId'=$3
      AND runtime_identity->>'configHash'=$4 AND runtime_identity->>'nodeVersion'=$5
     RETURNING runtime_identity`,[campaignId,sealedEnvHash,oldRelease.buildId,
      previousIdentity.configHash,process.version]);
    assert.equal(relocated.rowCount,1,'only the cloned campaign configHash may be relocated once');
    await admin.query('COMMIT');base.runtime_identity=relocated.rows[0].runtime_identity;
   }catch(error){await admin.query('ROLLBACK');throw error;}
  }
  assert.equal(base.runtime_identity.configHash,sealedEnvHash);
  assert.equal(await marksFingerprint(),beforeMarksHash,'test-only runtime relocation changed historical marks');
  phase('test_only_runtime_environment_relocation',{campaignId,field:'deployment_campaigns.runtime_identity.configHash',
   retainedBuildId:base.runtime_identity.buildId,retainedNodeVersion:base.runtime_identity.nodeVersion,
   marksUnchanged:true,sealedEnvHash});
 }
 assert(base,'cloned campaign does not exist');assert.equal(base.mode,'paper');
 assert(['active','paused'].includes(base.lifecycle),'cloned campaign must be active or paused');
 assert.equal(base.strategy_id,'rangekeeper_v1');
 const activeCount=await admin.query(`SELECT count(*)::int AS count FROM deployment_campaigns c
  JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
  WHERE c.mode='paper' AND c.lifecycle IN ('active','paused') AND r.strategy_id='rangekeeper_v1'`);
 assert.equal(activeCount.rows[0].count,1,'clone must contain exactly one active RangeKeeper campaign');
 const from=base.runtime_identity;
 assert.equal(from?.buildId,oldRelease.buildId,'campaign predecessor identity must match verified old release');
 assert.equal(from.nodeVersion,process.version,'source runner must use the predecessor Node version');
 const target={buildId:targetRelease?.buildId??'a'.repeat(64),
  configHash:sealedEnvHash??from.configHash,nodeVersion:targetRelease?.nodeVersion??from.nodeVersion};
 const priorAdoption=(await admin.query(`SELECT source FROM deployment_ledger WHERE campaign_id=$1 AND kind='attribution_boundary'
  AND entry_key LIKE 'rangekeeper_runtime_adoption:%' ORDER BY id DESC LIMIT 1`,[campaignId])).rows[0]?.source;
 const alreadyAdopted=!!priorAdoption?.toRuntimeIdentity&&
  contentHash(priorAdoption.toRuntimeIdentity)===contentHash(target);
 if(sealedMode)assert(!alreadyAdopted,'sealed lifecycle mode requires a fresh disposable clone');
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(alreadyAdopted?target:from);
 store=new DeploymentStore(process.env.TEST_DATABASE_URL);await store.assertReady();
 let beforeEpoch=await store.rangeKeeperPaperEpochSnapshot(campaignId);
 assert.equal(beforeEpoch.draft.configHash,base.config_hash);
 const oldProof={buildId:oldRelease.buildId,sourceCommit:oldRelease.sourceCommit,
  filesHash:contentHash(oldRelease.files)};
 let sealedOrigin;
 if(sealedMode&&!alreadyAdopted){
  assert.equal(dotenv.DEPLOYMENT_PAPER_OPERATION_WORKER,'1',
   'sealed env must enable the worker operation readiness lease');
  const host=dotenv.DEPLOYMENT_HOST??'127.0.0.1',port=Number(dotenv.DEPLOYMENT_PORT??4174);
  assert(['127.0.0.1','::1'].includes(host)&&Number.isInteger(port)&&port>0&&port<65536,
   'sealed clone services must bind loopback ports');
  sealedOrigin=`http://${host==='::1'?'[::1]':host}:${port}`;
  const launch=(releaseDir,entry)=>spawn(join(releaseDir,'bin/node'),
   [join(releaseDir,'launch.mjs'),envFile,entry],{cwd:releaseDir,env:{},stdio:['ignore','pipe','pipe']});
  command=launch(oldReleaseDir,'deployments');worker=launch(oldReleaseDir,'deployments-paper-worker');
  let oldOutput='';for(const child of [command,worker]){
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.stdout.on('data',chunk=>{oldOutput+=chunk;});child.stderr.on('data',chunk=>{oldOutput+=chunk;});
  }
  await waitFor(()=>command.exitCode!==null?Promise.reject(Error('predecessor command exited: '+safeError(oldOutput))):
   fetch(`${sealedOrigin}/healthz`).then(response=>response.status===200).catch(()=>false),
   'predecessor sealed command health',30_000);
  await waitFor(()=>store.paperOperationWorkerReady(),'predecessor sealed worker readiness',30_000,
   detail=>phase('waiting_for_predecessor_worker',{campaignId,...detail}));
  phase('predecessor_sealed_release_observing',{campaignId,buildId:oldRelease.buildId,origin:sealedOrigin});
  const oldObservation=await waitFor(async()=>{
   const row=(await admin.query(`SELECT id::text,provenance->>'classification' AS classification
    FROM deployment_marks WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[campaignId])).rows[0];
   return row&&BigInt(row.id)>BigInt(beforeEpoch.previousMark.id)&&row.classification==='rangekeeper_paper_mark_v1'?row:null;
  },'predecessor sealed observation before adoption',180_000,
   detail=>phase('waiting_for_predecessor_observation',{campaignId,...detail}));
  phase('predecessor_sealed_observation_recorded',{campaignId,markId:oldObservation.id,
   classification:oldObservation.classification});
  await stop(worker);worker=null;
  await waitFor(async()=>!(await store.paperOperationWorkerReady()),'predecessor worker lease release',30_000);
  await stop(command);command=null;
  process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(from);
  beforeEpoch=await store.rangeKeeperPaperEpochSnapshot(campaignId);
 }
 const compatibilityProof={schemaVersion:1,kind:'rangekeeper_paper_runtime_compatibility_v1',
  fromBuildId:from.buildId,toBuildId:target.buildId,strategyId:'rangekeeper_v1',
  configHash:base.config_hash,profileHash:base.profile_hash,
  openModelHash:contentHash(beforeEpoch.openMark.model),historicalKernelBuildId:beforeEpoch.openMark.model.kernelBuildId,
  latestMarkHash:beforeEpoch.previousMark.markHash,validatorVersion:'rangekeeper-paper-epoch-v1'};
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(target);
 const adoption=alreadyAdopted?{adoptionHash:priorAdoption.adoptionHash,replayed:true}:
  await store.adoptRangeKeeperPaperRuntime({campaignId,actor:'clone_harness',
  fromRuntimeIdentity:from,toRuntimeIdentity:target,expectedLatestMark:beforeEpoch.previousMark,
  releaseProof:oldProof,compatibilityProof,
  verifyPinnedRelease:async(identity,proof)=>{
   assert.equal(identity.buildId,oldRelease.buildId);assert.equal(proof.filesHash,contentHash(oldRelease.files));
   const current=verifyRelease(oldReleaseDir);assert.equal(current.buildId,identity.buildId);
  },verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(rpc,chainId,sources)});
 phase(sealedMode?'sealed_runtime_adoption_appended':'historical_runtime_adoption_appended',
  {campaignId,adoptionHash:adoption.adoptionHash,
  replayed:adoption.replayed,previousEpoch:beforeEpoch.currentEpoch,latestMarkId:beforeEpoch.previousMark.id});

 let port;
 if(sealedMode)port=Number(dotenv.DEPLOYMENT_PORT??4174);
 else{
  const probe=createTcpServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  port=probe.address().port;await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
 }
 const origin=sealedMode?sealedOrigin:`http://127.0.0.1:${port}`,baseEnv={...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,
  ROBINHOOD_READ_HTTP_URL:readRpc,PAPER_FORK_RPC_URL:forkRpc,INDEXER_STREAM_KEY:streamKey,DEPLOYMENT_HOST:'127.0.0.1',
  DEPLOYMENT_PORT:String(port),DASHBOARD_HOST:'127.0.0.1',DASHBOARD_PORT:String(port+1),
  CONC_LIQ_RUNTIME_IDENTITY:JSON.stringify(target),DEPLOYMENT_RPC_TIMEOUT_MS:'20000',
  DEPLOYMENT_PAPER_SETUP_DIAGNOSTICS:'1'},workerEnv={...baseEnv,
  DEPLOYMENT_PAPER_OPERATION_WORKER:'1',DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',
  DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'1',DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'1',
  DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4'};
 let commandOutput='',workerOutput='',workerRemainder='';const automaticFailures=[];
 const captureWorkerEvents=chunk=>{
  workerOutput+=chunk;workerRemainder+=chunk;
  const lines=workerRemainder.split(/\r?\n/);workerRemainder=lines.pop()??'';
  for(const line of lines){
   let event;try{event=JSON.parse(line);}catch{continue;}
   const name=event.event??event.name;
   if(!['rangekeeper_paper_automatic_failed','rangekeeper_paper_automatic_pass',
    'paper_worker_campaign_failed'].includes(name))continue;
   const safe={event:name};
   for(const key of ['stage','status','reason','cause','sourceBlock','markId'])
    if(typeof event[key]==='string'&&event[key].length<=160)safe[key]=event[key];
   if(name==='rangekeeper_paper_automatic_failed'){
    automaticFailures.push({stage:safe.stage??'',reason:safe.reason??''});
    if(automaticFailures.length>3)automaticFailures.shift();
   }
   phase('paper_worker_diagnostic',safe);
  }
 };
 const startCommand=()=>{
  command=sealedMode?spawn(join(targetReleaseDir,'bin/node'),
   [join(targetReleaseDir,'launch.mjs'),envFile,'deployments'],
   {cwd:targetReleaseDir,env:{},stdio:['ignore','pipe','pipe']}):
   spawn(process.execPath,['--import','tsx','src/deployments.ts'],
    {cwd:process.cwd(),env:baseEnv,stdio:['ignore','pipe','pipe']});
  command.stdout.setEncoding('utf8');command.stderr.setEncoding('utf8');
  command.stdout.on('data',chunk=>commandOutput+=chunk);command.stderr.on('data',chunk=>commandOutput+=chunk);
 };
 const startWorker=async()=>{
  worker=sealedMode?spawn(join(targetReleaseDir,'bin/node'),
   [join(targetReleaseDir,'launch.mjs'),envFile,'deployments-paper-worker'],
   {cwd:targetReleaseDir,env:{},stdio:['ignore','pipe','pipe']}):
   spawn(process.execPath,['--import','tsx','src/deployments-paper-worker.ts'],
    {cwd:process.cwd(),env:workerEnv,stdio:['ignore','pipe','pipe']});
  worker.stdout.setEncoding('utf8');worker.stderr.setEncoding('utf8');
  worker.stdout.on('data',captureWorkerEvents);worker.stderr.on('data',captureWorkerEvents);
  try{await waitFor(()=>store.paperOperationWorkerReady(),'paper worker readiness',30_000);}
  catch(error){phase('paper_worker_startup_failure',{reason:safeError(error),
   outputTail:safeError(workerOutput.slice(-1_200))});throw error;}
 };
 startCommand();
 await waitFor(async()=>{
  if(command.exitCode!==null)throw Error(`Command server exited: ${safeError(commandOutput)}`);
  return fetch(origin+'/healthz').then(response=>response.status===200).catch(()=>false);
 },'command API health',30_000);
 await startWorker();phase('clone_command_and_worker_ready',{campaignId,origin,exitKind});
 const adoptedEpoch=await store.rangeKeeperPaperEpochSnapshot(campaignId);
 assert.equal(adoptedEpoch.currentEpoch,beforeEpoch.currentEpoch);
 assert.equal(adoptedEpoch.openMark.id,beforeEpoch.openMark.id,'adoption changed immutable open baseline');
 assert.equal(adoptedEpoch.previousMark.id,beforeEpoch.previousMark.id,'adoption changed latest mark');
 const recentered=await waitFor(async()=>{
  if(automaticFailures.length===3)throw Error(`repeated automatic recenter failure: ${JSON.stringify(automaticFailures)}`);
  const latest=(await admin.query(`SELECT id::text,inventory,economics,provenance,source_block::text,source_hash
   FROM deployment_marks WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[campaignId])).rows[0];
  return latest?.provenance?.classification==='rangekeeper_paper_recenter_v1'?latest:null;
 },'canonical automatic recenter after real observations',600_000,
 detail=>phase('waiting_for_fresh_canonical_recenter',{campaignId,...detail}));
 phase('canonical_recenter_recorded',{campaignId,markId:recentered.id,epoch:recentered.provenance.epoch,
  previousEpoch:recentered.provenance.previousEpoch,sourceBlock:recentered.source_block});
 const recenteredHash=contentHash(recentered);
 await stop(worker);worker=null;
 await waitFor(async()=>!(await store.paperOperationWorkerReady()),'worker readiness lease release',30_000);
 const stableBeforeRestart=await store.rangeKeeperPaperEpochSnapshot(campaignId);
 assert.equal(stableBeforeRestart.currentEpoch,recentered.provenance.epoch);
 assert.equal(stableBeforeRestart.openMark.id,beforeEpoch.openMark.id,'recenter changed immutable open mark');
 assert(BigInt(stableBeforeRestart.previousMark.id)>=BigInt(recentered.id),
  'worker stop rewound the latest mark behind the recenter');
 const preservedRecenter=(await admin.query(`SELECT id::text,inventory,economics,provenance,
  source_block::text,source_hash FROM deployment_marks WHERE id=$1 AND campaign_id=$2`,
  [recentered.id,campaignId])).rows[0];
 assert(preservedRecenter&&contentHash(preservedRecenter)===recenteredHash,
  'graceful worker stop changed the persisted recenter mark');
 await startWorker();
 const afterRestart=await store.rangeKeeperPaperEpochSnapshot(campaignId);
 assert.equal(afterRestart.openMark.id,beforeEpoch.openMark.id,'worker restart changed immutable open mark');
 assert(BigInt(afterRestart.previousMark.id)>=BigInt(stableBeforeRestart.previousMark.id),
  'worker restart rewound the latest epoch mark');
 assert.equal(afterRestart.currentEpoch,stableBeforeRestart.currentEpoch,'worker restart reset recenter epoch');
 const preservedAfterRestart=(await admin.query(`SELECT id::text,inventory,economics,provenance,
  source_block::text,source_hash FROM deployment_marks WHERE id=$1 AND campaign_id=$2`,
  [recentered.id,campaignId])).rows[0];
 assert(preservedAfterRestart&&contentHash(preservedAfterRestart)===recenteredHash,
  'worker restart changed the persisted recenter mark');
 phase('worker_restart_continuity_verified',{campaignId,currentEpoch:afterRestart.currentEpoch,
  openMarkId:afterRestart.openMark.id,latestMarkId:afterRestart.previousMark.id,
  recenterMarkId:recentered.id,historicalMarksPreserved:true});

 browser=await startCanonicalPaperBrowser({origin});
 await browser.login();await selectCampaignInPositions(browser,campaignId);
 const action=await acceptPositionsAction(browser,campaignId,
  exitKind==='retain'?'rangekeeper_close_retain':'rangekeeper_close_convert',
  {previewTimeoutMs:600_000});
 const acceptedPath=`/api/deployments/${campaignId}/rangekeeper/close-operations`;
 assert(action.posts.some(row=>row.path===acceptedPath),'browser did not submit strategy-aware RK close acceptance');
 assert.equal(action.acceptedResponse.httpStatus,202);
 const operationId=action.acceptedResponse.id;
 phase('browser_exit_accepted_on_clone',{campaignId,operationId,exitKind,
  previewAttempts:action.previewAttempts});
 await waitFor(async()=>{
  const row=(await admin.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[campaignId])).rows[0];
  const operation=(await admin.query('SELECT status FROM deployment_operations WHERE id=$1',[operationId])).rows[0];
  return row?.lifecycle==='closed'&&operation?.status==='succeeded';
 },'accepted RangeKeeper exit completion',600_000,
 detail=>phase('waiting_for_exit_worker_completion',{campaignId,operationId,...detail}));
 const rows=await readDeploymentRows(admin),closed=rows.find(row=>row.id===campaignId);
 assert(closed&&closed.lifecycle==='closed');
 const history=await readDeploymentDetail(admin,closed,0);
 assert(history.performance.timeline.some(point=>point.action==='exit'),
  'shared dashboard history must contain the completed exit');
 assert.equal(history.position.navQuote,null,'final economic value must remain unavailable');
 const view=await inspectPositionAtWidths(browser,campaignId,['close_retain','close_convert'],
  {history:true,expectedGapLabels:['unavailable']});
 await assertBrowserHealthy(browser);
 phase('clone_lifecycle_complete',{campaignId,operationId,exitKind,
  currentEpoch:afterRestart.currentEpoch,desktop:!!view.desktop,mobile:!!view.mobile,
  historicalMarksPreserved:true});
}catch(error){
 process.stderr.write(`${safeError(error)}\n`);process.exitCode=1;
}finally{
 if(browser)try{await browser.cleanup();}catch(error){process.stderr.write(`${safeError(error)}\n`);process.exitCode=1;}
 try{await stop(worker);}catch(error){process.stderr.write(`${safeError(error)}\n`);process.exitCode=1;}
 try{await stop(command);}catch(error){process.stderr.write(`${safeError(error)}\n`);process.exitCode=1;}
 admin?.release();await store?.close().catch(()=>{});await adminPool?.end().catch(()=>{});
}
