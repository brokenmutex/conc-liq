// Opt-in canonical static/manual open -> retain-close integration. Reads the
// operator's configured archive RPC, but all writes are isolated to a temporary
// PostgreSQL schema and a local owned Anvil fork. Sealed mode uses actual pinned
// release command/worker entrypoints; neither mode loads a signer or broadcasts.
// Run with TEST_DATABASE_URL=... node --import tsx test/integration/static-paper-canonical-flow.mjs
// Sealed: TEST_SEALED_RELEASE_DIR=/path/to/release TEST_EXPECTED_RELEASE_COMMIT=<sha>
//   node --import tsx test/integration/static-paper-canonical-flow.mjs --sealed-release
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import {access,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer as createTcpServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {verifyRelease} from '../../scripts/release-files.mjs';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {contentHash,staticManualParameters} from '../../src/deployments/contracts.ts';
import {buildStaticPaperSetupPreflight} from '../../src/deployments/paper-setup-preflight.ts';
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
import {createStaticPaperDraftFromSetup} from '../../src/deployments/static-paper-draft-admission.ts';
import {StaticPaperSetupReviewCache} from '../../src/deployments/static-paper-setup-review-cache.ts';
import {prepareStaticPaperSetup} from '../../src/deployments/static-paper-setup-preparation.ts';
import {prepareStaticPaperGasForCandidate} from '../../src/deployments/static-paper-gas-preparation.ts';
import {readDeploymentRows,readDeploymentByKey,readDeploymentDetail,deploymentPosition}
 from '../../src/dashboard/deployment-position.ts';

const cleanError=error=>{
 const message=error instanceof Error?(error.stack??error.message):'static canonical flow failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,10000)}\n`);
 process.exitCode=1;
};
const phase=(name,details={})=>process.stdout.write(`${JSON.stringify({phase:name,...details})}\n`);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(read,label,timeoutMs=300_000)=>{
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(worker&&typeof worker.exitCode==='number')throw Error(`paper worker exited ${worker.exitCode}: ${workerOutput.slice(-1200)}`);
  if(command&&typeof command.exitCode==='number')throw Error(`command process exited ${command.exitCode}: ${commandOutput.slice(-1200)}`);
  const value=await read();if(value)return value;await sleep(1000);
 }
 throw Error(`Timed out waiting for ${label}`);
};
const rawUsd=(usd)=>String(BigInt(usd)*10n**18n);

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const sealedReleaseMode=process.argv.includes('--sealed-release');
if(sealedReleaseMode&&!process.env.TEST_SEALED_RELEASE_DIR)
 throw Error('TEST_SEALED_RELEASE_DIR is required with --sealed-release');
if(!sealedReleaseMode&&process.env.TEST_SEALED_RELEASE_DIR)
 throw Error('Use --sealed-release to opt into TEST_SEALED_RELEASE_DIR');
const releaseRoot=sealedReleaseMode?resolve(process.env.TEST_SEALED_RELEASE_DIR):null,
 releaseManifest=releaseRoot?verifyRelease(releaseRoot):null;
