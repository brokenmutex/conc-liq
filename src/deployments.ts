import {once} from 'node:events';
import {Pool} from 'pg';
import {z} from 'zod';
import {DeploymentStore} from './deployments/store.js';
import {DeploymentConflict} from './deployments/store.js';
import {contentHash} from './deployments/contracts.js';
import {safePaperDiagnosticFailure} from './deployments/paper-diagnostic.js';
import {createDeploymentCommandServer} from './deployments/server.js';
import {buildIndicativePaperOpenPreview,readCanonicalPaperOpenFrame,readCanonicalPaperNextFrame,
 type PaperOpenFrame} from './deployments/paper-preview.js';
import {buildStaticPaperSetupPreflight} from './deployments/paper-setup-preflight.js';
import {createStaticPaperDraftFromSetup} from './deployments/static-paper-draft-admission.js';
import {StaticPaperSetupReviewCache} from './deployments/static-paper-setup-review-cache.js';
import {costIndicativePaperOpenPreview} from './deployments/paper-cost.js';
import {prepareStaticPaperGasForCandidate} from './deployments/static-paper-gas-preparation.js';
import {prepareStaticPaperSetup} from './deployments/static-paper-setup-preparation.js';
import {sampleStaticPaperGas} from './deployments/paper-gas-sampler.js';
import {safePaperGasVerifyFailure,verifyPaperGasSource} from './deployments/paper-gas-source.js';
import {persistTrustedPaperOpenPreview} from './deployments/paper-open-preflight.js';
import {readCanonicalRangeKeeperPaperOpenModel,
 type RangeKeeperPaperDraft} from './deployments/rangekeeper-paper-open-model.js';
import {loadRangeKeeperPaperExitContext,rangeKeeperPaperExitContextSeed} from './deployments/rangekeeper-paper-context.js';
import {buildRangeKeeperPaperExitModel} from './deployments/rangekeeper-paper-exit-model.js';
import {verifyCanonicalPaperAnchors} from './deployments/paper-canonical-anchors.js';
import {persistTrustedStaticPaperRetainPreview} from './deployments/paper-close-retain-preflight.js';
import {buildStaticPaperCloseConvertRoute} from './deployments/paper-close-convert-preflight.js';
import {readStaticPaperCloseConvertFeeContext,
 persistStaticPaperCloseConvertPreviewFromPersistedFees} from
 './deployments/paper-close-convert-fee-reader.js';
import {replayEphemeralStaticPaperCloseConvertFees} from './deployments/paper-close-convert-ephemeral-fees.js';
import {waitCanonicalPaperReplayHeadFrame} from './deployments/paper-replay-head-frame.js';
import {samplePaperCloseConvertPrestate} from './deployments/paper-close-convert-prestate-sampler.js';
import {buildProspectivePaperCloseConvertPrestateGasProfiles} from
 './deployments/paper-close-convert-prestate-gas-profiles.js';
import {createStaticPaperCloseConvertAcceptance} from
 './deployments/paper-close-convert-runtime.js';
import type {PaperCanonicalAnchor} from './deployments/paper-canonical-anchors.js';
import {createRobinhoodClient} from './client.js';
import {log} from './logger.js';
import {loadDashboardConfig} from './dashboard/config.js';
import {DashboardRepository} from './dashboard/repository.js';

const envSchema=z.object({
 DATABASE_URL:z.string().min(1),
 DEPLOYMENT_HOST:z.enum(['127.0.0.1','::1']).default('127.0.0.1'),
 DEPLOYMENT_PORT:z.coerce.number().int().min(1).max(65535).default(4174),
 DEPLOYMENT_PUBLIC_ORIGIN:z.string().optional(),
 ROBINHOOD_READ_HTTP_URL:z.url(),
 PAPER_FORK_RPC_URL:z.url().optional(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000),
});

