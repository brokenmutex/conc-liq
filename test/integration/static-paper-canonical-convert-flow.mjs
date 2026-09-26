// Canonical static/manual setup -> UI open -> UI convert-close acceptance.
// Deployment writes use a temporary PostgreSQL schema; canonical replay reads
// use the public indexer in read-only mode. No draft is manually inserted.
// Run: TEST_DATABASE_URL=... node --import tsx test/integration/static-paper-canonical-convert-flow.mjs
// Recovery: add --interrupt-conversion to suspend/kill/restart the real worker.
// Sealed mode: --sealed-release requires TEST_SEALED_RELEASE_DIR and TEST_EXPECTED_RELEASE_COMMIT.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {parseEnv} from 'node:util';
import {readFileSync,readdirSync,readlinkSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer as createTcpServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {hash as releaseHash,verifyRelease} from '../../scripts/release-files.mjs';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore,PAPER_OPERATION_READINESS_LOCK} from '../../src/deployments/store.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {marketProfileSchema,verifyMarketProfile} from '../../src/deployments/market-profile.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {PAPER_CONVERSION_ACCOUNTING_POLICY_V2,PAPER_CONVERSION_ACCOUNTING_POLICY_V3,
 paperConversionAccountingV2Schema} from '../../src/deployments/paper-accounting.ts';
import {readCanonicalPaperFeeInterval} from '../../src/deployments/paper-fee-replay.ts';
import {paperPreparationLockName} from '../../src/deployments/paper-preparation-lease.ts';
import {readDeploymentRows,deploymentPosition,readDeploymentDetail} from '../../src/dashboard/deployment-position.ts';
import {startCanonicalPaperBrowser,createDraftAndAcceptOpen,acceptPositionsAction,
 inspectPositionAtWidths,selectCampaignInPositions,assertBrowserHealthy}
 from './helpers/canonical-paper-browser.mjs';
