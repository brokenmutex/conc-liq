// Canonical static/manual V3 close-convert preview and default worker-function
// replay. Deployment writes stay in a temporary schema; indexed replay reads
// fall through to public in a read-only transaction/pool.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {createServer as createNetServer} from 'node:net';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {marketProfileSchema,verifyMarketProfile} from '../../src/deployments/market-profile.ts';
import {contentHash,staticManualParameters} from '../../src/deployments/contracts.ts';
import {readCanonicalPaperOpenFrame,buildIndicativePaperOpenPreview} from '../../src/deployments/paper-preview.ts';
import {readCanonicalPaperReplayHeadFrame,waitCanonicalPaperReplayHeadFrame} from
 '../../src/deployments/paper-replay-head-frame.ts';
import {costIndicativePaperOpenPreview} from '../../src/deployments/paper-cost.ts';
import {sampleStaticPaperGas} from '../../src/deployments/paper-gas-sampler.ts';
import {verifyPaperGasSource} from '../../src/deployments/paper-gas-source.ts';
import {persistTrustedPaperOpenPreview} from '../../src/deployments/paper-open-preflight.ts';
import {verifyCanonicalPaperAnchors} from '../../src/deployments/paper-canonical-anchors.ts';
import {processOnePaperOperation} from '../../src/deployments/paper-operation-worker.ts';
import {buildPaperPrincipalValuation} from '../../src/deployments/paper-valuation.ts';
import {recordCanonicalPaperFeeEvidence} from '../../src/deployments/paper-fee-replay.ts';
import {recordCanonicalNextPaperConversionAccountingV2} from '../../src/deployments/paper-accounting.ts';
import {readStaticPaperCloseConvertFeeContext} from '../../src/deployments/paper-close-convert-fee-reader.ts';
import {replayEphemeralStaticPaperCloseConvertFees} from '../../src/deployments/paper-close-convert-ephemeral-fees.ts';
import {buildStaticPaperCloseConvertRoute} from '../../src/deployments/paper-close-convert-preflight.ts';
import {persistStaticPaperCloseConvertPreviewFromPersistedFees} from
 '../../src/deployments/paper-close-convert-fee-reader.ts';
import {samplePaperCloseConvertPrestate} from '../../src/deployments/paper-close-convert-prestate-sampler.ts';
import {buildProspectivePaperCloseConvertPrestateGasProfiles}
 from '../../src/deployments/paper-close-convert-prestate-gas-profiles.ts';
import {createStaticPaperCloseConvertAcceptance} from
 '../../src/deployments/paper-close-convert-runtime.ts';
import {PAPER_CONVERSION_ACCOUNTING_POLICY_V3} from '../../src/deployments/paper-accounting.ts';
import {readDeploymentRows,deploymentPosition} from '../../src/dashboard/deployment-position.ts';
import {acquirePaperOperationReadinessLease,runPaperMaintenancePass} from
 '../../src/deployments-paper-worker.ts';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';

/** @type {Record<string, unknown>} */ const phaseTimes={};
const phase=(name,source)=>{phaseTimes[name]={at:new Date().toISOString(),sourceBlock:source?.block??null,
 sourceAgeMs:source?Date.now()-Number(source.timestamp)*1000:null};};