async function main(){
 const env=envSchema.parse(process.env);
 const store=new DeploymentStore(env.DATABASE_URL);
 const dashboardConfig=loadDashboardConfig(process.env),dashboard=new DashboardRepository(dashboardConfig),
  indexer=new Pool({connectionString:dashboardConfig.databaseUrl,max:2,
   options:'-c default_transaction_read_only=on'});
 try{await store.assertReady();}
 catch(error){await Promise.allSettled([store.close(),dashboard.close(),indexer.end()]);throw error;}
 try{await dashboard.assertReady();}
 catch(error){await Promise.allSettled([store.close(),dashboard.close(),indexer.end()]);throw error;}
 const host=env.DEPLOYMENT_HOST,port=env.DEPLOYMENT_PORT;
 const origin=`http://${host==='::1'?'[::1]':host}:${port}`;
 const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS);
 let previewBusy=false,paperSetupBusy=false;
 const setupDiagnosticsEnabled=process.env.DEPLOYMENT_PAPER_SETUP_DIAGNOSTICS==='1',
  setupDiagnostic=setupDiagnosticsEnabled?
  (stage:string,reason:string)=>{try{log('warn','paper_setup_preparation_diagnostic',{stage,reason});}
   catch{}}:undefined;
 const setupFrameDiagnostic=(campaignId:string,frame:PaperOpenFrame)=>{
  if(!setupDiagnosticsEnabled)return;
  try{
   const binding={source:{block:frame.source.block,hash:frame.source.hash,
    timestamp:frame.source.timestamp},tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
    poolLiquidity:String(frame.poolLiquidity),referenceProofHash:frame.referenceProofHash};
   log('info','paper_conversion_prestate_frame',{campaignId,...binding,frameHash:contentHash(binding)});
  }catch{}
 };
 const paperSetupReviewCache=new StaticPaperSetupReviewCache();
 const runStaticSetupPreflight=async(input:Parameters<typeof buildStaticPaperSetupPreflight>[0],
  pinnedSource?:PaperOpenFrame['source'])=>buildStaticPaperSetupPreflight(input,{
   loadProfile:id=>store.paperSetupProfile(id),
   readFrame:(profile,source)=>readCanonicalPaperOpenFrame(client,profile,source),
   verifyCanonical:(chainId,source)=>verifyCanonicalPaperAnchors(client,chainId,[source]),
   readGasProfiles:pool=>store.paperGasProfiles(pool),readGasPrice:()=>client.getGasPrice(),
  },pinnedSource);
 const paperSetupPreflight=async(input:Parameters<typeof buildStaticPaperSetupPreflight>[0],
  pinnedSource?:PaperOpenFrame['source'])=>{
  if(paperSetupBusy)throw new DeploymentConflict('paper_setup_preflight_busy');
  paperSetupBusy=true;
  try{
   if(pinnedSource||!input.limits)return await runStaticSetupPreflight(input,pinnedSource);
   const result=await prepareStaticPaperSetup(input,{runPreflight:runStaticSetupPreflight,
    loadProfile:id=>store.paperSetupProfile(id),
    readFrame:(profile,source)=>readCanonicalPaperOpenFrame(client,profile,source),
    forkRpcUrl:env.PAPER_FORK_RPC_URL??null,
    sample:(draft,frame)=>sampleStaticPaperGas({rpcUrl:env.PAPER_FORK_RPC_URL!,draft,frame,
     beforeRead:async()=>{},maxRequests:1600,timeoutMs:150_000}),
    verify:async report=>{
     try{return await verifyPaperGasSource(client,report);}
     catch(error){setupDiagnostic?.('paper_gas_sample_source_verify',safePaperGasVerifyFailure(error));throw error;}
    },
    importEvidence:async(report,attestation)=>{
     const result=await store.registerPaperGasEvidence(report,attestation);
     if(typeof result.reportHash!=='string')throw new Error('paper_gas_import_report_hash_unavailable');
     return {created:result.created,reportHash:result.reportHash};
    },
    diagnostic:setupDiagnostic,
   });
   if(result&&typeof result==='object'&&!Array.isArray(result)){
    const row=result as Record<string,unknown>,captured=paperSetupReviewCache.capture(row);
    if(captured)return {...row,...captured};
    if(row.status==='available')return {...row,status:'unavailable',costs:{status:'unavailable',
     reason:'setup_review_snapshot_unavailable'},missing:['setup_review_snapshot_unavailable'],
     actionAvailable:false,draftCreated:false,operationCreated:false};
   }
   return result;
  }finally{paperSetupBusy=false;}
 };
 const paperSetupDraftAdmission=(input:unknown)=>createStaticPaperDraftFromSetup(input,{
  runPreflight:paperSetupPreflight,
  loadProfile:id=>store.paperSetupProfile(id),
  lookupCapturedReview:review=>paperSetupReviewCache.lookup(review),
  findDraftRequest:(requestId,draft)=>store.findDraftRequest(requestId,draft),
  createDraftWithRequestId:(requestId,draft)=>store.createDraftWithRequestId(requestId,draft),
 });
 const paperPreview=async(campaignId:string,kind:'open'|'pause'|'resume'|'close_retain'|'close_convert')=>{
  if(previewBusy)throw new DeploymentConflict('paper_preview_busy');
  previewBusy=true;
  try{
   if(kind==='pause'||kind==='resume'){
    try{return await store.recordPaperLifecyclePreview(campaignId,kind);}
    catch(error){return {kind,status:'unavailable',campaignId,
     reason:error instanceof DeploymentConflict?error.code:'paper_lifecycle_preview_unavailable',
     source:null,economics:null,actionAvailable:false,operationAcceptanceAvailable:false};}
   }
   if(kind!=='open'){
   const strategyId=await store.paperStrategyId(campaignId);
    if(strategyId==='static_manual_v1'){
     if(kind==='close_convert'){
      if(!env.PAPER_FORK_RPC_URL)return {status:'unavailable',kind,campaignId,actionAvailable:false,
       operationAcceptanceAvailable:false,reason:'static_manual_conversion_fork_rpc_unavailable'};
      let preparationLease:Awaited<ReturnType<typeof store.acquireStaticPaperCloseConvertPreparationLease>>;
      try{preparationLease=await store.acquireStaticPaperCloseConvertPreparationLease(campaignId);}
      catch(error){return {status:'unavailable',kind,campaignId,actionAvailable:false,
       operationAcceptanceAvailable:false,reason:error instanceof DeploymentConflict?error.code:
        'static_manual_conversion_preparation_busy'};}
      let previewLeaseRetained=false;
      let conversionPrestateStage='saved_state';
      try{
       const valuation=await store.paperValuationState(campaignId);
       conversionPrestateStage='fee_context';
       const context=await readStaticPaperCloseConvertFeeContext({store,campaignId,
         revision:valuation.openModel.revision,verifyAnchors:(chainId,sources)=>
          verifyCanonicalPaperAnchors(client,chainId,sources)});
       conversionPrestateStage='replay_head';
       const frame=await waitCanonicalPaperReplayHeadFrame({client,indexer,
         profile:context.state.profile,stream:context.stream,targetSetHash:context.targetSetHash,
         previous:context.state.previous,assertPreparationLeaseHealthy:()=>preparationLease.assertHealthy()});
       setupFrameDiagnostic(campaignId,frame);
       await preparationLease.assertHealthy();
       conversionPrestateStage='route';
       const route=buildStaticPaperCloseConvertRoute(context.state);
       conversionPrestateStage='fee_replay';
       const feeReplay=await replayEphemeralStaticPaperCloseConvertFees({context,client,indexer,frame});
       conversionPrestateStage='owned_fork_sample';
       const report=await samplePaperCloseConvertPrestate({rpcUrl:env.PAPER_FORK_RPC_URL,
         openModel:context.state.openModel,openMarkId:context.state.openMarkId,
         profile:context.state.profile,frame,previous:{markId:context.state.previous.markId,
          source:context.state.previous.source},route,feeCarry:feeReplay.feeCarry,feeReplay,
         verifyPersistedContext:()=>context.verifyPersistedContext({state:context.state,
          feeCarry:context.feeCarry,feeEvidence:context.feeEvidence,source:frame.source}),
         verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources),
         beforeRead:async()=>{},deterministicClock:true});
       await preparationLease.assertHealthy();
       conversionPrestateStage='gas_registration';
       await store.registerStaticPaperCloseConvertPrestateGas({report,
        verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources),
        verifyFeeReplay:async()=>{
         const current=await readStaticPaperCloseConvertFeeContext({store,campaignId,
          revision:context.state.openModel.revision,verifyAnchors:(chainId,sources)=>
           verifyCanonicalPaperAnchors(client,chainId,sources)});
         return replayEphemeralStaticPaperCloseConvertFees({context:current,client,indexer,frame});
        }});
       conversionPrestateStage='cost_profiles';
        const gasPriceWei=await client.getGasPrice(),sizeBand=
        buildProspectivePaperCloseConvertPrestateGasProfiles(report).sizeBand,prestateCostProfiles=
        await store.staticPaperCloseConvertPrestateGasProfiles({chainId:context.state.profile.pool.chainId,
         poolAddress:context.state.profile.pool.pool,sizeBand,reportHash:report.reportHash});
       conversionPrestateStage='preview_persistence';
       const saved=await persistStaticPaperCloseConvertPreviewFromPersistedFees({store,campaignId,
        expectedRevision:context.state.openModel.revision,client,indexer,frame,
        postWithdraw:report.postWithdraw,prestateReport:report,prestateCostProfiles,gasPriceWei,
        verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>
         verifyCanonicalPaperAnchors(client,chainId,sources),
        verifyOwnedFork:async (replayInput:Parameters<NonNullable<Parameters<
         typeof persistStaticPaperCloseConvertPreviewFromPersistedFees>[0]['verifyOwnedFork']>>[0])=>{
         if(replayInput.state.openModel.candidateHash!==report.openModel.candidateHash||
          replayInput.frame.source.hash.toLowerCase()!==report.frame.source.hash.toLowerCase()||
          replayInput.route.routeHash!==report.route.routeHash||
          replayInput.postWithdraw.postWithdrawReplayHash!==report.postWithdraw.postWithdrawReplayHash||
          replayInput.quote.quoteHash!==report.quote.quoteHash||
          replayInput.inventory.token0Raw!==report.inventory.token0Raw||
          replayInput.inventory.token1Raw!==report.inventory.token1Raw)
          throw new DeploymentConflict('paper_close_convert_prestate_source_changed');
         return {reportHash:report.reportHash,postWithdrawReplayHash:report.postWithdraw.postWithdrawReplayHash,
          sourceReplayHash:report.sourceReplayHash,source:report.frame.source,
          gasScopeHash:report.gasScopeHash,gasSequenceHash:report.gasSequenceHash,
          gasStages:report.gasStages.map(stage=>({stage:stage.stage,source:stage.source,
           sourceHash:stage.sourceHash,callHash:stage.callHash,
           gasUnitsExpected:stage.gasUnitsExpected,gasUnitsBound:stage.gasUnitsBound}))};
        }});
       await preparationLease.assertHealthy();
       preparationLease.retainUntil(new Date(saved.expiresAt));previewLeaseRetained=true;
       return saved;
      }catch(error){setupDiagnostic?.(`paper_conversion_prestate_${conversionPrestateStage}`,
       safePaperDiagnosticFailure(error));return {status:'unavailable',kind,campaignId,actionAvailable:false,
       operationAcceptanceAvailable:false,reason:error instanceof DeploymentConflict?error.code:
        'static_manual_conversion_prestate_unavailable'};}
      finally{if(!previewLeaseRetained)await preparationLease.release().catch(()=>{});}
     }
     let state;
     try{state=await store.paperValuationState(campaignId);}
     catch{return {status:'unavailable',kind,campaignId,actionAvailable:false,
      reason:'static_manual_saved_open_or_current_mark_unavailable'};}
     let frame:PaperOpenFrame;
     // This reader checks the previous mark anchor before and after sampling;
     // the following explicit batch also rechecks the saved open and new frame.
     try{frame=await readCanonicalPaperNextFrame(client,state.profile,state.previous);}
     catch{return {status:'unavailable',kind,campaignId,actionAvailable:false,
      reason:'static_manual_canonical_terminal_source_unavailable'};}
     let gasPriceWei=0n;
     try{gasPriceWei=await client.getGasPrice();}
     catch{return {status:'unavailable',kind,campaignId,actionAvailable:false,
      reason:'static_manual_terminal_gas_price_unavailable'};}
     let gasProfiles;
     try{gasProfiles=await store.paperGasProfiles(state.profile.pool.pool);}
     catch{return {status:'unavailable',kind,campaignId,actionAvailable:false,
      reason:'static_manual_terminal_cost_profiles_unavailable'};}
     try{return await persistTrustedStaticPaperRetainPreview({store,state,frame,gasProfiles,
      gasPriceWei,verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources)});}
     catch(error){return {status:'unavailable',kind,campaignId,actionAvailable:false,
      operationAcceptanceAvailable:false,reason:error instanceof DeploymentConflict?
       error.code:'static_manual_terminal_preview_unavailable'};}
    }
    if(strategyId!=='rangekeeper_v1')return {status:'unavailable',
     reason:'paper_terminal_preview_strategy_unavailable',campaignId,actionAvailable:false};
    const snapshot=await store.rangeKeeperPaperExitContextSnapshot(campaignId),
     seed=rangeKeeperPaperExitContextSeed(snapshot,campaignId);
    if(!seed)return {status:'unavailable',reason:'rangekeeper_persisted_context_unavailable',
     campaignId,actionAvailable:false};
    let buildId='';
    try{
     const identity=JSON.parse(process.env.CONC_LIQ_RUNTIME_IDENTITY??'null') as unknown;
     if(identity&&typeof identity==='object'&&typeof (identity as {buildId?:unknown}).buildId==='string')
      buildId=(identity as {buildId:string}).buildId;
    }catch{/* Missing or malformed release identity leaves the preview unavailable. */}
    if(!buildId)return {status:'unavailable',reason:'rangekeeper_runtime_build_identity_unavailable',
     campaignId,actionAvailable:false};
    let frame:PaperOpenFrame;
    try{frame=await readCanonicalPaperNextFrame(client,seed.profile,
     {sourceBlock:seed.previousSource.block,sourceHash:seed.previousSource.hash});}
    catch{return {status:'unavailable',reason:'rangekeeper_canonical_exit_source_unavailable',
     campaignId,actionAvailable:false};}
    try{await verifyCanonicalPaperAnchors(client,seed.profile.pool.chainId,
     [seed.openSource,seed.previousSource,frame.source]);}
    catch{return {status:'unavailable',reason:'rangekeeper_persisted_source_not_canonical',
     campaignId,actionAvailable:false};}
    const contextNow=Date.now(),context=await loadRangeKeeperPaperExitContext({campaignId,buildId,frame,
     now:contextNow,
     readSnapshot:async()=>snapshot,readGasProfiles:query=>store.rangeKeeperPaperGasProfiles(
      query.poolAddress,query.pathVersion,query.sizeBand)});
    if(context.status!=='available')return context;
    const exitKind=kind==='close_retain'?'retain':'convert';
    let marketGasPriceWei:bigint|null=null,marketGasPriceObservedAt:number|null=null;
    try{marketGasPriceWei=await client.getGasPrice();marketGasPriceObservedAt=Date.now();}
    catch{/* The builder returns a blocked model with explicit gas evidence unavailable. */}
    const now=Date.now();
    return buildRangeKeeperPaperExitModel({client,draft:context.draft,
     openModel:context.openModel,openMarkId:context.openMarkId,previous:context.previous,
     kernel:context.kernel,readGasProfiles:context.readGasProfiles,buildId,exitKind,frame,now,
     marketGasPriceWei,marketGasPriceObservedAt,
     // This preview must stay blocked until the owned-fork stage runner is wired.
     simulate:async()=>false});
   }
   const draft=await store.paperDraft(campaignId);
   if(draft.strategyId==='rangekeeper_v1'){
    let buildId='';
    try{
     const identity=JSON.parse(process.env.CONC_LIQ_RUNTIME_IDENTITY??'null') as unknown;
     if(identity&&typeof identity==='object'&&
      typeof (identity as {buildId?:unknown}).buildId==='string')
      buildId=(identity as {buildId:string}).buildId;
    }catch{/* Missing or malformed release identity leaves the preview unavailable. */}
    return readCanonicalRangeKeeperPaperOpenModel({client,
     draft:draft as RangeKeeperPaperDraft,buildId,
     readGasProfiles:query=>store.rangeKeeperPaperGasProfiles(query.poolAddress,
      query.pathVersion,query.sizeBand)});
   }
   const frame=await readCanonicalPaperOpenFrame(client,draft.profile);
   const preview=buildIndicativePaperOpenPreview(draft,frame);
   if(preview.status!=='indicative')return preview;
   const rebuild=async()=>{
    const rows=await store.paperGasProfiles(draft.profile.pool.pool);
    let gasPriceWei=0n;
    if(rows.length)try{gasPriceWei=await client.getGasPrice();}catch{/* explicit unavailable cost below */}
    const reviewed={...preview,expiresAt:new Date(Math.min(
     (frame.source.timestamp+180)*1000,Date.now()+120_000)).toISOString()};
    return costIndicativePaperOpenPreview(reviewed,rows,draft.profile.pool.pool,
     frame.nativePrice??0n,gasPriceWei);
   };
   let costed=await rebuild();
   const forkRpc=env.PAPER_FORK_RPC_URL;
   if(costed.costs.status!=='provisional'&&forkRpc){
    const prepared=await prepareStaticPaperGasForCandidate(draft,frame,{
     sample:(current,pinned)=>sampleStaticPaperGas({rpcUrl:forkRpc,draft:current,frame:pinned,
      beforeRead:async()=>{},maxRequests:1600,timeoutMs:150_000}),
     verify:report=>verifyPaperGasSource(client,report),
     importEvidence:async(report,attestation)=>{
     const result=await store.registerPaperGasEvidence(report,attestation);
     if(typeof result.reportHash!=='string')throw new Error('paper_gas_import_report_hash_unavailable');
     return {created:result.created,reportHash:result.reportHash};
    },
     rebuild,isPrepared:value=>value.costs.status==='provisional',sourceOf:value=>value.source,
    });
    if(prepared.status!=='available')return {...costed,status:'unavailable',reason:prepared.reason,
     operationAcceptanceAvailable:false,actionAvailable:false};
    costed=prepared.value;
   }
   if(costed.costs.status!=='provisional')return costed;
   const persisted=await persistTrustedPaperOpenPreview({store,draft,frame,preview:costed,
    verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources)});
   return {...costed,...persisted,trustedPreviewSaved:true,
    operationAcceptanceAvailable:false,actionAvailable:false,economics:null};
 }finally{previewBusy=false;}
 };
 const dashboardRead=async(path:string)=>{
  if(path==='/api/research')return dashboard.research();
  if(path==='/api/dashboard')return dashboard.snapshot();
  const url=new URL(path,'http://localhost');
  const match=/^\/api\/positions(?:\/(paper-[1-9]\d*|paper-adaptive-[a-z0-9.]+|(paper|live)-dep-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|live-(rk-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/.exec(url.pathname);
  if(!match)throw new DeploymentConflict('dashboard_read_path_unavailable');
  const hours=Number(url.searchParams.get('hours')??24);
  return dashboard.positions(match[1],hours);
 };
 const paperRetainAcceptance=(campaignId:string,input:import('./deployments/contracts.js').AcceptInput,
  actor:string)=>store.acceptStaticPaperRetainOperation(campaignId,input,actor,
  (chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources));
 const paperOpenAcceptance=(campaignId:string,input:import('./deployments/contracts.js').AcceptInput,
  actor:string)=>store.acceptStaticPaperOpenOperation(campaignId,input,actor,
  (chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources));
 const paperLifecycleAcceptance=(campaignId:string,input:import('./deployments/contracts.js').AcceptInput,
  actor:string)=>store.acceptStaticPaperLifecycleOperation(campaignId,input,actor);
 const paperConvertAcceptance=env.PAPER_FORK_RPC_URL?
  createStaticPaperCloseConvertAcceptance({store,client,indexer,rpcUrl:env.PAPER_FORK_RPC_URL,
   verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources)}):undefined;
 const server=createDeploymentCommandServer(store,{origin,publicOrigin:env.DEPLOYMENT_PUBLIC_ORIGIN,
  paperPreview,paperSetupPreflight,paperSetupDraftAdmission,paperSetupDraftList:()=>store.listStaticPaperDrafts(),
  dashboardRead,paperOpenAcceptance,paperRetainAcceptance,paperLifecycleAcceptance,
  paperConvertAcceptance,
  paperConvertPreparationReady:campaignId=>store.staticPaperCloseConvertPreparationReady(campaignId),
  paperOperationReplay:(campaignId,input,allowedKinds)=>store.acceptedOperationReplay(campaignId,input,allowedKinds),
  paperRetainWorkerReady:()=>store.paperOperationWorkerReady()});
 server.listen(port,host);await once(server,'listening');
 log('info','deployment_command_api_started',{host,port});
 let stopping=false;
 const stop=(signal:NodeJS.Signals)=>{
  if(stopping)return;stopping=true;
  log('info','deployment_command_api_stopping',{signal});
  server.close(()=>void Promise.all([store.close(),dashboard.close(),indexer.end()]).then(()=>{process.exitCode=0;}).catch(()=>{process.exitCode=1;}));
 };
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
}

main().catch(error=>{
 log('error','deployment_command_api_failed',{reason:error instanceof Error?error.message:'unknown'});
 process.exitCode=1;
});