import {suspendPaperWorker,killSuspendedPaperWorker} from './helpers/paper-worker-interruption.mjs';
import {rehearseStaticPaperSchemaRestore} from './helpers/static-paper-schema-restore.mjs';
import {startProxy} from './helpers/paper-anchor-rpc-proxy.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const phase=(name,details={})=>process.stdout.write(JSON.stringify({phase:name,...details})+'\n');
const clean=value=>String(value??'').replace(/https?:\/\/[^\s"']+/gi,'[redacted-url]');
const setupDiagnosticEvents=[];let setupDiagnosticSequence=0;
const commandLineBuffer={command:{stdout:'',stderr:''},worker:{stdout:'',stderr:''}};
const isLocalDb=raw=>{const url=new URL(raw),socket=url.searchParams.get('host');
 return ['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname.toLowerCase())||
  Boolean(socket&&socket.startsWith('/'));};
const waitFor=async(read,label,timeoutMs=360_000)=>{
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){const value=await read();if(value)return value;await sleep(500);}
 throw Error(`Timed out waiting for ${label}`);
};
const procSnapshot=(child,reviewedReleaseRoot=null)=>{
 let state='unavailable',wchan='unavailable';
 let userCpuTicks=null,systemCpuTicks=null,io={rchar:null,readBytes:null,syscr:null};
 try{const stat=readFileSync(`/proc/${child.pid}/stat`,'utf8');
  const fields=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/);
  state=fields[0]??'unavailable';userCpuTicks=fields[11]??null;systemCpuTicks=fields[12]??null;
 }catch{}
 try{wchan=readFileSync(`/proc/${child.pid}/wchan`,'utf8').trim()||'unavailable';}catch{}
 try{const rows=readFileSync(`/proc/${child.pid}/io`,'utf8').split('\n');
  for(const row of rows){const [key,value]=row.split(':').map(part=>part.trim());
   if(key==='rchar')io.rchar=value??null;if(key==='read_bytes')io.readBytes=value??null;
   if(key==='syscr')io.syscr=value??null;}
 }catch{}
 const openReleaseFiles=new Set(),otherFdKinds={socket:0,pipe:0,anon:0,external:0,other:0};
 let fdCount=null,inspectedFdCount=0,fdInspectionTruncated=false;
 if(reviewedReleaseRoot){
  const root=`${resolve(reviewedReleaseRoot)}/`;
  try{const descriptors=readdirSync(`/proc/${child.pid}/fd`).sort((a,b)=>Number(a)-Number(b));
   fdCount=descriptors.length;inspectedFdCount=Math.min(fdCount,128);
   fdInspectionTruncated=fdCount>inspectedFdCount;
   for(const fd of descriptors.slice(0,inspectedFdCount)){
   let target='';try{target=readlinkSync(`/proc/${child.pid}/fd/${fd}`);}catch{continue;}
   const cleanTarget=target.endsWith(' (deleted)')?target.slice(0,-10):target;
   if(cleanTarget.startsWith(root))openReleaseFiles.add(cleanTarget.slice(root.length).slice(0,240));
   else if(cleanTarget.startsWith('socket:['))otherFdKinds.socket++;
   else if(cleanTarget.startsWith('pipe:['))otherFdKinds.pipe++;
   else if(cleanTarget.startsWith('anon_inode:'))otherFdKinds.anon++;
   else if(cleanTarget.startsWith('/'))otherFdKinds.external++;
   else otherFdKinds.other++;
  }}catch{}
 }
 return {state,wchan,userCpuTicks,systemCpuTicks,io,
  fdCount,inspectedFdCount,fdInspectionTruncated,
  openReleaseFiles:[...openReleaseFiles].sort().slice(0,16),otherFdKinds};
};
const reservePort=async()=>{
 const server=createTcpServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 return port;
};
const processExited=child=>child.exitCode!==null||child.signalCode!==null;
const waitProcessExit=(child,timeoutMs)=>new Promise(resolve=>{
 if(processExited(child)){resolve(true);return;}
 const finish=value=>{clearTimeout(timer);child.off('exit',onExit);resolve(value);},
  onExit=()=>finish(true),timer=setTimeout(()=>finish(false),timeoutMs);
 child.once('exit',onExit);
});
const stopProcess=async child=>{
 if(!child||processExited(child))return;
 child.kill('SIGTERM');
 if(await waitProcessExit(child,5000))return;
 child.kill('SIGKILL');
 assert(await waitProcessExit(child,5000),'child process did not exit after SIGKILL');
};
const formatAmount=(raw,decimals,digits=6)=>new Intl.NumberFormat('en-US',{
 minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Number(BigInt(raw))/10**decimals);
const formatUsd6=raw=>new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
 .format(Number(BigInt(raw))/1e6);
const passwordHash=password=>{const salt=randomBytes(16);
 return `scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;};
const processTail={command:'',worker:''};

async function main(){
 assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
 assert(isLocalDb(process.env.TEST_DATABASE_URL),'TEST_DATABASE_URL must use local PostgreSQL');
 const sealed=process.argv.includes('--sealed-release'),interrupt=process.argv.includes('--interrupt-conversion'),
  restoreRehearsal=process.argv.includes('--restore-rehearsal'),
  changedRestartAnchor=process.argv.includes('--changed-restart-anchor');
 assert(!changedRestartAnchor||interrupt,'--changed-restart-anchor requires --interrupt-conversion');
 assert(!changedRestartAnchor||!restoreRehearsal,
  'changed-anchor negative recovery is not eligible for closed-campaign restore rehearsal');
 assert.equal(Boolean(process.env.TEST_SEALED_RELEASE_DIR),sealed,
  'set TEST_SEALED_RELEASE_DIR only with --sealed-release');
 const releaseRoot=sealed?resolve(process.env.TEST_SEALED_RELEASE_DIR):null,
  manifest=releaseRoot?verifyRelease(releaseRoot):null;
 if(sealed){
  assert.match(process.env.TEST_EXPECTED_RELEASE_COMMIT??'',/^[0-9a-f]{40}$/i,
   'sealed conversion requires TEST_EXPECTED_RELEASE_COMMIT');
  assert.equal(manifest.sourceCommit,process.env.TEST_EXPECTED_RELEASE_COMMIT,
   'release source commit mismatch');
 }
 const dotenv=parseEnv(readFileSync('.env','utf8')),
  archive=dotenv.RH_ARCHIVE_RPC_URL??dotenv.ROBINHOOD_READ_HTTP_URL,
  readRpc=dotenv.ROBINHOOD_READ_HTTP_URL??archive,
  stream=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
 assert(archive&&readRpc,'canonical archive/read RPC configuration is unavailable');
 const rpc=createRobinhoodClient(readRpc,20_000,{retryCount:0}),rawProfile=parseRangeKeeperConfig(
  JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8'))),
  profile=marketProfileSchema.parse({pool:{...rawProfile.pool,factory:UNISWAP_V3_FACTORY,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER},
   referencePolicy:rawProfile.referencePolicy}),
  adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),
  admin=await adminPool.connect(),schema=`static_convert_browser_${randomUUID().replaceAll('-','')}`;
 let store,indexer,command,worker,browser,runtimeDir,campaignId,rpcProxy,proxyClient,
  runtimeApplicationName=null,runtimeDatabaseBackends=null,
  openOperationId,convertOperationId,interruption=null,runtimeEnvFile=null,accountingIdentity=null;
 const checks=[];let runtimeEnvSha256=null,initialWorkerEnvFile=null;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
  await migrateDatabase(admin);
  // Isolated migration mirrors must not shadow the canonical public replay.
  await admin.query('DROP TABLE v3_replay_positions,v3_replay_cursors,v3_replay_ticks,'+
   'v3_replay_pools,v3_pool_events CASCADE');
  const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
  scopedUrl.searchParams.set('options',`-c search_path=${schema},public -c statement_timeout=30000`);
  runtimeApplicationName=`paper-mvp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const deploymentUrl=scopedUrl.toString(),runtimeUrl=new URL(deploymentUrl);
  runtimeUrl.searchParams.set('application_name',runtimeApplicationName);
  const runtimeDatabaseUrl=runtimeUrl.toString();
  store=new DeploymentStore(deploymentUrl);await store.assertReady();
  const replayUrl=new URL(process.env.TEST_DATABASE_URL);
  replayUrl.searchParams.set('options',`-c default_transaction_read_only=on -c search_path=${schema},public`);
  indexer=new pg.Pool({connectionString:replayUrl.toString(),max:3,statement_timeout:30_000});
  const sourceSettings=(await indexer.query(`SELECT current_setting('default_transaction_read_only') AS read_only,
   current_setting('search_path') AS search_path`)).rows[0];
  assert.equal(sourceSettings.read_only,'on');
  assert(sourceSettings.search_path.includes(schema)&&sourceSettings.search_path.includes('public'),
   `read-only replay search path must be isolated temp schema plus public: ${sourceSettings.search_path}`);
  runtimeDatabaseBackends=async()=>{
   const rows=(await admin.query(`SELECT pid,state,wait_event_type,wait_event,
    xact_start::text AS xact_start,query_start::text AS query_start,pg_blocking_pids(pid) AS blocking_pids
    FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1
     AND pid<>pg_backend_pid() ORDER BY pid`,[runtimeApplicationName])).rows.map(row=>({
      pid:Number.isInteger(row.pid)?row.pid:null,
      state:['active','idle','idle in transaction','idle in transaction (aborted)',
       'fastpath function call','disabled'].includes(row.state)?row.state:null,
      waitEventType:typeof row.wait_event_type==='string'&&/^[a-z_]{1,32}$/i.test(row.wait_event_type)?
       row.wait_event_type:null,
      waitEvent:typeof row.wait_event==='string'&&/^[a-z0-9_]{1,80}$/i.test(row.wait_event)?row.wait_event:null,
      xactStart:typeof row.xact_start==='string'?row.xact_start.slice(0,48):null,
      queryStart:typeof row.query_start==='string'?row.query_start.slice(0,48):null,
      blockingPids:Array.isArray(row.blocking_pids)?row.blocking_pids.filter(Number.isInteger):[]
     }));
   return {quiescent:rows.length>0&&rows.every(row=>row.state==='idle'&&row.xactStart===null),
    backendCount:rows.length,backends:rows};
  };
  const identityRows=(await indexer.query(`SELECT r.chain_id::int,p.fee,r.target_set_hash,
   r.complete_through_block::text,r.complete_through_hash FROM v3_replay_cursors r
   JOIN v3_replay_pools p USING(stream_key) WHERE r.stream_key=$1 AND
   lower(p.pool_address)=lower($2) AND p.initialized=true`,[stream,profile.pool.pool])).rows;
  assert.equal(identityRows.length,1,'canonical public replay pool is unavailable');
  const replayIdentity=identityRows[0];
  assert.equal(replayIdentity.chain_id,profile.pool.chainId);assert.equal(replayIdentity.fee,profile.pool.fee);
   assert(/^0x[0-9a-f]{64}$/i.test(replayIdentity.target_set_hash),'canonical target-set hash missing');
  const verified=await verifyMarketProfile(rpc,profile,stream),risk=profile.pool.quoteToken===0?
   profile.pool.token1:profile.pool.token0;
  const indexerInsert=await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,
   rwa_symbol,rwa_address,fee,created_block,target_set_hash,enabled)
   VALUES($1,$2,$3,'AAPL',$4,$5,1,$6,true)`,
   [stream,profile.pool.pool,profile.pool.chainId,risk,profile.pool.fee,replayIdentity.target_set_hash]);
  assert.equal(indexerInsert.rowCount,1);
  const registered=await store.registerVerifiedMarketProfile(verified);
  assert.equal(registered.created,true);assert.equal((await store.paperSetupProfile(registered.id)).profileHash,
   contentHash(profile));checks.push('real registered profile and canonical public replay identity bound in temporary schema');
  const password=`static-convert-${randomUUID()}`,hash=passwordHash(password),
   commandPort=await reservePort(),dashboardPort=await reservePort(),origin=`http://127.0.0.1:${commandPort}`,
   identity={buildId:contentHash({kind:'canonical-convert-browser',pid:process.pid}),
    configHash:contentHash({kind:'isolated-canonical-convert-browser'}),nodeVersion:process.version};
  accountingIdentity=identity;
  const env={...process.env,DATABASE_URL:runtimeDatabaseUrl,DEPLOYMENT_OPERATOR_PASSWORD_HASH:hash,
   DEPLOYMENT_HOST:'127.0.0.1',DEPLOYMENT_PORT:String(commandPort),ROBINHOOD_READ_HTTP_URL:archive,
   PAPER_FORK_RPC_URL:archive,DEPLOYMENT_RPC_TIMEOUT_MS:'20000',INDEXER_STREAM_KEY:stream,
   DEPLOYMENT_PAPER_OPERATION_WORKER:'1',DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',
   DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'2',DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'4',
   DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4',DASHBOARD_HOST:'127.0.0.1',
   DASHBOARD_PORT:String(dashboardPort),ADAPTIVE_PAPER_STATE_PATH:`${tmpdir()}/absent-${randomUUID()}.json`,
   CONC_LIQ_RUNTIME_IDENTITY:JSON.stringify(identity)};
  if(changedRestartAnchor){rpcProxy=await startProxy({rpcUrl:archive});
   proxyClient=createRobinhoodClient(rpcProxy.url,20_000,{retryCount:0});
   phase('changed_anchor_proxy_started');}
  const startSealed=(entry,extraEnv={})=>spawn(join(releaseRoot,'bin/node'),
   [join(releaseRoot,'launch.mjs'),runtimeEnvFile,entry],
   {cwd:releaseRoot,env:{PATH:'/usr/bin:/bin',HOME:runtimeDir,...extraEnv},stdio:['ignore','pipe','pipe']});
  const launch=(entry,extraEnv={})=>sealed?startSealed(entry==='deployments'?'deployments':'deployments-paper-worker',extraEnv):
   spawn(process.execPath,['--import','tsx',entry==='deployments'?'src/deployments.ts':'src/deployments-paper-worker.ts'],
   {cwd:process.cwd(),env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
  if(sealed){
   runtimeDir=await mkdtemp(`${tmpdir()}/conc-liq-convert-runtime-`);
   runtimeEnvFile=join(runtimeDir,'runtime.env');
   const sealedRuntimeEnv={DATABASE_URL:runtimeDatabaseUrl,
    DEPLOYMENT_OPERATOR_PASSWORD_HASH:hash,DEPLOYMENT_HOST:'127.0.0.1',
    DEPLOYMENT_PORT:String(commandPort),ROBINHOOD_READ_HTTP_URL:changedRestartAnchor?rpcProxy.url:archive,
    PAPER_FORK_RPC_URL:archive,
    DEPLOYMENT_RPC_TIMEOUT_MS:'20000',INDEXER_STREAM_KEY:stream,
    DEPLOYMENT_PAPER_OPERATION_WORKER:'1',DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',
    DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'2',DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'4',
    DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4',DASHBOARD_HOST:'127.0.0.1',
    DASHBOARD_PORT:String(dashboardPort),ADAPTIVE_PAPER_STATE_PATH:`${runtimeDir}/absent-adaptive.json`,
    ...(process.env.DEPLOYMENT_PAPER_SETUP_DIAGNOSTICS==='1'?
     {DEPLOYMENT_PAPER_SETUP_DIAGNOSTICS:'1'}:{})};
   await writeFile(runtimeEnvFile,Object.entries(sealedRuntimeEnv).map(([key,value])=>
    `${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});
   const parsedSealedRuntimeEnv=parseEnv(readFileSync(runtimeEnvFile,'utf8'));
   accountingIdentity={buildId:manifest.buildId,
    configHash:releaseHash(JSON.stringify(Object.fromEntries(Object.entries(parsedSealedRuntimeEnv)
     .sort(([a],[b])=>a.localeCompare(b,'en'))))),nodeVersion:manifest.nodeVersion};
   runtimeEnvSha256=createHash('sha256').update(readFileSync(runtimeEnvFile)).digest('hex');
  }
  const capture=(child,key)=>{child.__safeCapture={pid:child.pid,stdoutBytes:0,stderrBytes:0,
    spawnError:null,exitCode:null,signalCode:null};
   child.on('error',error=>{child.__safeCapture.spawnError={name:/^[A-Za-z]+Error$/.test(error?.name??'')?
    error.name:'Error',code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,60}$/i.test(error.code)?error.code:null};});
   child.on('exit',(code,signal)=>{child.__safeCapture.exitCode=code;child.__safeCapture.signalCode=signal;});
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   const append=(source,chunk)=>{
    child.__safeCapture[`${source}Bytes`]+=Buffer.byteLength(chunk,'utf8');
    processTail[key]=(processTail[key]+chunk).slice(-8000);
    if(key!=='command')return;
    const lines=(commandLineBuffer.command[source]+chunk).split('\n');
    commandLineBuffer.command[source]=lines.pop()??'';
    for(const line of lines){
     try{const row=JSON.parse(line);
      if(row.event==='paper_setup_preparation_diagnostic'&&typeof row.stage==='string'&&
       /^[a-z0-9_]{1,80}$/.test(row.stage)&&typeof row.reason==='string'&&
       (/^paper_[a-z0-9_]{1,120}$/.test(row.reason)||/^[A-Za-z]+Error$/.test(row.reason))){
       setupDiagnosticEvents.push({sequence:++setupDiagnosticSequence,stage:row.stage,reason:row.reason});
       if(setupDiagnosticEvents.length>32)setupDiagnosticEvents.shift();
      }
     }catch{}
    }
   };
   child.stdout.on('data',chunk=>append('stdout',chunk));
   child.stderr.on('data',chunk=>append('stderr',chunk));};
  command=launch('deployments');capture(command,'command');
  await waitFor(async()=>await fetch(origin+'/healthz').then(response=>response.status===200).catch(()=>false),
   'real command service health',60_000);phase('command_ready');
  const workerRpcEnv=changedRestartAnchor&&!sealed?{ROBINHOOD_READ_HTTP_URL:rpcProxy.url}:{};
  worker=launch('worker',workerRpcEnv);capture(worker,'worker');
  initialWorkerEnvFile=runtimeEnvFile;
  phase('worker_spawned',{pid:worker.pid,launcherEntry:sealed?'deployments-paper-worker':
   'src/deployments-paper-worker.ts',runtimeEnvSha256,sameRuntimeEnvFile:sealed?true:null,
   runtimeIdentity:accountingIdentity});
  const workerReady=()=>store.paperOperationWorkerReady();
  const workerReadinessFailure=async(child,startedAt,procSamples)=>{
   let lockRows=[],recentBackends=[],postgresDiagnosticError=null;
   try{
    lockRows=(await admin.query(`SELECT a.pid,a.state,a.wait_event_type,a.wait_event,l.mode,l.granted
     FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE l.locktype='advisory'
      AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=2`,
     [...PAPER_OPERATION_READINESS_LOCK])).rows;
    recentBackends=(await admin.query(`SELECT pid,state,wait_event_type,wait_event,backend_type,
      backend_start::text FROM pg_stat_activity WHERE datname=current_database()
      AND backend_type='client backend' AND backend_start >= $1 ORDER BY pid LIMIT 32`,
     [new Date(startedAt)])).rows;
   }catch(error){postgresDiagnosticError={name:error?.name??'Error',
    code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,60}$/i.test(error.code)?error.code:null};}
   let readinessLease=null,readinessProbeError=null;
   try{readinessLease=await workerReady();}catch(error){readinessProbeError={name:error?.name??'Error',
    code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,60}$/i.test(error.code)?error.code:null};}
   return {process:{...child.__safeCapture,...procSnapshot(child,releaseRoot),elapsedMs:Date.now()-startedAt},
    procSamples,
    readinessLease,readinessProbeError,
    postgres:{readinessLockHolders:lockRows,recentBackends,diagnosticError:postgresDiagnosticError}};
  };
  const waitForWorkerReady=async(child,label,timeoutMs=30_000)=>{
   const startedAt=Date.now(),deadline=startedAt+timeoutMs,procSamples=[];let nextProcSample=startedAt;
   while(Date.now()<deadline){
    if(Date.now()>=nextProcSample){
     if(procSamples.length>=16)procSamples.shift();
     procSamples.push({elapsedMs:Date.now()-startedAt,...procSnapshot(child,releaseRoot)});
     nextProcSample=Date.now()+2_000;
    }
    let ready=false,probeError=null;
    try{ready=await workerReady();}catch(error){probeError={name:error?.name??'Error',
     code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,60}$/i.test(error.code)?error.code:null};}
    if(child.__safeCapture?.spawnError||processExited(child)){
     const diagnostics=await workerReadinessFailure(child,startedAt,procSamples);
     phase('worker_unavailable_before_readiness',{launcherEntry:sealed?'deployments-paper-worker':
      'src/deployments-paper-worker.ts',runtimeEnvSha256,sameRuntimeEnvFile:sealed?
       runtimeEnvFile===initialWorkerEnvFile:null,runtimeIdentity:accountingIdentity,...diagnostics,
      readinessProbeError:probeError});
     throw Error(`Worker exited or failed before ${label}: exitCode=${child.exitCode??'null'}, `+
      `signal=${child.signalCode??'none'}, spawnError=${child.__safeCapture?.spawnError?.code??
       child.__safeCapture?.spawnError?.name??'none'}`);
    }
    if(ready)return {elapsedMs:Date.now()-startedAt,procSamples};
    await sleep(250);
   }
   const diagnostics=await workerReadinessFailure(child,startedAt,procSamples);
   phase('worker_readiness_timeout',{launcherEntry:sealed?'deployments-paper-worker':
    'src/deployments-paper-worker.ts',runtimeEnvSha256,sameRuntimeEnvFile:sealed?
     runtimeEnvFile===initialWorkerEnvFile:null,runtimeIdentity:accountingIdentity,...diagnostics});
   throw Error(`Timed out waiting for ${label}: pid=${child.pid}, state=${diagnostics.process.state}, `+
    `elapsedMs=${diagnostics.process.elapsedMs}, stdoutBytes=${diagnostics.process.stdoutBytes}, `+
    `stderrBytes=${diagnostics.process.stderrBytes}`);
  };
  const initialWorkerReadiness=await waitForWorkerReady(worker,'real paper worker readiness lease');phase('worker_ready',{
   pid:worker.pid,launcherEntry:sealed?'deployments-paper-worker':'src/deployments-paper-worker.ts',
   runtimeEnvSha256,sameRuntimeEnvFile:sealed?runtimeEnvFile===initialWorkerEnvFile:null,
   runtimeIdentity:accountingIdentity,process:{...worker.__safeCapture,...procSnapshot(worker,releaseRoot),
    elapsedMs:initialWorkerReadiness.elapsedMs},procSamples:initialWorkerReadiness.procSamples});
  browser=await startCanonicalPaperBrowser({origin,password});
  const setup=await createDraftAndAcceptOpen(browser,{profilePool:profile.pool.pool,capital:'2'});
  campaignId=setup.campaignId;phase('browser_setup_and_open_accepted',
   {campaignId,capitalQuote:'2',halfWidthTicks:setup.halfWidthTicks});
  checks.push('operator UI performed authenticated canonical setup admission and open acceptance; no draft seeded');
  const getOperationId=async(kind)=>{
   const rows=await admin.query(`SELECT id::text FROM deployment_operations
    WHERE campaign_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1`,[campaignId,kind]);
   return rows.rows[0]?.id??null;
  };
  const preparationLeaseIsClear=async()=>{
   // Observe the exact session advisory lock used by conversion preparation.
   // This only delays a fresh UI preview while maintenance owns the lease; it
   // never acquires a lock or alters the evidence gate.
   const key=BigInt.asUintN(64,BigInt((await admin.query(
    'SELECT hashtextextended($1,0)::text AS value',[paperPreparationLockName(campaignId)])).rows[0].value));
   const high=Number((key>>32n)&0xffff_ffffn),low=Number(key&0xffff_ffffn);
   const row=(await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
     WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND granted) AS busy`,[high,low])).rows[0];
   return !row.busy;
  };
  const waitForPreparationLease=async({deadline})=>{
   while(Date.now()<deadline){if(await preparationLeaseIsClear()){
    phase('convert_preparation_lease_clear');return;}
    await sleep(Math.min(1_000,Math.max(1,deadline-Date.now())));
   }
  };
  openOperationId=await waitFor(()=>getOperationId('open'),'persisted UI open operation',30_000);
  const openTerminal=await waitFor(async()=>{const row=await store.operation(openOperationId);
   return ['succeeded','blocked','rejected','failed','cancelled'].includes(row?.status)?row:null;},
   'open worker completion',300_000);
  assert.equal(openTerminal.status,'succeeded',JSON.stringify(openTerminal));
  assert.equal(openTerminal.stage,'paper_open_recorded');phase('open_completed');
  const openCandidate=(await admin.query(`SELECT p.proposal->'paperOpenModel'->'candidate' AS candidate,
   p.proposal->'paperOpenModel'->'poolState'->>'poolLiquidity' AS pool_liquidity
   FROM deployment_marks m JOIN deployment_previews p ON p.id=(m.provenance->>'previewId')::uuid
   WHERE m.campaign_id=$1 AND m.provenance->>'classification'='paper_model_provisional'
   ORDER BY m.id LIMIT 1`,[campaignId])).rows[0];
  assert(openCandidate?.candidate,'saved open model candidate is unavailable');
  phase('open_candidate_share_evidence',{dilutedSharePpm:openCandidate.candidate.dilutedSharePpm,
   deployedValue:openCandidate.candidate.deployedValue,range:openCandidate.candidate.range,
   liquidity:openCandidate.candidate.liquidity,poolLiquidity:openCandidate.pool_liquidity});
  const opened=await waitFor(async()=>{try{
   const state=await store.paperValuationState(campaignId);
   return state.previous.source.block!==state.openModel.source.block?state:null;
  }catch{return null;}},'later canonical valuation after open',300_000);
  assert(opened.previous.markId);phase('later_valuation_saved',{block:opened.previous.source.block});
  checks.push('actual default worker recorded open and a later canonical principal valuation');

  let workerSuspension=null,acceptedModelSource=null;
  let conversionDiagnosticSequence=setupDiagnosticSequence;
  const beforePreviewRequest=async({deadline})=>{
   conversionDiagnosticSequence=setupDiagnosticSequence;
   await waitForFeeCarryAndAccounting({deadline});
  };
  const retryUnavailableReason=async({previewResponse,deadline})=>{
   if(previewResponse?.reason!=='static_manual_conversion_prestate_unavailable')return null;
   const probeUntil=Math.min(deadline,Date.now()+750);
   while(Date.now()<probeUntil){
    const event=setupDiagnosticEvents.find(item=>item.sequence>conversionDiagnosticSequence&&
     item.stage==='paper_conversion_prestate_fee_context'&&
     item.reason==='paper_close_convert_fee_interval_gap');
    if(event)return event.reason;
    await sleep(Math.min(50,Math.max(1,probeUntil-Date.now())));
   }
   return null;
  };
  const waitForFeeCarryAndAccounting=async({deadline})=>{
   let latestMarkId=null,feeEvidence=null,accountingMarkId=null;
   while(Date.now()<deadline){
    try{
     const carried=await store.readStaticPaperCloseConvertFeeCarry({campaignId,revision:1});
     latestMarkId=(await admin.query(`SELECT id::text FROM deployment_marks
      WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1`,[campaignId])).rows[0]?.id??null;
     feeEvidence=(await admin.query(`SELECT id::text,to_mark_id::text FROM deployment_paper_fee_evidence
      WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[campaignId])).rows[0]??null;
     const invalidated=(await admin.query(`SELECT EXISTS(SELECT 1 FROM deployment_paper_accounting_invalidations
      WHERE campaign_id=$1) AS found`,[campaignId])).rows[0]?.found;
     if(invalidated)throw Error('paper_conversion_accounting_history_invalidated');
     const priorV2Row=(await admin.query(`SELECT source_mark_id::text,fee_evidence_id::text,
      snapshot,snapshot_hash FROM deployment_paper_accounting
      WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
      [campaignId,latestMarkId,PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows[0]??null;
     let priorV2=null;
     if(priorV2Row){
      const parsed=paperConversionAccountingV2Schema.safeParse(priorV2Row.snapshot);
      assert(parsed.success,'latest V2 accounting snapshot failed its persisted schema');
      assert.equal(contentHash(parsed.data),priorV2Row.snapshot_hash,
       'latest V2 accounting snapshot hash changed');
      assert.equal(parsed.data.sourceMarkId,latestMarkId,'latest V2 accounting mark binding changed');
      assert.notEqual(parsed.data.markKind,'close_convert','latest V2 accounting already records a close');
      assert.deepEqual(parsed.data.runtimeIdentity,accountingIdentity,
       'latest V2 accounting runtime identity changed');
      priorV2={source_mark_id:priorV2Row.source_mark_id,
       fee_evidence_id:priorV2Row.fee_evidence_id};
     }
     if(priorV2&&carried.previous.markId===latestMarkId)
      assert.equal(priorV2.fee_evidence_id,carried.feeEvidence.id,
       'latest V2 accounting is bound to a different fee evidence row');
     accountingMarkId=priorV2?.source_mark_id??null;
     if(carried.previous.markId===latestMarkId&&accountingMarkId===latestMarkId&&
      priorV2.fee_evidence_id===carried.feeEvidence.id&&
      await preparationLeaseIsClear()){
      phase('convert_fee_carry_readiness_confirmed',{latestMarkId,
       feeEvidenceId:feeEvidence?.id??null,feeEvidenceToMarkId:feeEvidence?.to_mark_id??null,
       accountingMarkId,priorV2FeeEvidenceId:priorV2.fee_evidence_id,
       throughBlock:carried.previous.source.block,intervals:carried.feeCarry.intervals});
      return;
     }
    }catch(error){if(error?.code!=='paper_close_convert_fee_interval_gap')throw error;}
    await sleep(Math.min(1_000,Math.max(1,deadline-Date.now())));
   }
   phase('convert_fee_carry_readiness_timeout',{latestMarkId,feeEvidence,accountingMarkId});
   throw Error('Timed out waiting for persisted paper fee carry and accounting through latest mark');
  };
  const convert=await acceptPositionsAction(browser,campaignId,'close_convert',{
   previewTimeoutMs:300_000,dropAcceptedResponse:interrupt,
   onPreviewRetry:info=>phase('convert_preview_retry',info),
   beforePreviewRequest,retryUnavailableReason,
   waitBeforePreviewRetry:async({deadline,reason})=>{
    if(reason==='paper_close_convert_fee_interval_gap')await waitForFeeCarryAndAccounting({deadline});
    await waitForPreparationLease({deadline});
   },beforeAccept:async({previewResponse})=>{
    if(changedRestartAnchor){
     assert(previewResponse?.previewId,'convert preview response did not expose its saved id');
     const savedPreview=await admin.query(`SELECT proposal FROM deployment_previews
      WHERE id=$1 AND campaign_id=$2`,[previewResponse.previewId,campaignId]);
     assert.equal(savedPreview.rowCount,1,'UI convert preview must be saved before fault setup');
     const model=savedPreview.rows[0].proposal.paperCloseConvertTerminalV3;
     assert(model?.source?.block&&model?.source?.hash,'saved V3 model has no canonical source anchor');
     acceptedModelSource={block:String(model.source.block),hash:String(model.source.hash)};
     const observed=await proxyClient.getBlock({blockNumber:BigInt(acceptedModelSource.block)});
     assert.equal(observed.hash.toLowerCase(),acceptedModelSource.hash.toLowerCase(),
      'proxy must first observe the accepted model’s unchanged canonical anchor');
     phase('accepted_model_anchor_observed',{block:acceptedModelSource.block});
    }
   if(interrupt){workerSuspension=await suspendPaperWorker(worker,workerReady,
    {timeoutMs:5_000,readRuntimeBackends:runtimeDatabaseBackends});
    phase('worker_suspended',{pid:workerSuspension.pid,signal:workerSuspension.signal,
     readinessLeaseRetained:workerSuspension.readinessLeaseRetained,
     runtimeDatabaseQuiescence:workerSuspension.runtimeDatabaseQuiescence});}
   if(interrupt){
    const expiry=typeof previewResponse?.expiresAt==='string'&&
     Number.isFinite(Date.parse(previewResponse.expiresAt))?new Date(previewResponse.expiresAt).toISOString():null;
    phase('convert_acceptance_attempt_started',{at:new Date().toISOString(),previewExpiresAt:expiry,
     previewRemainingMs:expiry?Date.parse(expiry)-Date.now():null});
   }
  }});
  phase('convert_acceptance_submitted');checks.push('Positions browser accepted canonical convert-close preview');
  const acceptancePost=convert.posts.find(row=>row.path===`/api/deployments/${campaignId}/close-convert-operations`);
  assert(acceptancePost?.postData,'browser trace did not capture convert acceptance request body');
  const acceptedBody=JSON.parse(acceptancePost.postData);
  convertOperationId=await waitFor(()=>getOperationId('close_convert'),'persisted conversion operation',30_000);
  assert.equal(convert.acceptedResponse.id,convertOperationId,
   'persisted conversion operation must match the operation id returned to the UI');
  if(interrupt){
   const pending=await store.operation(convertOperationId);
   assert(['queued','preflighting','executing','confirming','reconciling'].includes(pending.status),
    `suspended worker must leave conversion pending: ${JSON.stringify(pending)}`);
   await selectCampaignInPositions(browser,campaignId);
   await browser.click('#paper .bottom-tabs button[data-action="tab"][data-value="activity"]');
   await browser.waitFor('document.querySelector("#paper .activity-list")?.textContent.includes("close_convert")',
    'pending conversion in Positions activity');
   const pendingView=await browser.evaluate('document.querySelector("#paper .position-detail")?.innerText??""');
   assert(/queued|preflight|reconcil/i.test(pendingView),
    `browser should show the pending conversion stage: ${pendingView.slice(0,1200)}`);
   checks.push('desktop Positions exposes the persisted pending conversion stage while worker is suspended');
   const preview=await admin.query('SELECT expires_at FROM deployment_previews WHERE id=$1',
    [acceptedBody.previewId]);assert.equal(preview.rowCount,1,'accepted preview snapshot missing');
   const expiresAt=new Date(preview.rows[0].expires_at).getTime(),expiryDelay=Math.max(0,expiresAt-Date.now()+100);
   phase('wait_for_accepted_preview_expiry',{expiresAt:new Date(expiresAt).toISOString(),expiryDelayMs:expiryDelay});
   if(expiryDelay>300_000)throw Error(`Accepted conversion preview expiry exceeds bounded recovery wait: ${expiryDelay}`);
   if(expiryDelay)await sleep(expiryDelay);
   assert(Date.now()>expiresAt,'accepted conversion preview should have expired before recovery');
   interruption=await killSuspendedPaperWorker(worker,workerReady);worker=null;
   phase('worker_killed_lease_released');
   const replayStart=browser.posts.length;
   await browser.navigate('/operator');await browser.login();await browser.click('#positions-tab');
   await browser.waitFor(`document.querySelector('#pending-paper-acceptance-recovery .paper-acceptance-reconcile-button[data-kind="close_convert"][data-campaign-id="${campaignId}"]')!==null`,
    'saved conversion request recovery after browser reload');
   const recoveryPath=`/api/deployments/${campaignId}/close-convert-operations`;
   await browser.evaluate(`(()=>{const original=window.fetch.bind(window),target=${JSON.stringify(recoveryPath)};
    window.__canonicalRecoveryResponse=null;window.__canonicalRecoveryFetchError=null;
    window.fetch=async(input,options)=>{let requestPath='';try{requestPath=new URL(
     typeof input==='string'?input:input.url,location.href).pathname;}catch{}
     const isRecovery=requestPath===target&&options?.method==='POST';let response;
     try{response=await original(input,options);}catch(error){if(isRecovery)window.__canonicalRecoveryFetchError={
      name:/^[A-Za-z]+Error$/.test(error?.name??'')?error.name:'Error',responseAcquired:false};throw error;}
     if(isRecovery){try{const body=await response.clone().json(),
      safeId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null,
      safeCode=value=>typeof value==='string'&&/^[a-z0-9_]{1,100}$/i.test(value)?value:null;
      window.__canonicalRecoveryResponse={httpStatus:response.status,responseAcquired:true,id:safeId(body.id),
       idInvalid:body.id!=null&&!safeId(body.id),status:safeCode(body.status),
       replayed:body.replayed===true,error:safeCode(body.error),reason:safeCode(body.reason)};
     }catch(error){window.__canonicalRecoveryResponse={httpStatus:response.status,responseAcquired:true,
      responseJsonErrorClass:/^[A-Za-z]+Error$/.test(error?.name??'')?error.name:'Error'};}}
     return response;};})()`);
   await browser.click(`#pending-paper-acceptance-recovery .paper-acceptance-reconcile-button[data-kind="close_convert"][data-campaign-id="${campaignId}"]`);
   await browser.waitFor('window.__canonicalRecoveryResponse!==null',
    'same-key reconciliation response after reconnect');
   const recoveryResponse=await browser.evaluate('window.__canonicalRecoveryResponse');
   assert.equal(recoveryResponse.httpStatus,202,`saved conversion reconciliation should return 202: ${JSON.stringify(recoveryResponse)}`);
   assert.equal(recoveryResponse.id,convertOperationId,'saved conversion reconciliation returned a different operation');
   assert.equal(recoveryResponse.status,'queued',`saved conversion reconciliation status changed: ${JSON.stringify(recoveryResponse)}`);
   assert.equal(recoveryResponse.replayed,true,'saved conversion reconciliation did not report same-key replay');
   const recoverySelector=`#pending-paper-acceptance-recovery .paper-acceptance-reconcile-button`+
    `[data-kind="close_convert"][data-campaign-id="${campaignId}"]`;
   const replayPost=browser.posts.slice(replayStart).find(row=>row.path===recoveryPath);
   assert(replayPost?.postData,'reconnected Positions did not submit the saved conversion request');
   assert.deepEqual(JSON.parse(replayPost.postData),acceptedBody,'reconnect must preserve the exact accepted request key');
   assert.equal(await store.paperOperationWorkerReady(),false,
    'same-key reconciliation should happen while worker readiness lease is still released');
   await selectCampaignInPositions(browser,campaignId);
   await browser.waitFor(`document.querySelector(${JSON.stringify(recoverySelector)})===null&&
    document.querySelector('#paper .position-detail')?.innerText.includes('Close · convert to USDG in progress · accepted · queued')`,
    'durable queued close-convert state after same-key reconciliation');
   phase('same_key_reconciled',{httpStatus:recoveryResponse.httpStatus,operationId:recoveryResponse.id,
    status:recoveryResponse.status,replayed:recoveryResponse.replayed,previewExpired:true,workerReady:false});
   checks.push('after response loss, preview expiry and worker lease loss, browser reconnect reconciled the same accepted conversion');
   if(changedRestartAnchor){
    assert(acceptedModelSource,'changed restart anchor has no saved accepted model source');
    const replacementHash='0x'+'f'.repeat(64);
    rpcProxy.setChangedAnchor({block:acceptedModelSource.block,hash:replacementHash});
    phase('changed_restart_anchor_armed',{block:acceptedModelSource.block,
     classification:'fault_injected_rpc_response_process_boundary'});
   }
   processTail.worker='';const restartStartedAt=Date.now();
   const restartEnvSha256=sealed?createHash('sha256').update(readFileSync(runtimeEnvFile)).digest('hex'):null;
   assert.equal(restartEnvSha256,runtimeEnvSha256,
    'sealed restart must reuse unchanged runtime.env bytes and config identity');
   worker=launch('worker',workerRpcEnv);capture(worker,'worker');
   phase('worker_restart_spawned',{pid:worker.pid,launcherEntry:sealed?'deployments-paper-worker':
    'src/deployments-paper-worker.ts',runtimeEnvSha256:restartEnvSha256,
    sameRuntimeEnvFile:sealed?runtimeEnvFile===initialWorkerEnvFile:null,runtimeIdentity:accountingIdentity,
    process:{...worker.__safeCapture,elapsedMs:Date.now()-restartStartedAt}});
   const restartedWorkerReadiness=await waitForWorkerReady(worker,'restarted worker readiness lease',30_000);
   phase('worker_restarted',{pid:worker.pid,launcherEntry:sealed?'deployments-paper-worker':
    'src/deployments-paper-worker.ts',runtimeEnvSha256:restartEnvSha256,
    sameRuntimeEnvFile:sealed?runtimeEnvFile===initialWorkerEnvFile:null,runtimeIdentity:accountingIdentity,
    process:{...worker.__safeCapture,...procSnapshot(worker,releaseRoot),elapsedMs:restartedWorkerReadiness.elapsedMs},
    procSamples:restartedWorkerReadiness.procSamples});
  }
  const terminal=await waitFor(async()=>{const row=await store.operation(convertOperationId);
   return ['succeeded','blocked','rejected','failed','cancelled'].includes(row?.status)?row:null;},
   'conversion worker terminal outcome',300_000);
  if(changedRestartAnchor){
   const rpcFaults=rpcProxy.diagnostics().faultCount;
   assert(rpcFaults>0,'restarted worker did not receive the injected changed source anchor');
   assert.equal(terminal.status,'blocked',JSON.stringify(terminal));
   assert.equal(terminal.reason,'paper_operation_canonical_or_evidence_invalid',
    `worker must preserve its generic canonical verification failure reason: ${JSON.stringify(terminal)}`);
   assert.equal(terminal.stage,'paper_recovery_required',
    `changed-anchor operation must remain in recovery-required stage: ${JSON.stringify(terminal)}`);
   const convertedMarks=(await admin.query(`SELECT id::text FROM deployment_marks
    WHERE campaign_id=$1 AND provenance->>'operationId'=$2`,[campaignId,convertOperationId])).rows;
   const conversionOperations=(await admin.query(`SELECT count(*)::int AS n FROM deployment_operations
    WHERE campaign_id=$1 AND kind='close_convert'`,[campaignId])).rows[0].n;
   const operationLedger=(await admin.query(`SELECT kind,amount_raw::text FROM deployment_ledger
    WHERE campaign_id=$1 AND operation_id=$2 ORDER BY entry_key`,[campaignId,convertOperationId])).rows;
   const operationAccounting=(await admin.query(`SELECT a.id::text FROM deployment_paper_accounting a
    JOIN deployment_marks m ON m.id=a.source_mark_id WHERE m.campaign_id=$1
    AND m.provenance->>'operationId'=$2`,[campaignId,convertOperationId])).rows;
   assert.equal(convertedMarks.length,0,'changed-anchor rejection must not write a terminal conversion mark');
   assert.equal(conversionOperations,1,'same-key reconnect must not create a duplicate conversion operation');
   assert.equal(operationLedger.length,0,'changed-anchor rejection must not write operation ledger or capital-out flows');
   assert.equal(operationAccounting.length,0,'changed-anchor rejection must not write V3 conversion accounting');
   const rows=await readDeploymentRows(admin),projected=rows.find(row=>row.id===campaignId);
   assert(projected);const position=deploymentPosition(projected),detail=await readDeploymentDetail(admin,projected,24);
   assert.notEqual(position.deployment.lifecycle,'closed');
   assert.notEqual(position.deployment.conversionAccountingStatus,'available');
   assert(detail.performance.markCount>=2&&detail.performance.timeline.some(point=>point.action==='enter'));
   const browserHistory=await inspectPositionAtWidths(browser,campaignId,['close_convert'],{
    history:false,expectedVisibleValues:['Starting capital','unavailable'],
    expectedMarkCount:detail.performance.markCount});
   assertBrowserHealthy(browser);
   phase('changed_anchor_operation_blocked',{operationId:convertOperationId,reason:terminal.reason,rpcFaults});
   checks.push('fault-injected changed persisted RPC anchor blocked the restarted worker; no conversion mark, ledger, or capital-out flow was written');
   console.log(JSON.stringify({status:'canonical_static_convert_changed_anchor_blocked',checks,campaignId,
    convertOperationId,operationStatus:terminal.status,reason:terminal.reason,
    classification:'fault_injected_rpc_response_process_boundary',rpcFaults,
    conversionOperations,
    convertedTerminalMarks:convertedMarks.length,operationLedgerRows:operationLedger.length,
    operationAccountingRows:operationAccounting.length,
    lifecycle:position.deployment.lifecycle,conversionAccountingStatus:position.deployment.conversionAccountingStatus,
    browserParity:{desktop:browserHistory.desktop.viewport,mobile:browserHistory.mobile.viewport},
    publicReplayReadOnlyPool:true,deploymentWritesIsolated:true,signerLoaded:false,broadcasts:0,
    runtime:sealed?{buildId:manifest.buildId,sourceCommit:manifest.sourceCommit,verified:true}:
     'spawned source src/deployments.ts and src/deployments-paper-worker.ts',
    workerInterruption:{suspended:workerSuspension,...interruption},
    note:'A test proxy changed one saved source-block response for the restarted worker; this is not a claim of a real chain reorg.'},null,2));
   return;
  }
  assert.equal(terminal.status,'succeeded',JSON.stringify(terminal));
  assert.equal(terminal.stage,'paper_close_convert_v3_reconciled');phase('conversion_completed');
  const rows=await readDeploymentRows(admin),projected=rows.find(row=>row.id===campaignId);
  assert(projected);const position=deploymentPosition(projected),detail=await readDeploymentDetail(admin,projected,24);
  assert.equal(position.deployment.lifecycle,'closed');
  assert.equal(position.deployment.operation.id,convertOperationId);
  assert.equal(position.deployment.operation.stage,'paper_close_convert_v3_reconciled');
  assert.equal(position.deployment.conversionAccountingStatus,'available');
  assert.equal(position.deployment.accounting?.policyVersion,PAPER_CONVERSION_ACCOUNTING_POLICY_V3);
  assert(position.deployment.accounting?.conversion,'closed projection has modeled conversion output');
  assert.equal(position.accounting,'provisional');
  const markRows=(await admin.query(`SELECT id::text,inventory,provenance FROM deployment_marks
   WHERE campaign_id=$1 AND provenance->>'operationId'=$2`,[campaignId,convertOperationId])).rows;
  const markCount=markRows.length;
  assert.equal(markCount,1);
  const terminalMark=markRows[0];
  const savedConversionPreview=(await admin.query(`SELECT id::text,proposal FROM deployment_previews
   WHERE id=$1 AND campaign_id=$2`,[terminalMark.provenance.previewId,campaignId])).rows[0];
  assert(savedConversionPreview,'terminal mark preview is missing');
  const terminalModel=savedConversionPreview.proposal.paperCloseConvertTerminalV3;
  assert.equal(savedConversionPreview.id,terminalMark.provenance.previewId);
  assert(terminalModel?.modelHash,'saved terminal V3 model is missing');
  assert.equal(terminalMark.provenance.operationId,convertOperationId);
  assert.equal(terminalMark.provenance.classification,'paper_model_converted_close');
  assert.equal(terminalMark.provenance.terminalModelHash,terminalModel.modelHash);
  assert.equal(terminalMark.provenance.source?.block,terminalModel.source.block);
  assert.equal(terminalMark.provenance.source?.hash?.toLowerCase(),terminalModel.source.hash.toLowerCase());
  assert.equal(terminalMark.inventory.classification,'paper_model_converted_close');
  assert.equal(terminalMark.inventory.actualCustodyAvailable,false);
  assert.equal(terminalMark.inventory.position,null);
  assert.equal(terminalMark.inventory.nativeWei,null);
  assert.equal(terminalMark.provenance.paidCostsAvailable,false);
  assert.equal(terminalMark.provenance.actualCustodyAvailable,false);
  assert.equal(terminalMark.inventory.retainedPrincipalLowerBound.amount0Raw,
   terminalModel.inventory.principal0Raw);
  assert.equal(terminalMark.inventory.retainedPrincipalLowerBound.amount1Raw,
   terminalModel.inventory.principal1Raw);
  assert.equal(terminalMark.inventory.idleLowerBound.amount0Raw,terminalModel.inventory.idle0Raw);
  assert.equal(terminalMark.inventory.idleLowerBound.amount1Raw,terminalModel.inventory.idle1Raw);
  assert.equal(terminalMark.inventory.simulatedPostWithdraw.token0Raw,terminalModel.inventory.token0Raw);
  assert.equal(terminalMark.inventory.simulatedPostWithdraw.token1Raw,terminalModel.inventory.token1Raw);
  assert.equal(terminalMark.inventory.simulatedPostWithdraw.fee0Raw,terminalModel.inventory.fee0Raw);
  assert.equal(terminalMark.inventory.simulatedPostWithdraw.fee1Raw,terminalModel.inventory.fee1Raw);
  const conversion=position.deployment.accounting.conversion;
  assert(BigInt(conversion.inputAmountRaw)>0n&&BigInt(conversion.expectedOutputRaw)>0n&&
   BigInt(conversion.minimumOutputRaw)>0n,'conversion input/output envelope is incomplete');
  assert(BigInt(conversion.expectedProceedsQuote)>=BigInt(conversion.minimumProceedsQuote),
   'expected proceeds must meet the modeled minimum');
  const accountingRow=(await admin.query(`SELECT id::text,fee_evidence_id::text,snapshot,snapshot_hash
   FROM deployment_paper_accounting
   WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
   [campaignId,terminalMark.id,PAPER_CONVERSION_ACCOUNTING_POLICY_V3])).rows[0];
  const accountingSnapshot=accountingRow?.snapshot;
  const accountingSnapshots=(await admin.query(`SELECT count(*)::int AS n FROM deployment_paper_accounting
   WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
   [campaignId,terminalMark.id,PAPER_CONVERSION_ACCOUNTING_POLICY_V3])).rows[0].n;
  assert.equal(accountingSnapshots,1,'terminal conversion must persist exactly one V3 accounting snapshot');
  assert(accountingSnapshot?.inventory,'persisted V3 accounting snapshot is missing terminal inventory');
  assert.equal(contentHash(accountingSnapshot),accountingRow.snapshot_hash,
   'terminal V3 accounting snapshot hash changed');
  assert.equal(accountingSnapshot.sourceMarkId,terminalMark.id,
   'terminal V3 snapshot is bound to a different source mark');
  assert.equal(accountingSnapshot.closeModelHash,terminalModel.modelHash,
   'terminal V3 snapshot is bound to a different conversion model');
  assert.deepEqual(accountingSnapshot.runtimeIdentity,accountingIdentity,
   'terminal V3 snapshot runtime identity changed');
  assert.equal(terminalMark.provenance.openMarkId,terminalModel.openMarkId);
  assert.equal(terminalMark.provenance.previousMarkId,terminalModel.previousMarkId);
  assert.equal(terminalMark.provenance.feeEvidenceId,terminalModel.feeReplay.previousFeeEvidenceId);
  const terminalFeeEvidence=(await admin.query(`SELECT id::text,from_mark_id::text,to_mark_id::text,
   proof_hash,carry_hash FROM deployment_paper_fee_evidence WHERE id=$1 AND campaign_id=$2`,
   [accountingRow.fee_evidence_id,campaignId])).rows[0];
  assert(terminalFeeEvidence,'terminal V3 fee evidence row is missing');
  assert.equal(terminalFeeEvidence.from_mark_id,terminalModel.previousMarkId);
  assert.equal(terminalFeeEvidence.to_mark_id,terminalMark.id);
  assert.equal(terminalFeeEvidence.proof_hash,terminalModel.feeReplay.intervalHash);
  assert.equal(terminalFeeEvidence.carry_hash,terminalModel.feeReplay.feeCarryHash);
  for(const asset of ['token0','token1']){
   const projectedRaw=String(position.deployment[asset].amountRaw),snapshotRaw=
    String(accountingSnapshot.inventory[`${asset}Raw`]);
   assert.equal(projectedRaw,snapshotRaw,`${asset} projection differs from persisted V3 accounting inventory`);
  }
  assert.equal(String(position.inventory.nativeWei),accountingSnapshot.inventory.nativeWei,
   'native inventory projection differs from persisted V3 accounting inventory');
  const conversionFlows=accountingSnapshot.flows.filter(flow=>flow.kind==='modeled_conversion'),
   capitalOutFlows=accountingSnapshot.flows.filter(flow=>flow.kind==='modeled_capital_out');
  assert.equal(conversionFlows.length,1,'persisted snapshot must contain one modeled conversion envelope');
  assert.equal(capitalOutFlows.length,3,'persisted snapshot must contain three modeled capital-out flows');
  assert.equal(BigInt(conversionFlows[0].fromAmountRaw),BigInt(conversion.inputAmountRaw));
  assert.equal(BigInt(conversionFlows[0].minimumToAmountRaw),BigInt(conversion.minimumOutputRaw));
  for(const asset of ['token0','token1']){
   const flow=capitalOutFlows.find(row=>row.asset===asset);
   assert(flow,`persisted snapshot is missing modeled ${asset} capital-out flow`);
   assert.equal(String(flow.amountRaw),String(accountingSnapshot.inventory[`${asset}Raw`]),
    `${asset} capital-out differs from terminal persisted inventory`);
  }
  assert(detail.performance.markCount>=3&&detail.performance.timeline[0]?.action==='enter'&&
   detail.performance.timeline.some(point=>point.action==='exit'),
   'closed history must preserve first entry and converted exit session values');
  const operationLedger=(await admin.query(`SELECT entry_key,kind,token_address,amount_raw::text,
    value_raw::text,source FROM deployment_ledger WHERE campaign_id=$1 AND operation_id=$2
    ORDER BY entry_key`,[campaignId,convertOperationId])).rows,
   ledgerCount=operationLedger.length,
   paid=(await admin.query(`SELECT count(*)::int AS n FROM deployment_ledger
    WHERE campaign_id=$1 AND kind='gas_paid'`,[campaignId])).rows[0].n;
  assert.equal(ledgerCount,3);assert.equal(paid,0);
  assert.equal(capitalOutFlows.length,3);
  assert.deepEqual([...new Set(capitalOutFlows.map(flow=>flow.asset))].sort(),
   ['native','token0','token1'],
   'V3 capital-out flows must cover token0, token1 and native exactly once');
  const expectedLedgerAssets={token0:profile.pool.token0,token1:profile.pool.token1,native:null};
  for(const flow of capitalOutFlows){
   const row=operationLedger.find(item=>item.entry_key===
    `paper_close_convert:${convertOperationId}:${flow.asset}`);
   assert(row,`operation ledger is missing modeled ${flow.asset} capital out`);
   assert.equal(row.kind,'capital_out');
   assert.equal(row.token_address?.toLowerCase()??null,
    expectedLedgerAssets[flow.asset]?.toLowerCase()??null);
   assert.equal(row.amount_raw,null,'modeled capital out must not be represented as a paid amount');
   assert.equal(row.value_raw,null,'modeled capital out must not be represented as a settled value');
   assert.equal(row.source.classification,'paper_modeled_conversion_capital_out_v3');
   assert.equal(row.source.operationId,convertOperationId);
   assert.equal(row.source.previewId,terminalMark.provenance.previewId);
   assert.equal(row.source.accountingId,accountingRow.id);
   assert.equal(row.source.policyVersion,PAPER_CONVERSION_ACCOUNTING_POLICY_V3);
   assert.equal(row.source.snapshotHash,accountingRow.snapshot_hash);
   assert.equal(row.source.terminalModelHash,terminalModel.modelHash);
   assert.equal(row.source.asset,flow.asset);
   assert.equal(row.source.modeledAmountRaw,flow.amountRaw);
   assert.equal(row.source.modeledValueQuote,flow.valueQuote);
   assert.equal(row.source.quoteHash,accountingSnapshot.conversion.quoteHash);
   assert.equal(row.source.paidCostsAvailable,false);
   assert.equal(row.source.actualCustodyAvailable,false);
  }
  const nativeCapitalOut=capitalOutFlows.find(flow=>flow.asset==='native');
  assert.equal(nativeCapitalOut.amountRaw,accountingSnapshot.inventory.nativeWei,
   'native capital-out flow differs from persisted V3 native inventory');
  const toToken=position.deployment[conversion.toAsset],fromToken=position.deployment[conversion.fromAsset],
   visibleValues=[`${formatAmount(conversion.inputAmountRaw,fromToken.decimals)} ${fromToken.symbol}`,
    `${formatAmount(conversion.expectedOutputRaw,toToken.decimals)} ${toToken.symbol}`,
    `${formatAmount(conversion.minimumOutputRaw,toToken.decimals)} ${toToken.symbol}`,
    `${formatUsd6(conversion.expectedProceedsQuote)} reference USD`,
    `${formatUsd6(conversion.minimumProceedsQuote)} reference USD`,
    `${formatUsd6(conversion.expectedGasCostQuote)} / ${formatUsd6(conversion.boundGasCostQuote)} reference USD`];
  for(const flow of position.deployment.accounting.capitalOut){
   const token=flow.asset==='token0'?position.deployment.token0:flow.asset==='token1'?position.deployment.token1:null,
    decimals=token?.decimals??18;
   visibleValues.push(formatAmount(flow.amountRaw,decimals),`${formatUsd6(flow.valueQuote)} reference USD`);
  }
  const history=await inspectPositionAtWidths(browser,campaignId,
   ['paper_open_recorded','paper_close_convert_v3_reconciled'],
   {expectedVisibleValues:['Provisional converted-close scenario','Modeled conversion count',
    'Expected modeled proceeds','Modeled capital out','Modeled conversion gas','no actual swap','not paid',
    ...visibleValues],expectedMarkCount:detail.performance.markCount});
  assertBrowserHealthy(browser);
  checks.push('desktop/mobile closed Positions matches persisted conversion, retains activity and explicit gaps');
  assert(detail.performance,'closed history projection has performance shape');
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_operations
   WHERE campaign_id=$1 AND kind='close_convert'`,[campaignId])).rows[0].n,1,
   'exactly one convert operation must be persisted');
  let restore=null;
  if(restoreRehearsal){
   await browser.close();browser=undefined;
   await stopProcess(worker);worker=undefined;
   assert.equal(await store.paperOperationWorkerReady(),false,
    'restore rehearsal requires the source worker readiness lease to be released');
   await stopProcess(command);command=undefined;
   await indexer.end();indexer=undefined;
   await store.close();store=undefined;
   restore=await rehearseStaticPaperSchemaRestore({testDatabaseUrl:process.env.TEST_DATABASE_URL,
    sourceSchema:schema});
   checks.push('closed canonical conversion campaign survived isolated backup/restore with append-only guards');
  }
  console.log(JSON.stringify({status:'canonical_static_convert_browser_passed',checks,campaignId,
   openOperationId,convertOperationId,openStage:openTerminal.stage,convertStage:terminal.stage,
   terminalMarks:markCount,modeledLedgerRows:ledgerCount,paidGasRows:paid,
   conversionAccountingStatus:position.deployment.conversionAccountingStatus,
   terminalInventory:position.inventory,provisionalConversion:position.deployment.accounting.conversion,
   browserParity:{desktop:history.desktop.viewport,mobile:history.mobile.viewport},
   replaySource:{targetSetHash:replayIdentity.target_set_hash,
    completeThroughBlock:replayIdentity.complete_through_block},
   publicReplayReadOnlyPool:true,deploymentWritesIsolated:true,signerLoaded:false,broadcasts:0,
   workerInterruption:interrupt?{suspended:workerSuspension,...interruption}:null,
   restoreRehearsal:restore,
   runtime:sealed?{buildId:manifest.buildId,sourceCommit:manifest.sourceCommit,verified:true}:
    'spawned source src/deployments.ts and src/deployments-paper-worker.ts',
   note:'Fork-derived estimates remain provisional. This disposable run proves static/manual browser conversion only.'},null,2));
}catch(error){
  if(Array.isArray(error?.runtimeDatabaseQuiescenceSamples))
   phase('worker_suspension_quiescence_failure',{
    runtimeApplicationName,samples:error.runtimeDatabaseQuiescenceSamples});
  if(browser&&campaignId){
   try{
    const browserObservation=await browser.evaluate(`(()=>({dropped:window.__canonicalDroppedAcceptedResponse===true,
     acceptedResponse:window.__canonicalAcceptedResponse,acceptanceFetchError:window.__canonicalAcceptanceFetchError,
     dropWrapper:window.__canonicalDropWrapperObservation,recoveryResponse:window.__canonicalRecoveryResponse,
     recoveryFetchError:window.__canonicalRecoveryFetchError}))()`),
     convertAcceptancePath=`/api/deployments/${campaignId}/close-convert-operations`,
     convertAcceptancePostCount=browser.posts.filter(row=>row.path===convertAcceptancePath).length;
    phase('failure_browser_acceptance_observation',{campaignId,browserObservation,
     postCounts:{closeConvertAcceptance:convertAcceptancePostCount}});
   }catch(diagnosticError){phase('failure_browser_acceptance_observation_error',{
    name:/^[A-Za-z]+Error$/.test(diagnosticError?.name??'')?diagnosticError.name:'Error'});}
  }
  if(campaignId&&admin){
   try{
    const operationRows=(await admin.query(`SELECT id::text,kind,status,stage,reason,attempts,
     created_at::text,updated_at::text FROM deployment_operations WHERE campaign_id=$1
     ORDER BY created_at DESC LIMIT 20`,[campaignId])).rows.map(row=>({id:row.id,
      kind:typeof row.kind==='string'&&/^[a-z0-9_]{1,64}$/i.test(row.kind)?row.kind:null,
      status:typeof row.status==='string'&&/^[a-z0-9_]{1,64}$/i.test(row.status)?row.status:null,
      stage:typeof row.stage==='string'&&/^[a-z0-9_]{1,120}$/i.test(row.stage)?row.stage:null,
      reason:typeof row.reason==='string'&&/^[a-z0-9_]{1,120}$/i.test(row.reason)?row.reason:null,
      attempts:Number.isInteger(row.attempts)?row.attempts:null,
      created_at:typeof row.created_at==='string'?row.created_at.slice(0,60):null,
      updated_at:typeof row.updated_at==='string'?row.updated_at.slice(0,60):null}));
    phase('failure_campaign_operations',{campaignId,operations:operationRows});
   }catch(diagnosticError){phase('failure_campaign_operations_error',{
    name:/^[A-Za-z]+Error$/.test(diagnosticError?.name??'')?diagnosticError.name:'Error',
    code:typeof diagnosticError?.code==='string'&&
     /^[A-Z0-9_]{1,60}$/i.test(diagnosticError.code)?diagnosticError.code:null});}
  }
  if(campaignId&&store&&indexer){
   try{
    const sampling=await store.paperFeeSamplingState(campaignId);
    const head=await rpc.getBlockNumber().then(block=>block.toString()).catch(()=>null),
     cursor=(await indexer.query(`SELECT c.complete_through_block::text AS complete_block,
      c.complete_through_hash,c.last_block_number::text AS last_block
      FROM v3_replay_cursors c JOIN v3_replay_pools p USING(stream_key)
      WHERE c.stream_key=$1 AND lower(p.pool_address)=lower($2)`,[stream,profile.pool.pool])).rows[0]??null,
     latestMark=(await admin.query(`SELECT id::text,source_block::text,
      provenance->>'classification' AS classification FROM deployment_marks
      WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1`,[campaignId])).rows[0]??null,
     lastFee=(await admin.query(`SELECT f.id::text,f.from_mark_id::text,f.to_mark_id::text,
      m.source_block::text AS source_block FROM deployment_paper_fee_evidence f
      LEFT JOIN deployment_marks m ON m.id=f.to_mark_id WHERE f.campaign_id=$1
      ORDER BY f.id DESC LIMIT 1`,[campaignId])).rows[0]??null,
     lastAccounting=(await admin.query(`SELECT a.source_mark_id::text,m.source_block::text AS source_block
      FROM deployment_paper_accounting a JOIN deployment_marks m ON m.id=a.source_mark_id
      WHERE a.campaign_id=$1 ORDER BY a.source_mark_id DESC LIMIT 1`,[campaignId])).rows[0]??null;
    let intervalDiagnostic=null;
    if(sampling){
     try{
      await readCanonicalPaperFeeInterval(rpc,indexer,sampling.stream,sampling.targetSetHash,
       sampling.profile,{source:sampling.before.source,tick:sampling.before.tick,
        sqrtPriceX96:sampling.before.sqrtPriceX96,poolLiquidity:sampling.before.poolLiquidity},
       {source:sampling.after.source,tick:sampling.after.tick,
        sqrtPriceX96:sampling.after.sqrtPriceX96,poolLiquidity:sampling.after.poolLiquidity},
       sampling.range,sampling.liquidity);
      intervalDiagnostic={status:'read_only_interval_passed',fromBlock:sampling.before.source.block,
       toBlock:sampling.after.source.block};
     }catch(feeError){intervalDiagnostic={status:'read_only_interval_failed',
      name:feeError?.name??'Error',message:clean(feeError?.message??feeError).slice(0,500),
      stack:clean(feeError?.stack??'').slice(0,1500),fromBlock:sampling.before.source.block,
      toBlock:sampling.after.source.block};}
    }
    phase('failure_read_only_fee_diagnostic',{campaignId,rpcHeadBlock:head,
     indexerCursor:cursor,latestMark,lastFeeEvidence:lastFee,lastAccounting,
     sampling:sampling?{fromMarkId:sampling.fromMarkId,toMarkId:sampling.toMarkId,
      fromBlock:sampling.before.source.block,toBlock:sampling.after.source.block}:null,
     intervalDiagnostic});
   }catch(diagnosticError){phase('failure_read_only_fee_diagnostic_error',
    {message:clean(diagnosticError?.message??diagnosticError).slice(0,500)});}
  }
  if(runtimeApplicationName&&runtimeDatabaseBackends&&admin){
   try{phase('failure_runtime_database_backends',{
    runtimeApplicationName,...await runtimeDatabaseBackends()});}
   catch(diagnosticError){phase('failure_runtime_database_backends_error',{
    name:/^[A-Za-z]+Error$/.test(diagnosticError?.name??'')?diagnosticError.name:'Error',
    code:typeof diagnosticError?.code==='string'&&
     /^[A-Z0-9_]{1,60}$/i.test(diagnosticError.code)?diagnosticError.code:null});}
  }
  throw error;
 }finally{
  await browser?.close().catch(()=>{});
  for(const child of [worker,command])await stopProcess(child).catch(()=>{});
  await rpcProxy?.close().catch(()=>{});
  await indexer?.end().catch(()=>{});await store?.close().catch(()=>{});
  try{await admin.query('SET search_path=public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
  finally{admin.release();await adminPool.end();if(runtimeDir)await rm(runtimeDir,{recursive:true,force:true});}
 }
}

main().catch(error=>{
 process.stderr.write(`${clean(error instanceof Error?error.stack:error)}\n`+
  `command_tail=${clean(processTail.command).slice(-5000)}\nworker_tail=${clean(processTail.worker).slice(-5000)}\n`);
 process.exitCode=1;
});
