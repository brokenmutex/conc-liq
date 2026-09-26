// Opt-in canonical static/manual open -> retain-close integration. Reads the
// operator's configured archive RPC, but all writes are isolated to a temporary
// PostgreSQL schema and a local owned Anvil fork. It never loads a signer or
// broadcasts a transaction.
// Run with TEST_DATABASE_URL=... node --import tsx test/integration/static-paper-canonical-flow.mjs
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer as createTcpServer} from 'node:net';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {contentHash,staticManualParameters} from '../../src/deployments/contracts.ts';
import {verifyMarketProfile,marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER,USDG} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {buildIndicativePaperOpenPreview,readCanonicalPaperOpenFrame,
 readCanonicalPaperNextFrame} from '../../src/deployments/paper-preview.ts';
import {costIndicativePaperOpenPreview} from '../../src/deployments/paper-cost.ts';
import {sampleStaticPaperGas} from '../../src/deployments/paper-gas-sampler.ts';
import {verifyPaperGasSource} from '../../src/deployments/paper-gas-source.ts';
import {persistTrustedPaperOpenPreview} from '../../src/deployments/paper-open-preflight.ts';
import {persistTrustedStaticPaperRetainPreview} from '../../src/deployments/paper-close-retain-preflight.ts';
import {verifyCanonicalPaperAnchors} from '../../src/deployments/paper-canonical-anchors.ts';
import {readDeploymentRows,readDeploymentByKey,readDeploymentDetail,deploymentPosition}
 from '../../src/dashboard/deployment-position.ts';

const cleanError=error=>{
 const message=error instanceof Error?error.message:'static canonical flow failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,500)}\n`);
 process.exitCode=1;
};
const phase=name=>process.stdout.write(`${JSON.stringify({phase:name})}\n`);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(read,label,timeoutMs=300_000)=>{
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){const value=await read();if(value)return value;await sleep(1000);}
 throw Error(`Timed out waiting for ${label}`);
};
const rawUsd=(usd)=>String(BigInt(usd)*10n**18n);

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const dbParsed=new URL(process.env.TEST_DATABASE_URL),socket=dbParsed.searchParams.get('host');
if(!['localhost','127.0.0.1','[::1]','::1'].includes(dbParsed.hostname.toLowerCase())&&
 !(socket&&socket.startsWith('/')))throw Error('TEST_DATABASE_URL must use local PostgreSQL');
const dotenv=parseEnv(readFileSync('.env','utf8')),
 archive=dotenv.RH_ARCHIVE_RPC_URL,
 readRpc=dotenv.ROBINHOOD_READ_HTTP_URL??archive,
 streamKey=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
if(!archive||!readRpc||!streamKey)throw Error('Canonical read RPC or indexer stream configuration unavailable');