const fail=error=>{const msg=error instanceof Error?(error.stack??error.message):'canonical V3 worker fixture failed';
 process.stderr.write(`${msg.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,1000)}\n`+
  `phase_timing=${JSON.stringify(phaseTimes)}\n`);
 process.exitCode=1;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assertLocalDb=()=>{
 const url=new URL(process.env.TEST_DATABASE_URL??''),socket=url.searchParams.get('host');
 assert(['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname.toLowerCase())||
  Boolean(socket&&socket.startsWith('/')),'TEST_DATABASE_URL must use local PostgreSQL');
};
const rawUsd=usd=>String(BigInt(usd)*10n**18n);

async function main(){
 assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');assertLocalDb();
 const dotenv=parseEnv(readFileSync('.env','utf8')),
  archive=dotenv.ROBINHOOD_READ_HTTP_URL??dotenv.RH_ARCHIVE_RPC_URL,
  readRpc=dotenv.ROBINHOOD_READ_HTTP_URL??archive,
  stream=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
 assert(archive&&readRpc,'Canonical read/fork RPC unavailable');
 const rpc=createRobinhoodClient(readRpc,20_000,{retryCount:0}),
  rawProfile=parseRangeKeeperConfig(JSON.parse(readFileSync(
   'config/rangekeeper-v1-aapl-disabled.json','utf8'))),
  profile=marketProfileSchema.parse({pool:{...rawProfile.pool,factory:UNISWAP_V3_FACTORY,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER},
   referencePolicy:rawProfile.referencePolicy}),
  adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4}),
  admin=await adminPool.connect(),schema=`paper_v3_canonical_${randomUUID().replaceAll('-','')}`;
 let store,indexer,preparationLease,auxiliaryPreparationLease,operationReadyLease,commandServer;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
  await migrateDatabase(admin);
  // The migration creates empty replay tables in the isolated schema. Drop
  // only those isolated mirrors so the read-only worker/indexer pool resolves
  // the verified public replay source through its second search_path entry.
  await admin.query(`DROP TABLE v3_replay_cursors,v3_replay_ticks,v3_replay_pools,
   v3_pool_events CASCADE`);
  const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
  scopedUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=30000`);
  store=new DeploymentStore(scopedUrl.toString());await store.assertReady();
  const replayUrl=new URL(process.env.TEST_DATABASE_URL);
  replayUrl.searchParams.set('options',`-c default_transaction_read_only=on -c search_path=${schema},public`);
  indexer=new pg.Pool({connectionString:replayUrl.toString(),max:2,statement_timeout:30000});
  const replayIdentity=(await indexer.query(`SELECT r.chain_id::int,p.fee,
   r.target_set_hash,r.complete_through_block::text,r.complete_through_hash
   FROM v3_replay_cursors r JOIN v3_replay_pools p USING(stream_key)
   WHERE r.stream_key=$1 AND lower(p.pool_address)=lower($2) AND p.initialized=true`,
   [stream,profile.pool.pool])).rows;
  assert.equal(replayIdentity.length,1,'source replay pool unavailable');
  const identity=replayIdentity[0];
  assert.equal(identity.chain_id,profile.pool.chainId);assert.equal(identity.fee,profile.pool.fee);
  const verified=await verifyMarketProfile(rpc,profile,stream),
   risk=profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0;
  await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,
   rwa_address,fee,created_block,target_set_hash,enabled)
   VALUES($1,$2,$3,'AAPL',$4,$5,1,$6,true)`,
   [stream,profile.pool.pool,profile.pool.chainId,risk,profile.pool.fee,identity.target_set_hash]);
  const registered=await store.registerVerifiedMarketProfile(verified);
  const parameters=staticManualParameters.parse({halfWidthTicks:20,limits:{
   maxDeploymentValue:rawUsd(2_000),minDeploymentValue:rawUsd(1),maxExposurePpm:950_000,
   maxLossValue:rawUsd(100),maxDrawdownPpm:100_000,maxActionCost:rawUsd(100),
   maxRollingCost:rawUsd(200),maxCampaignCost:rawUsd(300),
   exitReserveWei:'1000000000000000',maxSlippageBps:50}}),
   // This is a $1 capability probe for the sampler's explicit 1% liquidity
   // share ceiling, not an economic suitability or deployment-size result.
   token0Raw=profile.pool.quoteToken===0?'1000000':'4000000000000000',
   token1Raw=profile.pool.quoteToken===1?'1000000':'4000000000000000',
   anchors=(chainId,sources)=>verifyCanonicalPaperAnchors(rpc,chainId,sources);
  process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify({buildId:contentHash({fixture:'canonical-v3',pid:process.pid}),
   configHash:contentHash({kind:'canonical-v3-worker-fixture'}),nodeVersion:process.version});
  let draft=await store.createDraft({mode:'paper',chainId:4663,
    wallet:'0x1111111111111111111111111111111111111111',marketProfileId:registered.id,
    strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
    allocation:{token0Raw,token1Raw,nativeWei:'10000000000000000000'},config:parameters});
  draft=await store.paperDraft(draft.id);

  // Real six-stage static open and source-exact worker booking.
  let frame=await readCanonicalPaperOpenFrame(rpc,profile),indicative=buildIndicativePaperOpenPreview(draft,frame);
  assert.equal(indicative.status,'indicative',`open candidate unavailable: ${indicative.reason}`);
  const openReport=await sampleStaticPaperGas({rpcUrl:archive,draft,frame,beforeRead:async()=>{},
   maxRequests:1600,timeoutMs:300_000});phase('openGasSampled',frame.source);
  const attestation=await verifyPaperGasSource(rpc,openReport),
   imported=await store.registerPaperGasEvidence(openReport,attestation);
  phase('openGasImported',frame.source);
  assert.equal(imported.created,true);
  const openGasSource=openReport.source;
  assert.equal(String(openGasSource.block),frame.source.block,'open gas report source block changed');
  assert.equal(String(openGasSource.hash).toLowerCase(),frame.source.hash.toLowerCase(),
   'open gas report source hash changed');
  // Keep the exact sampled source and candidate scope. The cost resolver
  // binds profiles to the source tick's range; refreshing to a new head here
  // could move the centered range before the preview is persisted.
  draft=await store.paperDraft(draft.id);
  indicative=buildIndicativePaperOpenPreview(draft,frame);
  const openGasRows=await store.paperGasProfiles(profile.pool.pool);
  const costed=costIndicativePaperOpenPreview(indicative,
   openGasRows,profile.pool.pool,frame.nativePrice??0n,
   await rpc.getGasPrice());
  phaseTimes['openCosted']={at:new Date().toISOString(),status:indicative.status,
   reason:'reason' in indicative?indicative.reason:null,costStatus:costed.costs.status,
   costReason:'reason' in costed.costs?costed.costs.reason:null,gasProfileRows:openGasRows.length,
   sourceBlock:frame.source.block,tick:frame.tick,range:costed.candidate?.range??null};
  assert.equal(costed.costs.status,'provisional',
   `open cost replay unavailable: ${JSON.stringify(phaseTimes['openCosted'])}`);
  const openPreview=await persistTrustedPaperOpenPreview({store,draft,frame,preview:costed,verifyAnchors:anchors}),
   openAcceptance=await store.acceptStaticPaperOpenOperation(draft.id,{previewId:openPreview.id,
    contentDigest:openPreview.contentDigest,expectedRevision:openPreview.expectedRevision,
    idempotencyKey:`canonical-open-${randomUUID()}`},'fixture_operator',anchors),
   openWorker=await processOnePaperOperation(store,rpc,indexer,'canonical-open-worker',
    {rpcUrl:archive});
  assert.equal(openWorker.status,'completed');assert.equal(openAcceptance.status,'queued');
  phase('openBooked',frame.source);

  // Pin the prior principal valuation to the exact indexed replay cursor, then
  // let canonical fee replay/V2 projection establish the saved predecessor.
  const openingState=await store.paperValuationState(draft.id),streamEvidence=(await admin.query(
   `SELECT evidence FROM deployment_market_profiles WHERE id=$1`,[registered.id])).rows[0].evidence,
   targetSetHash=streamEvidence.indexerTargetSetHash;
  const replayFrame=await waitReplayAfter({client:rpc,indexer,profile,stream,targetSetHash,
   previous:openingState.previous});
  const valuation=buildPaperPrincipalValuation(openingState.openModel,openingState.openMarkId,
   openingState.previous,replayFrame,profile);
  const valuationResult=await store.recordTrustedPaperPrincipalValuation(valuation);
  phase('feeValuation',replayFrame.source);
  await recordCanonicalPaperFeeEvidence(store,rpc,indexer,draft.id);
  for(let n=0;n<8;n++){
   const next=await recordCanonicalNextPaperConversionAccountingV2(store,rpc,draft.id);
   if(next===null)break;
  }
  let context=await readStaticPaperCloseConvertFeeContext({store,campaignId:draft.id,
   revision:1,verifyAnchors:anchors});
  assert.equal(context.state.previous.markId,valuationResult.markId,
   'fixture latest mark changed before conversion preview');
  phase('feeCarryReady',context.state.previous.source);

  // The candidate source must be a later, fresh replay cursor than the exact
  // persisted fee carry. No terminal mark is inserted by preview sampling.
  // Freeze mutable maintenance only after the latest valuation/V2 predecessor
  // is saved. Audits must continue while the supervised pass skips mutation.
  const beforePreparation=await store.paperValuationState(draft.id);
  preparationLease=await store.acquireStaticPaperCloseConvertPreparationLease(draft.id);
  auxiliaryPreparationLease=await store.acquireStaticPaperCloseConvertPreparationLease(randomUUID());
  await assert.rejects(store.acquireStaticPaperCloseConvertPreparationLease(randomUUID()),
   /timeout exceeded when trying to connect/);
  const writerProbe=await store.createDraft({mode:'paper',chainId:4663,
   wallet:'0x2222222222222222222222222222222222222222',marketProfileId:registered.id,
   strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
   allocation:{token0Raw,token1Raw,nativeWei:'10000000000000000000'},config:parameters});
  assert(writerProbe.id,'writer transaction starved by retained preparation lease clients');
  await auxiliaryPreparationLease.release();auxiliaryPreparationLease=undefined;
  const maintenance=await runPaperMaintenancePass(store,rpc,indexer,1,2);
  assert.equal(maintenance.status,'completed');assert.equal(maintenance.failed,0);
  assert.equal(maintenance.invalidated,0);assert.equal(maintenance.preparationSkipped,1);
  const afterMaintenance=await store.paperValuationState(draft.id);
  assert.equal(afterMaintenance.previous.markId,beforePreparation.previous.markId,
   'supervised maintenance appended a mark while preview preparation held the exclusive lease');
  assert.equal(afterMaintenance.previous.source.hash,beforePreparation.previous.source.hash);
  frame=await waitCanonicalPaperReplayHeadFrame({client:rpc,indexer,profile,stream,targetSetHash,
   previous:context.state.previous,assertPreparationLeaseHealthy:()=>preparationLease.assertHealthy()});
  const route=buildStaticPaperCloseConvertRoute(context.state),
   feeReplay=await replayEphemeralStaticPaperCloseConvertFees({context,client:rpc,indexer,frame}),
   report=await samplePaperCloseConvertPrestate({rpcUrl:archive,openModel:context.state.openModel,
    openMarkId:context.state.openMarkId,profile,frame,
    previous:{markId:context.state.previous.markId,source:context.state.previous.source},
    route,feeCarry:feeReplay.feeCarry,feeReplay,
    verifyPersistedContext:()=>context.verifyPersistedContext({state:context.state,
     feeCarry:context.feeCarry,feeEvidence:context.feeEvidence,source:frame.source}),
    verifyAnchors:anchors,beforeRead:async()=>{},deterministicClock:true});
  phase('terminalReport',frame.source);
  await store.registerStaticPaperCloseConvertPrestateGas({report,verifyAnchors:anchors,
   verifyFeeReplay:async()=>{
    const current=await readStaticPaperCloseConvertFeeContext({store,campaignId:draft.id,
     revision:1,verifyAnchors:anchors});
    return replayEphemeralStaticPaperCloseConvertFees({context:current,client:rpc,indexer,frame});
   }});
  const gasPriceWei=await rpc.getGasPrice(),sizeBand=
   buildProspectivePaperCloseConvertPrestateGasProfiles(report).sizeBand,
   profiles=await store.staticPaperCloseConvertPrestateGasProfiles({chainId:profile.pool.chainId,
    poolAddress:profile.pool.pool,sizeBand,reportHash:report.reportHash});
  const preview=await persistStaticPaperCloseConvertPreviewFromPersistedFees({store,
   campaignId:draft.id,expectedRevision:1,client:rpc,indexer,frame,postWithdraw:report.postWithdraw,
   prestateReport:report,prestateCostProfiles:profiles,gasPriceWei,verifyAnchors:anchors,
   verifyOwnedFork:async replay=>{
    assert.equal(replay.state.openModel.candidateHash,report.openModel.candidateHash);
    assert.equal(replay.frame.source.hash,report.frame.source.hash);
    assert.equal(replay.quote.quoteHash,report.quote.quoteHash);
    return {reportHash:report.reportHash,
     postWithdrawReplayHash:report.postWithdraw.postWithdrawReplayHash,
     sourceReplayHash:report.sourceReplayHash,source:report.frame.source,
     gasScopeHash:report.gasScopeHash,gasSequenceHash:report.gasSequenceHash,
     gasStages:report.gasStages.map(stage=>({stage:stage.stage,source:stage.source,
      sourceHash:stage.sourceHash,callHash:stage.callHash,
      gasUnitsExpected:stage.gasUnitsExpected,gasUnitsBound:stage.gasUnitsBound}))};
   }});
  preparationLease.retainUntil(new Date(preview.expiresAt));
  phase('terminalPreview',frame.source);
  assert.equal(preview.actionAvailable,false);assert.equal(preview.operationAcceptanceAvailable,false);
  assert.equal(preview.source.block,frame.source.block);
  const afterPreview=await store.paperValuationState(draft.id);
  assert.equal(afterPreview.previous.markId,context.state.previous.markId,
   'preview must not append a terminal/latest mark');

  const acceptRequest={previewId:preview.id,contentDigest:preview.contentDigest,expectedRevision:1,
   idempotencyKey:`canonical-v3-${randomUUID()}`};
  const acceptStaticPaperCloseConvert=createStaticPaperCloseConvertAcceptance({store,
   client:rpc,indexer,rpcUrl:archive,verifyAnchors:anchors});
  const password=randomBytes(24).toString('hex'),salt=randomBytes(16),
   passwordHash=`scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
  operationReadyLease=await acquirePaperOperationReadinessLease(indexer);
  const reservation=createNetServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const reservedAddress=reservation.address();assert(reservedAddress&&typeof reservedAddress!=='string');
  const commandPort=reservedAddress.port;
  await new Promise((resolve,reject)=>reservation.close(error=>{
   if(error)reject(error);else resolve(undefined);
  }));
  const commandOrigin=`http://127.0.0.1:${commandPort}`;
  commandServer=createDeploymentCommandServer(store,{origin:commandOrigin,passwordHash,
   paperPreview:async()=>preview,paperRetainWorkerReady:()=>store.paperOperationWorkerReady(),
   paperConvertPreparationReady:campaignId=>store.staticPaperCloseConvertPreparationReady(campaignId),
   paperConvertAcceptance:acceptStaticPaperCloseConvert,
   paperOperationReplay:(campaignId,input,allowedKinds)=>
    store.acceptedOperationReplay(campaignId,input,allowedKinds)});
  commandServer.listen(commandPort,'127.0.0.1');await once(commandServer,'listening');
  const postCommand=(path,body,headers={})=>fetch(commandOrigin+path,{method:'POST',
   headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const login=await postCommand('/api/session',{password},{origin:commandOrigin});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie);
  const {csrfToken}=await login.json(),commandHeaders={origin:commandOrigin,cookie,
   'x-csrf-token':csrfToken};
  const reviewResponse=await postCommand(`/api/deployments/${draft.id}/previews`,
   {kind:'close_convert'},commandHeaders);
  assert.equal(reviewResponse.status,200);const httpReview=await reviewResponse.json();
  assert.equal(httpReview.actionAvailable,true,'HTTP preview should be actionable only under live leases');
  // Dropping the supervised worker lease hides review acceptance without
  // dropping the still-valid preparation lease; restore readiness for submit.
  await operationReadyLease.release();operationReadyLease=undefined;
  const noWorkerReview=await postCommand(`/api/deployments/${draft.id}/previews`,
   {kind:'close_convert'},commandHeaders);
  assert.equal((await noWorkerReview.json()).actionAvailable,false);
  operationReadyLease=await acquirePaperOperationReadinessLease(indexer);
  const acceptResponse=await postCommand(`/api/deployments/${draft.id}/close-convert-operations`,
   acceptRequest,commandHeaders);
  assert.equal(acceptResponse.status,202);const accepted=await acceptResponse.json();
  assert.equal(accepted.status,'queued');assert.equal(accepted.replayed,false);
  phase('terminalAccepted',frame.source);
  // The acceptance callback released its preparation lease. Reconcile a
  // simulated lost response before readiness checks using the same key.
  await operationReadyLease.release();operationReadyLease=undefined;
  const sameKeyRetry=await postCommand(`/api/deployments/${draft.id}/close-convert-operations`,
   acceptRequest,commandHeaders);
  assert.equal(sameKeyRetry.status,202);assert.equal((await sameKeyRetry.json()).replayed,true);
  const freshRequest={...acceptRequest,idempotencyKey:`canonical-v3-fresh-${randomUUID()}`},
   noLeaseFresh=await postCommand(`/api/deployments/${draft.id}/close-convert-operations`,
    freshRequest,commandHeaders);
  assert.equal(noLeaseFresh.status,503);
  assert.deepEqual(await noLeaseFresh.json(),{error:'paper_close_convert_preparation_unavailable'});
  commandServer.close();await once(commandServer,'close');commandServer=undefined;
  await assert.rejects(store.readStaticPaperCloseConvertFeeCarry({campaignId:draft.id,revision:1}),
   /paper_close_convert_fee_operation_pending/);
  const replayBinding=operation=>store.readStaticPaperCloseConvertFeeCarry({campaignId:draft.id,
   revision:1,operation:{id:accepted.id,workerId:'canonical-v3-worker',modelHash:preview.modelHash,
    ...operation}});
  await assert.rejects(replayBinding({id:'00000000-0000-4000-8000-000000000001'}),
   /paper_close_convert_fee_operation_binding_invalid/);
  await assert.rejects(replayBinding({workerId:'wrong-worker'}),
   /paper_close_convert_fee_operation_binding_invalid/);
  await assert.rejects(replayBinding({modelHash:'f'.repeat(64)}),
   /paper_close_convert_fee_operation_binding_invalid/);
  await assert.rejects(replayBinding({}),/paper_close_convert_fee_operation_binding_invalid/);
  const completed=await processOnePaperOperation(store,rpc,indexer,'canonical-v3-worker',
   {rpcUrl:archive});
  assert.equal(completed.status,'completed',JSON.stringify(completed));
  assert.equal(completed.operationId,accepted.id);
  phase('workerCompleted',frame.source);
  const rows=await readDeploymentRows(admin),position=rows.map(deploymentPosition).find(row=>
   row.id===`paper-dep-${draft.id}`);
  assert(position);assert.equal(position.deployment.conversionAccountingStatus,'available');
  assert.equal(position.deployment.accounting?.policyVersion,
   PAPER_CONVERSION_ACCOUNTING_POLICY_V3);
  assert.equal(position.accounting,'provisional');
  const terminalRows=(await admin.query(`SELECT count(*)::int AS n FROM deployment_marks
   WHERE campaign_id=$1 AND provenance->>'operationId'=$2`,[draft.id,accepted.id])).rows[0].n,
   ledger=(await admin.query(`SELECT count(*)::int AS n FROM deployment_ledger
    WHERE campaign_id=$1 AND operation_id=$2`,[draft.id,accepted.id])).rows[0].n;
  assert.equal(terminalRows,1);assert.equal(ledger,3);
  console.log(JSON.stringify({status:'canonical_v3_worker_fixture_passed',phaseTiming:phaseTimes,
   latestMarkBeforePreview:context.state.previous.source.block,replaySource:frame.source.block,
   replayAgeMs:Date.now()-frame.source.timestamp*1000,openOperationId:openAcceptance.id,
   closeOperationId:accepted.id,completed:completed.stage,terminalMarks:terminalRows,
   modeledLedgerRows:ledger,paidCostsAvailable:false,actionAvailable:preview.actionAvailable,
   httpReviewActionAvailable:httpReview.actionAvailable,httpAcceptanceReplayed:sameKeyRetry.status===202,
   isolatedDeploymentSchema:true,sourceIndexerReadOnly:true,signerLoaded:false,broadcasts:0},null,2));
 }finally{
  await operationReadyLease?.release().catch(()=>{});
  if(commandServer){commandServer.close();await once(commandServer,'close').catch(()=>{});}
  await preparationLease?.release().catch(()=>{});
  await auxiliaryPreparationLease?.release().catch(()=>{});
  await indexer?.end();await store?.close();
  try{await admin.query('SET search_path=public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}
  finally{admin.release();await adminPool.end();}
 }
}

async function waitReplayAfter(input){
 const deadline=Date.now()+240_000;let lastError;
 while(Date.now()<deadline){
  try{return await readCanonicalPaperReplayHeadFrame(input);}
  catch(error){
   if(!(error instanceof Error)||!['paper_replay_head_not_later_than_previous_mark',
    'paper_replay_head_stale'].some(code=>error.message.includes(code)))throw error;
   lastError=error;await sleep(5000);
  }
 }
 throw lastError??Error('paper_replay_head_wait_timeout');
}

main().catch(fail);