if(releaseManifest&&process.env.TEST_EXPECTED_RELEASE_COMMIT&&
 releaseManifest.sourceCommit!==process.env.TEST_EXPECTED_RELEASE_COMMIT)
 throw Error(`Sealed release source commit mismatch: ${releaseManifest.sourceCommit}`);
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
let store,command,worker,chrome,chromeProfile,ws,commandPort,dashboardPool,workerOutput='',commandOutput='',password,runtimeTemp,campaign,
 setupAdmissionFresh=null,
 sampledGasReport=null;
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
 const registeredProfileHash=contentHash(profile);
 assert.equal(verified.profileHash,registeredProfileHash);
 checks.push('verified live market profile and registered isolated indexer identity');

 // The authenticated setup endpoint owns exact-source calibration; this
 // harness does not seed a candidate or pre-import gas rows.
 const setupInput={profileId:registered.id,capitalQuoteRaw:'2000000000',halfWidthTicks:20};
 const parameters=staticManualParameters.parse({halfWidthTicks:setupInput.halfWidthTicks,limits:{
  maxDeploymentValue:rawUsd(2_000),minDeploymentValue:rawUsd(1),maxExposurePpm:950_000,
  maxLossValue:rawUsd(100),maxDrawdownPpm:100_000,
  maxActionCost:rawUsd(100),maxRollingCost:rawUsd(200),maxCampaignCost:rawUsd(300),
  exitReserveWei:'1000000000000000',maxSlippageBps:50}});
 setupInput.limits=parameters.limits;
 const identity={buildId:contentHash({kind:'static-canonical-test-build',pid:process.pid}),
  configHash:contentHash({kind:'isolated-test-runtime'}),nodeVersion:process.version};
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(identity);

 const portProbe=createTcpServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');
 commandPort=portProbe.address().port;await new Promise((resolve,reject)=>portProbe.close(error=>error?reject(error):resolve()));
 const origin=`http://127.0.0.1:${commandPort}`;
 password=`canonical-paper-${randomUUID()}`;
 const salt=randomBytes(16),passwordHash=`scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
 let runtimeEnvFile=null;
 if(sealedReleaseMode){
  runtimeTemp=await mkdtemp(`${tmpdir()}/conc-liq-static-canonical-sealed-`);
  const dashboardProbe=createTcpServer();dashboardProbe.listen(0,'127.0.0.1');await once(dashboardProbe,'listening');
  const dashboardPort=dashboardProbe.address().port;
  await new Promise((resolve,reject)=>dashboardProbe.close(error=>error?reject(error):resolve()));
  runtimeEnvFile=join(runtimeTemp,'runtime.env');
  const runtime={DATABASE_URL:scopedUrl.toString(),DEPLOYMENT_OPERATOR_PASSWORD_HASH:passwordHash,
   DEPLOYMENT_HOST:'127.0.0.1',DEPLOYMENT_PORT:String(commandPort),ROBINHOOD_READ_HTTP_URL:readRpc,
   PAPER_FORK_RPC_URL:archive,
   DEPLOYMENT_RPC_TIMEOUT_MS:'20000',DEPLOYMENT_PAPER_OPERATION_WORKER:'1',
   DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'2',
   DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'4',DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4',
   INDEXER_STREAM_KEY:streamKey,ADAPTIVE_PAPER_STATE_PATH:join(runtimeTemp,'absent-adaptive-state.json'),
   DASHBOARD_HOST:'127.0.0.1',DASHBOARD_PORT:String(dashboardPort)};
  await writeFile(runtimeEnvFile,Object.entries(runtime)
   .map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});
 }
 const launchSealed=entrypoint=>spawn(join(releaseRoot,'bin/node'),
  [join(releaseRoot,'launch.mjs'),runtimeEnvFile,entrypoint],
  {cwd:releaseRoot,env:{PATH:'/usr/bin:/bin',HOME:runtimeTemp},stdio:['ignore','pipe','pipe']});
 if(sealedReleaseMode){
  command=launchSealed('deployments');
  command.stdout.setEncoding('utf8');command.stdout.on('data',chunk=>commandOutput+=chunk);
  command.stderr.setEncoding('utf8');command.stderr.on('data',chunk=>commandOutput+=chunk);
  await waitFor(async()=>await fetch(origin+'/healthz').then(response=>response.status===200).catch(()=>false),
   'sealed command server health endpoint',30_000);
 }else{
  const runSetupPreflight=(input,pinnedSource)=>buildStaticPaperSetupPreflight(input,{
   loadProfile:id=>store.paperSetupProfile(id),
   readFrame:(market,source)=>readCanonicalPaperOpenFrame(rpc,market,source),
   verifyCanonical:(chainId,source)=>verifyCanonicalPaperAnchors(rpc,chainId,[source]),
   readGasProfiles:pool=>store.paperGasProfiles(pool),readGasPrice:()=>rpc.getGasPrice()},pinnedSource);
  let setupBusy=false;
  const setupReviewCache=new StaticPaperSetupReviewCache();
  const setupPreflight=async(input,pinnedSource)=>{
   if(setupBusy)throw Error('paper_setup_preflight_busy');setupBusy=true;
   try{
    if(pinnedSource||!input.limits)return await runSetupPreflight(input,pinnedSource);
    phase('sample_static_six_stage_owned_fork');
    const result=await prepareStaticPaperSetup(input,{runPreflight:runSetupPreflight,
     loadProfile:id=>store.paperSetupProfile(id),readFrame:(market,source)=>readCanonicalPaperOpenFrame(rpc,market,source),
     forkRpcUrl:archive,
     sample:async(draft,frame)=>{
      sampledGasReport=await sampleStaticPaperGas({rpcUrl:archive,draft,frame,beforeRead:async()=>{},
       maxRequests:1600,timeoutMs:150_000});
      return sampledGasReport;
     },
     verify:report=>verifyPaperGasSource(rpc,report),
     importEvidence:(report,attestation)=>store.registerPaperGasEvidence(report,attestation)});
    if(result.status==='available')phase('static_six_stage_profiles_imported');
    return result;
   }catch(error){
    const detail=(error instanceof Error?error.stack:String(error)).replace(/https?:\/\/\S+/gi,'[redacted-url]');
    process.stderr.write(`setup preparation exception: ${detail.slice(0,1600)}\n`);throw error;
   }
   finally{setupBusy=false;}
  };
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
  const setupPreflightForReview=async(input,pinnedSource)=>{
   const result=await setupPreflight(input,pinnedSource);
   if(pinnedSource||result?.status!=='available'||result?.costs?.status!=='provisional')return result;
   const captured=setupReviewCache.capture(result);
   return captured?{...result,...captured}:{...result,status:'unavailable',
    costs:{status:'unavailable',reason:'setup_review_snapshot_unavailable'},
    missing:['setup_review_snapshot_unavailable'],actionAvailable:false};
  };
  const paperPreview=async(campaignId,kind)=>{
   if(kind==='open'){
    const current=await store.paperDraft(campaignId),source=await readCanonicalPaperOpenFrame(rpc,current.profile);
    const indicative=buildIndicativePaperOpenPreview(current,source);
    if(indicative.status!=='indicative')return indicative;
    const rebuild=async()=>{
     const rows=await store.paperGasProfiles(current.profile.pool.pool),price=await rpc.getGasPrice(),
      reviewed={...indicative,expiresAt:new Date(Math.min(
       (source.source.timestamp+180)*1000,Date.now()+120_000)).toISOString()};
     return {...costIndicativePaperOpenPreview(reviewed,rows,current.profile.pool.pool,
      source.nativePrice??0n,price),source:source.source};
    };
    const prepared=await prepareStaticPaperGasForCandidate(current,source,{
     sample:(draft,frame)=>sampleStaticPaperGas({rpcUrl:archive,draft,frame,beforeRead:async()=>{},
      maxRequests:1600,timeoutMs:150_000}),
     verify:report=>verifyPaperGasSource(rpc,report),
     importEvidence:async(report,attestation)=>{
      const result=await store.registerPaperGasEvidence(report,attestation);
      if(typeof result.reportHash!=='string')throw Error('paper_gas_import_report_hash_unavailable');
      return {created:result.created,reportHash:result.reportHash};
     },rebuild,isPrepared:value=>value.costs.status==='provisional',sourceOf:value=>value.source});
    if(prepared.status!=='available')return {...(prepared.value??{status:'unavailable'}),
     status:'unavailable',reason:prepared.reason,actionAvailable:false,operationAcceptanceAvailable:false};
    const costed=prepared.value;
    if(costed.referenceProofHash!==source.referenceProofHash)
     throw Error('paper_open_model_reference_proof_does_not_match_captured_frame');
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
  paperSetupPreflight:setupPreflightForReview,
  paperSetupDraftAdmission:input=>createStaticPaperDraftFromSetup(input,{
   runPreflight:async(request,pinnedSource)=>{
    setupAdmissionFresh=await setupPreflight(request,pinnedSource);return setupAdmissionFresh;
   },
    loadProfile:id=>store.paperSetupProfile(id),
    lookupCapturedReview:review=>setupReviewCache.lookup(review),
    findDraftRequest:(id,request)=>store.findDraftRequest(id,request),
    createDraftWithRequestId:(id,request)=>store.createDraftWithRequestId(id,request)}),
   paperSetupDraftList:()=>store.listStaticPaperDrafts(),
   paperOperationReplay:(campaignId,input,kinds)=>store.acceptedOperationReplay(campaignId,input,kinds),
   paperOpenAcceptance:(campaignId,input,actor)=>store.acceptStaticPaperOpenOperation(campaignId,input,actor,verifyAnchors),
   paperRetainAcceptance:(campaignId,input,actor)=>store.acceptStaticPaperRetainOperation(campaignId,input,actor,verifyAnchors),
   paperRetainWorkerReady:()=>store.paperOperationWorkerReady()});
  command=server;server.listen(commandPort,'127.0.0.1');await once(server,'listening');
 }
 const post=(path,body,headers={},timeoutMs=60_000)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...headers},
  body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
 assert.equal((await fetch(origin+'/api/market-profiles')).status,401);
 const login=await post('/api/session',{password},{origin});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json(),
  auth={origin,cookie,'x-csrf-token':session.csrfToken};
 const profiles=await fetch(origin+'/api/market-profiles',{headers:{cookie}}).then(response=>response.json());
 assert(profiles.profiles.some(row=>row.id===registered.id&&row.draftAvailable));
 const setupReviewResponse=await post('/api/deployments/setup-preflight',setupInput,auth,240_000);
 assert.equal(setupReviewResponse.status,200,await setupReviewResponse.clone().text());
 const setupReview=await setupReviewResponse.json();
 if(!sealedReleaseMode)assert(sampledGasReport,
  'authenticated setup preflight did not run its exact-source sampler');
 if(setupReview.status!=='available'){
  let currentCandidate=null;
  if(setupReview.source&&setupReview.requirements){
   const candidateFrame=await readCanonicalPaperOpenFrame(rpc,profile,setupReview.source),candidateDraft={
    id:randomUUID(),revision:1,profile,profileHash:registeredProfileHash,
    configHash:contentHash({...parameters,strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
    strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,parameters,
    allocation:{token0Raw:setupReview.requirements.token0Raw,
     token1Raw:setupReview.requirements.token1Raw,nativeWei:parameters.limits.exitReserveWei}};
   currentCandidate=buildIndicativePaperOpenPreview(candidateDraft,candidateFrame).candidate;
  }
 const calibration=await store.paperGasProfiles(profile.pool.pool).then(rows=>rows.map(row=>{
  const model=row.model,source=model?.source,measured=typeof source?.estimatedAt==='string'?
   Date.parse(source.estimatedAt):NaN,observed=row.observedUntil instanceof Date?
   row.observedUntil.getTime():Date.parse(row.observedUntil),validity=[];
  if(row.poolAddress?.toLowerCase()!==profile.pool.pool.toLowerCase())validity.push('pool');
  if(row.pathVersion!=='paper_static_manual_no_swap_v1')validity.push('path');
  if(row.allowanceState!=='zero')validity.push('allowance');
  if(row.component!=='gas_units')validity.push('component');
  if(!['provisional','validated'].includes(row.status)||row.evidenceClass!=='fork_estimated')validity.push('status');
  if(typeof row.sourceHash!=='string'||row.sourceHash!==contentHash(source))validity.push('source_hash');
  if(!Number.isFinite(measured)||!Number.isFinite(observed)||Math.abs(observed-measured)>1000||
   Date.now()-measured<0||Date.now()-measured>86_400_000||Date.now()-observed<0||
   Date.now()-observed>86_400_000)validity.push('freshness');
  if(BigInt(model?.sizeMinValue??'0')>BigInt(currentCandidate?.deployedValue??'0')||
   BigInt(model?.sizeMaxValue??'0')<BigInt(currentCandidate?.deployedValue??'0'))validity.push('value_band');
  if(BigInt(model?.shareMinPpm??'0')>BigInt(currentCandidate?.dilutedSharePpm??'0')||
   BigInt(model?.shareMaxPpm??'0')<BigInt(currentCandidate?.dilutedSharePpm??'0'))validity.push('share_band');
  if(model?.tickLower!==currentCandidate?.range.tickLower||model?.tickUpper!==currentCandidate?.range.tickUpper)
   validity.push('range');
  if(BigInt(model?.gasUnitsExpected??'0')<=0n||BigInt(model?.gasUnitsBound??'0')<BigInt(model?.gasUnitsExpected??'0'))
   validity.push('gas_units');
  return {stage:row.stage,version:row.version,sizeBand:row.sizeBand,status:row.status,evidenceClass:row.evidenceClass,
   poolAddress:row.poolAddress,pathVersion:row.pathVersion,allowanceState:row.allowanceState,component:row.component,
   sourceHashMatchesModel:typeof row.sourceHash==='string'&&row.sourceHash===contentHash(source),validity,
   observedUntil:row.observedUntil instanceof Date?row.observedUntil.toISOString():row.observedUntil,
   sourceAgeMs:Number.isFinite(measured)?Date.now()-measured:null,
   sampledSource:source&&{block:source.block,hash:source.hash,estimatedAt:source.estimatedAt},
     sampledRange:[model?.tickLower,model?.tickUpper],currentRange:currentCandidate?
      [currentCandidate.range.tickLower,currentCandidate.range.tickUpper]:null,
     sampledValue:[model?.sizeMinValue,model?.sizeMaxValue],currentValue:currentCandidate?.deployedValue,
     sampledShare:[model?.shareMinPpm,model?.shareMaxPpm],currentShare:currentCandidate?.dilutedSharePpm};
   }));
  throw Error(`setup preflight unavailable: ${JSON.stringify({missing:setupReview.missing,
   costs:setupReview.costs,currentSource:setupReview.source,currentCandidate,calibration})}`);
 }
 assert.equal(setupReview.kind,'paper_setup_preflight');assert.equal(setupReview.actionAvailable,false);
 assert.equal(setupReview.draftCreated,false);assert.equal(setupReview.operationCreated,false);
 assert.equal(setupReview.profileId,registered.id);assert.equal(setupReview.profileHash,registeredProfileHash);
 assert.equal(setupReview.costs.status,'provisional');
 checks.push('authenticated setup preflight returns exact registered profile/source/range and provisional costs without creating a draft, preview, operation or paid-ledger row');
 const reviewed={profileId:setupReview.profileId,profileHash:setupReview.profileHash,input:setupReview.input,
  source:setupReview.source,profile:setupReview.profile,range:setupReview.range,
  requirements:setupReview.requirements,references:setupReview.references,costs:setupReview.costs};
  const setupDraftBody={requestId:randomUUID(),reviewId:setupReview.setupReviewId,
   profileId:registered.id,capitalQuoteRaw:setupInput.capitalQuoteRaw,
  halfWidthTicks:setupInput.halfWidthTicks,wallet:operator,
  allocation:{token0Raw:setupReview.requirements.token0Raw,token1Raw:setupReview.requirements.token1Raw,
   nativeWei:'10000000000000000000'},limits:parameters.limits,reviewed};
 const setupDraftResponse=await post('/api/deployments/setup-drafts',setupDraftBody,auth);
 const setupDraftResult=await setupDraftResponse.json();
 if(setupDraftResponse.status!==201){
  const fields=['profileId','profileHash','input','source','profile','range','requirements','references'];
  const original=Object.fromEntries(fields.map(key=>[key,reviewed[key]]));
  const fresh=setupAdmissionFresh?Object.fromEntries(fields.map(key=>[key,setupAdmissionFresh[key]])):null;
  const equality= fresh?Object.fromEntries(fields.map(key=>[key,
   contentHash(original[key])===contentHash(fresh[key])])):null;
  const costIdentity=costs=>costs&&({scope:costs.scope,pathVersion:costs.pathVersion,sizeBand:costs.sizeBand,
   gasPriceWei:costs.gasPriceWei,boundGasPriceWei:costs.boundGasPriceWei,
   nativeReferencePrice:costs.nativeReferencePrice,
   stages:costs.stages?.map(stage=>({stage:stage.stage,profileId:stage.profileId,version:stage.version,
    evidenceClass:stage.evidenceClass,expectedGasUnits:stage.expectedGasUnits,
    boundGasUnits:stage.boundGasUnits,source:stage.source})),
   open:costs.open,closeRetain:costs.closeRetain});
  const originalCostIdentity=costIdentity(reviewed.costs),freshCostIdentity=costIdentity(setupAdmissionFresh?.costs);
  throw Error(`setup draft admission failed: ${JSON.stringify({httpStatus:setupDraftResponse.status,
   result:setupDraftResult,equality,costIdentityEqual:originalCostIdentity&&freshCostIdentity?
    contentHash(originalCostIdentity)===contentHash(freshCostIdentity):null,
   originalCosts:originalCostIdentity,freshCosts:freshCostIdentity,
   originalReferences:reviewed.references,freshReferences:setupAdmissionFresh?.references,
   originalSource:reviewed.source,freshSource:setupAdmissionFresh?.source})}`);
 }
 assert.equal(setupDraftResult.status,'draft_created');assert.equal(setupDraftResult.replayed,false);
 assert.equal(setupDraftResult.revision,1);assert.equal(setupDraftResult.source.block,setupReview.source.block);
 phase('static_setup_draft_created',{draftId:setupDraftResult.draftId,configHash:setupDraftResult.configHash,
  sourceAgeMs:Date.now()-Number(setupDraftResult.source.timestamp)*1000});
 campaign={id:setupDraftResult.draftId};
 const draft=await store.paperDraft(campaign.id);
 assert.equal(draft.strategyId,'static_manual_v1');assert.equal(draft.profileHash,registeredProfileHash);
 assert.deepEqual(draft.allocation,setupDraftBody.allocation);
 checks.push('authenticated setup draft admission persisted exactly reviewed allocation, limits and profile binding');

 const workerEnv={...process.env,DATABASE_URL:scopedUrl.toString(),ROBINHOOD_READ_HTTP_URL:readRpc,
  DEPLOYMENT_PAPER_OPERATION_WORKER:'1',DEPLOYMENT_PAPER_WORKER_INTERVAL_MS:'10000',
  DEPLOYMENT_PAPER_WORKER_MAX_CAMPAIGNS:'2',DEPLOYMENT_PAPER_WORKER_MAX_STEPS:'4',
  DEPLOYMENT_PAPER_OPERATION_MAX_PER_PASS:'4',CONC_LIQ_RUNTIME_IDENTITY:JSON.stringify(identity)};
 const startWorker=async()=>{
  workerOutput='';worker=sealedReleaseMode?launchSealed('deployments-paper-worker'):
   spawn(process.execPath,['--import','tsx','src/deployments-paper-worker.ts'],
    {cwd:process.cwd(),env:workerEnv,stdio:['ignore','pipe','pipe']});
  worker.stdout.setEncoding('utf8');worker.stderr.setEncoding('utf8');
  worker.stdout.on('data',chunk=>workerOutput+=chunk);worker.stderr.on('data',chunk=>workerOutput+=chunk);
  await waitFor(()=>store.paperOperationWorkerReady(),'paper worker readiness lease',30_000);
  phase('paper_worker_process_ready');
 };
 const runOpen=async()=>{
 const previewResponse=await post(`/api/deployments/${campaign.id}/previews`,{kind:'open'},auth,240_000);
  const preview=await previewResponse.json();
  assert.equal(previewResponse.status,200,JSON.stringify({httpStatus:previewResponse.status,preview}));
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
 let lastRetainOperation=null,lastRetainSignal=null;
 const closed=await waitFor(async()=>{
  const response=await fetch(origin+`/api/operations/${closeOperation.id}`,{headers:{cookie}});
  if(response.status!==200){lastRetainSignal=`http_${response.status}`;return null;}
  const row=await response.json();lastRetainOperation=row;
  const signal=JSON.stringify({status:row.status,stage:row.stage,reason:row.reason??null,
   attempts:row.attempts,updatedAt:row.updated_at});
  if(signal!==lastRetainSignal){lastRetainSignal=signal;
   phase('static_retain_worker_progress',{status:row.status,stage:row.stage,
    reason:row.reason??null,attempts:row.attempts,updatedAt:row.updated_at});}
  if(['blocked','rejected','cancelled'].includes(row.status))return row;
  return ['succeeded','completed'].includes(row.status)?row:null;
 },'static retain-close worker operation').catch(error=>{
  const row=lastRetainOperation;
  const workerTail=workerOutput.slice(-1200).replace(/https?:\/\/\S+/gi,'[redacted-url]');
  throw Error(`${error instanceof Error?error.message:'retain wait failed'}; last operation=${JSON.stringify(
   row?{status:row.status,stage:row.stage,reason:row.reason??null,attempts:row.attempts,
    updatedAt:row.updated_at}:null)}; worker=${workerTail}`);
 });
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
 await verifyClosedPositionsBrowser({origin,password,campaignId:campaign.id,
  expectedStages:['paper_open_recorded','paper_close_retain_recorded']});
 checks.push('closed-history Positions view renders actual operation stages on desktop and mobile');

 const ledger=(await admin.query(`SELECT count(*)::int AS n FROM deployment_ledger
  WHERE campaign_id=$1 AND kind='gas_paid'`,[campaign.id])).rows[0].n;
 assert.equal(ledger,0,'fork estimates must not become paid execution ledger rows');
 assert.equal(await store.paperOperationWorkerReady(),true);
 console.log(JSON.stringify({checks,campaignId:campaign.id,openOperationId:opened.operation.id,
  retainOperationId:closeOperation.id,gasReportHash:sampledGasReport?.reportHash??null,
  provisionalStages:sampledGasReport?.stageProfiles.map(stage=>stage.stage)??
   setupReview.costs.stages.map(stage=>stage.stage),paidGasLedgerRows:ledger,
  commandProcess:sealedReleaseMode?'verified sealed launch.mjs deployments':'source createDeploymentCommandServer',
  workerProcess:sealedReleaseMode?'verified sealed launch.mjs deployments-paper-worker':'source deployments-paper-worker.ts',
  release:releaseManifest?{buildId:releaseManifest.buildId,sourceCommit:releaseManifest.sourceCommit,verified:true}:null,
  signerLoaded:false,broadcasts:0,productionSchemaTouched:false,
  note:'Canonical sampling/profile import ran in the harness process; setup review and draft admission used authenticated command HTTP. No convert-close path was exercised.'},null,2));
}catch(error){cleanError(error);}
finally{
 if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await Promise.race([once(worker,'exit'),sleep(3000)]);
  if(worker.exitCode===null)worker.kill('SIGKILL');}
 if(command&&typeof command.close!=='function'&&command.exitCode===null){
  command.kill('SIGTERM');await Promise.race([once(command,'exit'),sleep(3000)]);
  if(command.exitCode===null)command.kill('SIGKILL');
 }
 if(command?.listening)await new Promise(resolve=>command.close(resolve));
 if(ws){try{ws.close();}catch{}}
 if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([once(chrome,'exit'),sleep(2000)]);
  if(chrome.exitCode===null)chrome.kill('SIGKILL');}
 if(chromeProfile)await rm(chromeProfile,{recursive:true,force:true});
 await dashboardPool?.end();await store?.close();
 try{await admin.query('SET search_path=public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
 finally{admin.release();await adminPool.end();if(runtimeTemp)await rm(runtimeTemp,{recursive:true,force:true});}
}

async function verifyClosedPositionsBrowser({origin,password,campaignId,expectedStages}){
 const candidates=process.env.CHROMIUM_PATH?[process.env.CHROMIUM_PATH]:[
  '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'];
 let binary=null;for(const candidate of candidates){try{await access(candidate);binary=candidate;break;}catch{}}
 if(!binary)throw Error('Chromium not found; set CHROMIUM_PATH');
 chromeProfile=await mkdtemp(`${tmpdir()}/conc-liq-static-canonical-positions-`);
 let stderr='',debugPort=0;const errors=[];
 chrome=spawn(binary,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
  '--user-data-dir='+chromeProfile,'about:blank'],{stdio:['ignore','ignore','pipe']});
 chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',chunk=>{stderr+=chunk;
  const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);if(match)debugPort=Number(match[1]);});
 for(let i=0;i<120&&!debugPort;i++){if(chrome.exitCode!==null)throw Error(`Chromium exited: ${stderr}`);await sleep(100);}
 assert(debugPort,'Chromium remote debugging did not start');
 const targets=await fetch(`http://127.0.0.1:${debugPort}/json`).then(response=>response.json()),
  target=targets.find(row=>row.type==='page');assert(target);
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let sequence=0;const pending=new Map(),browserPosts=[];
 ws.addEventListener('message',event=>{const message=JSON.parse(event.data);
  if(message.id){const item=pending.get(message.id);if(item){pending.delete(message.id);
   message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}}
  else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);
  else if(message.method==='Network.requestWillBeSent'&&message.params.request.method==='POST')
   browserPosts.push(new URL(message.params.request.url).pathname);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',
  {expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const wait=async(expression,label)=>{for(let i=0;i<240;i++){
  if(chrome.exitCode!==null)throw Error(`Chromium exited while waiting for ${label}: ${stderr}`);
  if(await evaluate(expression))return;await sleep(100);}
  throw Error(`Timed out waiting for ${label}; ${String(await evaluate("document.querySelector('#paper')?.innerText")).slice(0,1200)}`);};
 const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
  fill=(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});
   input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));
   input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:origin+'/operator'});
 await wait('document.readyState==="complete"','operator page');
 await wait('document.querySelectorAll("[role=tab]").length===2','two-tab dashboard');
 await fill('#operator-password',password);await click('#operator-login-form button[type=submit]');
 await wait('!document.querySelector("#operator-logout").hidden','operator login');
 assert.equal(await evaluate('document.querySelector("#operator-password").value'),'');
 await click('#positions-tab');
 await wait('document.querySelector("#paper .positions-table tbody tr")!==null','Positions list');
 await click('#paper [data-action="scope"][data-value="history"]');
 await wait(`document.querySelector('#paper .positions-table tbody tr[data-position="paper-dep-${campaignId}"]')!==null`,
  'closed campaign in Positions history');
 await click(`#paper .positions-table tbody tr[data-position="paper-dep-${campaignId}"] .position-select`);
 await wait('document.querySelector("#paper .position-detail .metrics")!==null','closed campaign detail');
 await click('#paper [data-action="tab"][data-value="activity"]');
 for(const stage of expectedStages)await wait(`document.querySelector('#paper .activity-list')?.textContent.includes(${JSON.stringify(stage)})`,
  `activity ${stage}`);
 const desktop=await evaluate(`(()=>({text:document.querySelector('#paper').innerText,
  activity:document.querySelector('#paper .activity-list')?.innerText,
  metrics:[...document.querySelectorAll('#paper .metric')].map(e=>e.innerText),
  scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}))()`);
 for(const stage of expectedStages)assert(desktop.activity.includes(stage),`desktop activity omits ${stage}`);
 assert(desktop.text.toLowerCase().includes('unavailable'),`desktop implies unavailable economics exist: ${desktop.text.slice(0,1200)}`);
 assert(desktop.scrollWidth<=desktop.viewport+1,`desktop horizontal overflow ${desktop.scrollWidth}/${desktop.viewport}`);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await sleep(250);
 const mobile=await evaluate(`(()=>({text:document.querySelector('#paper')?.innerText,
  activity:document.querySelector('#paper .activity-list')?.innerText,
  scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,
  detail:!!document.querySelector('#paper .position-detail')}))()`);
 assert(mobile.detail&&expectedStages.every(stage=>mobile.activity.includes(stage)),
  `mobile Positions lost closed campaign activity: ${JSON.stringify(mobile)}`);
 assert(mobile.text.toLowerCase().includes('unavailable'),'mobile view omitted unavailable economics label');
 assert(mobile.scrollWidth<=mobile.viewport+1,`mobile horizontal overflow ${mobile.scrollWidth}/${mobile.viewport}`);
 assert.deepEqual(errors,[],`browser exceptions: ${errors.join('; ')}`);
 assert.deepEqual(browserPosts,['/api/session'],'Positions browser should not submit an operation');
 ws.close();ws=null;chrome.kill('SIGTERM');await Promise.race([once(chrome,'exit'),sleep(1500)]);
 if(chrome.exitCode===null)chrome.kill('SIGKILL');chrome=null;
 await rm(chromeProfile,{recursive:true,force:true});chromeProfile=null;
}