const rpc=createRobinhoodClient(readRpc,20_000,{retryCount:0}),
 rawMarket=parseRangeKeeperConfig(JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8'))),
 profile=marketProfileSchema.parse({pool:{...rawMarket.pool,factory:UNISWAP_V3_FACTORY,
  positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER},
  referencePolicy:rawMarket.referencePolicy}),
 adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await adminPool.connect(),
 schema=`static_canonical_${randomUUID().replaceAll('-','')}`;
let store,command,worker,commandPort,dashboardPool,workerOutput='',password;
const checks=[];
const targetSetHash=`0x${'e'.repeat(64)}`;
const operator='0x1111111111111111111111111111111111111111';

try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
 scopedUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=30000`);
 store=new DeploymentStore(scopedUrl.toString());await store.assertReady();
 dashboardPool=new pg.Pool({connectionString:scopedUrl.toString(),max:2,
  options:'-c default_transaction_read_only=on'});

 const verified=await verifyMarketProfile(rpc,profile,streamKey);
 const riskAddress=profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0;
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES($1,$2,$3,'AAPL',$4,$5,1,$6,true)`,
  [streamKey,profile.pool.pool,profile.pool.chainId,riskAddress,profile.pool.fee,targetSetHash]);
 const registered=await store.registerVerifiedMarketProfile(verified);
 checks.push('verified live market profile and registered isolated indexer identity');

 // A direct seeded static/manual draft keeps this check scoped to open/retain
 // operation semantics. Setup-draft request admission has separate coverage.
 const parameters=staticManualParameters.parse({halfWidthTicks:20,limits:{
  maxDeploymentValue:rawUsd(2_000),minDeploymentValue:rawUsd(1),maxExposurePpm:950_000,
  maxLossValue:rawUsd(100),maxDrawdownPpm:100_000,
  maxActionCost:rawUsd(100),maxRollingCost:rawUsd(200),maxCampaignCost:rawUsd(300),
  exitReserveWei:'1000000000000000',maxSlippageBps:50}});
 const token0Raw=profile.pool.quoteToken===0?'500000000':'2000000000000000000',
  token1Raw=profile.pool.quoteToken===1?'500000000':'2000000000000000000';
 const campaign=await store.createDraft({mode:'paper',chainId:4663,wallet:operator,
  marketProfileId:registered.id,strategyId:'static_manual_v1',strategyVersion:'1.0.0',
  stateSchemaVersion:1,allocation:{token0Raw,token1Raw,nativeWei:'10000000000000000000'},config:parameters});
 const draft=await store.paperDraft(campaign.id);
 assert.equal(draft.strategyId,'static_manual_v1');
 assert.equal(draft.profileHash,contentHash(profile));
 checks.push('seeded isolated static/manual paper draft with explicit raw allocation');

 // Real six-stage sampling: only writes are to this local owned fork. Import
 // replays the candidate at its canonical source and binds all six profiles.
 const identity={buildId:contentHash({kind:'static-canonical-test-build',pid:process.pid}),
  configHash:contentHash({kind:'isolated-test-runtime'}),nodeVersion:process.version};
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(identity);
 const frame=await readCanonicalPaperOpenFrame(rpc,profile),
  indicative=buildIndicativePaperOpenPreview(draft,frame);
 assert.equal(indicative.status,'indicative',`Static candidate unavailable: ${indicative.reason}`);
 phase('sample_static_six_stage_owned_fork');
 const report=await sampleStaticPaperGas({rpcUrl:archive,draft,frame,beforeRead:async()=>{},
  maxRequests:1600,timeoutMs:300_000});
 const attestation=await verifyPaperGasSource(rpc,report);
 const imported=await store.registerPaperGasEvidence(report,attestation);
 assert.equal(imported.created,true);
 assert.equal(imported.profileIds.length,6);
 const gasRows=await store.paperGasProfiles(profile.pool.pool);
 assert.equal(gasRows.filter(row=>row.sizeBand===imported.sizeBand).length,6);
 checks.push('sampled six exact no-swap stages on an owned fork and imported canonical replay-attested provisional profiles');
 phase('static_six_stage_profiles_imported');

 const portProbe=createTcpServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
 commandPort=portProbe.address().port;await new Promise((resolve,reject)=>portProbe.close(error=>error?reject(error):resolve()));
 const origin=`http://127.0.0.1:${commandPort}`;
 password=`canonical-paper-${randomUUID()}`;
 const salt=randomBytes(16),passwordHash=`scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
 const dashboardRead=async(path)=>{
  const url=new URL(path,origin),client=await dashboardPool.connect();
  try{
   const rows=await readDeploymentRows(client);
   if(url.pathname==='/api/positions')return {positions:rows.map(deploymentPosition),serverTime:new Date().toISOString()};
   const key=/^\/api\/positions\/(paper-dep-[0-9a-f-]{36})$/.exec(url.pathname);
   if(key){const row=await readDeploymentByKey(client,key[1]);
    return row?await readDeploymentDetail(client,row,Number(url.searchParams.get('hours')??24)):null;}
   throw Error('dashboard path unsupported');
  }finally{client.release();}
 };
 const verifyAnchors=(chainId,sources)=>verifyCanonicalPaperAnchors(rpc,chainId,sources);
 const paperPreview=async(campaignId,kind)=>{
  if(kind==='open'){
   const current=await store.paperDraft(campaignId),source=await readCanonicalPaperOpenFrame(rpc,current.profile),
    model=buildIndicativePaperOpenPreview(current,source),rows=await store.paperGasProfiles(current.profile.pool.pool),
    price=await rpc.getGasPrice(),costed=costIndicativePaperOpenPreview(model,rows,
     current.profile.pool.pool,source.nativePrice??0n,price);
   if(costed.costs.status!=='provisional')return costed;
   const saved=await persistTrustedPaperOpenPreview({store,draft:current,frame:source,preview:costed,verifyAnchors});
   return {...costed,...saved,status:'indicative',kind:'open',trustedPreviewSaved:true,economics:null};
  }
  if(kind==='close_retain'){
   const state=await store.paperValuationState(campaignId),source=await readCanonicalPaperNextFrame(rpc,
    state.profile,state.previous),rows=await store.paperGasProfiles(state.profile.pool.pool),price=await rpc.getGasPrice();
   return await persistTrustedStaticPaperRetainPreview({store,state,frame:source,gasProfiles:rows,
    gasPriceWei:price,verifyAnchors});
  }
  return {kind,status:'unavailable',campaignId,reason:'unsupported_in_static_flow_fixture',actionAvailable:false};
 };
 const server=createDeploymentCommandServer(store,{origin,passwordHash,dashboardRead,paperPreview,
  paperOperationReplay:(campaignId,input,kinds)=>store.acceptedOperationReplay(campaignId,input,kinds),
  paperOpenAcceptance:(campaignId,input,actor)=>store.acceptStaticPaperOpenOperation(campaignId,input,actor,verifyAnchors),
  paperRetainAcceptance:(campaignId,input,actor)=>store.acceptStaticPaperRetainOperation(campaignId,input,actor,verifyAnchors),
  paperRetainWorkerReady:()=>store.paperOperationWorkerReady()});
 command=server;server.listen(commandPort,'127.0.0.1');await once(server,'listening');
 const post=(path,body,headers={})=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...headers},
  body:JSON.stringify(body),signal:AbortSignal.timeout(60_000)});
 assert.equal((await fetch(origin+'/api/market-profiles')).status,401);
 const login=await post('/api/session',{password},{origin});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json(),
  auth={origin,cookie,'x-csrf-token':session.csrfToken};
 const profiles=await fetch(origin+'/api/market-profiles',{headers:{cookie}}).then(response=>response.json());
 assert(profiles.profiles.some(row=>row.id===registered.id&&row.draftAvailable));
 checks.push('authenticated loopback HTTP exposes verified profile and denies unauthenticated reads');

 const workerEnv={...process.env,DATABASE_URL:scopedUrl.toString(),ROBINHOOD_READ_HTTP_URL:readRpc,
  DEPLOYMENT_PAPER_OPERATION_WORKER:'1',DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',
  DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'2',DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'4',
  DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4',CONC_LIQ_RUNTIME_IDENTITY:JSON.stringify(identity)};
 const startWorker=async()=>{
  workerOutput='';worker=spawn(process.execPath,['--import','tsx','src/deployments-paper-worker.ts'],
   {cwd:process.cwd(),env:workerEnv,stdio:['ignore','pipe','pipe']});
  worker.stdout.setEncoding('utf8');worker.stderr.setEncoding('utf8');
  worker.stdout.on('data',chunk=>workerOutput+=chunk);worker.stderr.on('data',chunk=>workerOutput+=chunk);
  await waitFor(()=>store.paperOperationWorkerReady(),'paper worker readiness lease',30_000);
  phase('paper_worker_process_ready');
 };
 const runOpen=async()=>{
  const previewResponse=await post(`/api/deployments/${campaign.id}/previews`,{kind:'open'},auth);
  assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
  assert.equal(preview.actionAvailable,true,JSON.stringify(preview));
  assert.equal(preview.economics,null);assert.equal(preview.costs.status,'provisional');
  const accepted=await post(`/api/deployments/${campaign.id}/open-operations`,{
   previewId:preview.id,contentDigest:preview.contentDigest,expectedRevision:preview.expectedRevision,
   idempotencyKey:`static-open-${randomUUID()}`},auth);
  const operation=await accepted.json();assert.equal(accepted.status,202,JSON.stringify(operation));
  phase('static_open_operation_accepted');
  const terminal=await waitFor(async()=>{
   const response=await fetch(origin+`/api/operations/${operation.id}`,{headers:{cookie}});
   if(response.status!==200)return null;const row=await response.json();
   if(['blocked','rejected','cancelled'].includes(row.status))return row;
   return ['succeeded','completed'].includes(row.status)?row:null;
  },'static paper open worker operation');
  assert.equal(terminal.id,operation.id);
  assert.equal(terminal.status,'succeeded',JSON.stringify({status:terminal.status,stage:terminal.stage,reason:terminal.reason}));
  assert.equal(terminal.stage,'paper_open_recorded');
  return {preview,operation};
 };
 await startWorker();
 const opened=await runOpen();
 phase('static_open_worker_succeeded');
 checks.push('authenticated open preview was accepted and the real worker recorded a provisional open');

 // The worker maintenance pass appends a later canonical principal mark.
 const detailPath=`/api/positions/paper-dep-${campaign.id}?hours=24`;
 const valued=await waitFor(async()=>{
  const response=await fetch(origin+detailPath,{headers:{cookie}});
  if(response.status!==200)return null;const value=await response.json();
  return value.events?.some(event=>event.action==='valuation'&&event.stage==='principal_only')?value:null;
 },'later canonical principal valuation',360_000);
 assert(valued,'valuation projection missing');
 phase('later_principal_valuation_present');

 phase('request_static_retain_preview');
 const retainResponse=await post(`/api/deployments/${campaign.id}/previews`,{kind:'close_retain'},auth);
 assert.equal(retainResponse.status,200);const retain=await retainResponse.json();
 assert.equal(retain.actionAvailable,true,JSON.stringify(retain));
 assert.equal(retain.economics,null);assert.equal(retain.paidCostsAvailable,false);
 const retained=await post(`/api/deployments/${campaign.id}/operations`,{
  previewId:retain.id,contentDigest:retain.contentDigest,expectedRevision:retain.expectedRevision,
  idempotencyKey:`static-retain-${randomUUID()}`},auth);
 const closeOperation=await retained.json();assert.equal(retained.status,202,JSON.stringify(closeOperation));
 phase('static_retain_operation_accepted');
 const closed=await waitFor(async()=>{
  const response=await fetch(origin+`/api/operations/${closeOperation.id}`,{headers:{cookie}});
  if(response.status!==200)return null;const row=await response.json();
  if(['blocked','rejected','cancelled'].includes(row.status))return row;
  return ['succeeded','completed'].includes(row.status)?row:null;
 },'static retain-close worker operation');
 assert.equal(closed.id,closeOperation.id);
 assert.equal(closed.status,'succeeded',JSON.stringify({status:closed.status,stage:closed.stage,reason:closed.reason}));
 assert.equal(closed.stage,'paper_close_retain_recorded');
 phase('static_retain_worker_succeeded');
 const finalPositions=await fetch(origin+'/api/positions?hours=24',{headers:{cookie}}).then(response=>response.json()),
  projected=finalPositions.positions.find(row=>row.id===`paper-dep-${campaign.id}`);
 assert(projected);assert.equal(projected.deployment.lifecycle,'closed');
 assert.equal(projected.deployment.operation.id,closeOperation.id);
 assert.equal(projected.deployment.operation.stage,'paper_close_retain_recorded');
 assert.equal(projected.deployment.operation.status,'succeeded');
 assert(projected.deployment.unavailable.includes('paid_gas'));
 assert(projected.deployment.unavailable.includes('fee_capture'));
 checks.push('retain-close preview and accepted worker completion appear in real Positions with unavailable economics');

 const ledger=(await admin.query(`SELECT count(*)::int AS n FROM deployment_ledger
  WHERE campaign_id=$1 AND kind='gas_paid'`,[campaign.id])).rows[0].n;
 assert.equal(ledger,0,'fork estimates must not become paid execution ledger rows');
 assert.equal(await store.paperOperationWorkerReady(),true);
 console.log(JSON.stringify({checks,campaignId:campaign.id,openOperationId:opened.operation.id,
  retainOperationId:closeOperation.id,gasReportHash:report.reportHash,
  provisionalStages:report.stageProfiles.map(stage=>stage.stage),paidGasLedgerRows:ledger,
  signerLoaded:false,broadcasts:0,productionSchemaTouched:false,
  note:'Direct static/manual draft seed; this harness does not exercise setup-draft HTTP admission.'},null,2));
}catch(error){cleanError(error);}
finally{
 if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await Promise.race([once(worker,'exit'),sleep(3000)]);
  if(worker.exitCode===null)worker.kill('SIGKILL');}
 if(command?.listening)await new Promise(resolve=>command.close(resolve));
 await dashboardPool?.end();await store?.close();
 try{await admin.query('SET search_path=public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
 finally{admin.release();await adminPool.end();}
}
