import {once} from 'node:events';
import {Pool} from 'pg';
import {z} from 'zod';
import {DeploymentStore} from './deployments/store.js';
import {deploymentSetupDefaults} from './deployments/setup-defaults.js';
import {DeploymentConflict} from './deployments/store.js';
import {contentHash} from './deployments/contracts.js';
import {safePaperDiagnosticFailure} from './deployments/paper-diagnostic.js';
import {createDeploymentCommandServer} from './deployments/server.js';
import {buildIndicativePaperOpenPreview,readCanonicalPaperOpenFrame,readCanonicalPaperNextFrame,
 type PaperOpenFrame} from './deployments/paper-preview.js';
import {buildStaticPaperSetupPreflight} from './deployments/paper-setup-preflight.js';
import {createStaticPaperDraftFromSetup} from './deployments/static-paper-draft-admission.js';
import {StaticPaperSetupReviewCache} from './deployments/static-paper-setup-review-cache.js';
import {buildRangeKeeperPaperSetupPreflight,
 type RangeKeeperSetupPreflightInput} from './deployments/rangekeeper-paper-setup-preflight.js';
import {createRangeKeeperPaperDraftFromSetup} from './deployments/rangekeeper-paper-draft-admission.js';
import {RangeKeeperPaperSetupReviewCache} from './deployments/rangekeeper-paper-setup-review-cache.js';
import {sampleRangeKeeperPaperGasStages} from './deployments/rangekeeper-paper-gas-sampler.js';
import {costIndicativePaperOpenPreview} from './deployments/paper-cost.js';
import {prepareStaticPaperGasForCandidate} from './deployments/static-paper-gas-preparation.js';
import {prepareStaticPaperSetup} from './deployments/static-paper-setup-preparation.js';
import {sampleStaticPaperGas} from './deployments/paper-gas-sampler.js';
import {sampleStaticPaperGasViaSimulation} from './deployments/paper-gas-simulation-sampler.js';
import {safePaperGasVerifyFailure,verifyPaperGasSource} from './deployments/paper-gas-source.js';
import {persistTrustedPaperOpenPreview} from './deployments/paper-open-preflight.js';
import {persistTrustedRangeKeeperPaperOpenPreview}
 from './deployments/rangekeeper-paper-open-preflight.js';
import {createRangeKeeperPaperConfirmationProducer}
 from './deployments/rangekeeper-paper-confirmation-producer.js';
import {createRangeKeeperPaperOpenAcceptance}
 from './deployments/rangekeeper-paper-open-acceptance.js';
import {createRangeKeeperPaperExitAcceptance}
 from './deployments/rangekeeper-paper-exit-acceptance.js';
import {persistTrustedRangeKeeperPaperExitPreview}
 from './deployments/rangekeeper-paper-exit-preflight.js';
import {prepareRangeKeeperPaperRetainPreview} from './deployments/rangekeeper-paper-retain-runtime.js';
import type {RangeKeeperPaperDraft} from './deployments/rangekeeper-paper-open-model.js';
import {prepareRangeKeeperPaperOpenRuntime} from './deployments/rangekeeper-paper-open-runtime.js';
import {prepareRangeKeeperPaperConfirmationRuntime} from './deployments/rangekeeper-paper-confirmation-runtime.js';
import type {RangeKeeperPaperPinnedQuoteCache} from './deployments/rangekeeper-paper-pinned-quote-cache.js';
import type {ForkReadHint} from './paper/fork.js';
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
import {parseResearchDetailsRequest,parseResearchSummaryRequest} from './dashboard/research-api.js';

const envSchema=z.object({
 DATABASE_URL:z.string().min(1),
 DEPLOYMENT_HOST:z.enum(['127.0.0.1','::1']).default('127.0.0.1'),
 DEPLOYMENT_PORT:z.coerce.number().int().min(1).max(65535).default(4174),
 DEPLOYMENT_PUBLIC_ORIGIN:z.string().optional(),
 DEPLOYMENT_OPERATOR_WALLET_ADDRESS:z.string().optional(),
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
 const reportConversionStageTiming=(campaignId:string,stage:string,state:'completed'|'failed',
  durationMs:number,preparationStartedAt:number,sourceTimestamp:number|null)=>{
  if(!setupDiagnosticsEnabled)return;
  const boundedMs=(value:number)=>Number.isFinite(value)?
   Math.min(86_400_000,Math.max(0,Math.trunc(value))):null,
   now=Date.now(),sourceAgeMs=sourceTimestamp===null?null:
    boundedMs(now-sourceTimestamp*1000);
  try{log('info','paper_conversion_prestate_stage_timing',{campaignId,stage,state,
   durationMs:boundedMs(durationMs),elapsedMs:boundedMs(now-preparationStartedAt),sourceAgeMs});}
  catch{/* Opt-in timing diagnostics never affect conversion preparation. */}
 };
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
   readGasProfiles:(pool,tickLower,tickUpper)=>store.paperGasProfiles(pool,tickLower,tickUpper),
   readGasPrice:()=>client.getGasPrice(),
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
    // Simulate first and fall back to the owned fork. The simulation is two
    // provider round trips against roughly twenty seconds of anvil, but it has
    // to locate each token's balance slot by scanning, because the tracer the
    // fork uses for that is not available to us on the read provider. A token
    // layout that defeats the scan therefore costs latency, not an open.
    sample:async(draft,frame)=>{
     try{return await sampleStaticPaperGasViaSimulation({client,draft,frame});}
     catch(error){
      setupDiagnostic?.('paper_gas_simulation_sample',safePaperGasVerifyFailure(error));
      return await sampleStaticPaperGas({rpcUrl:env.PAPER_FORK_RPC_URL!,draft,frame,
       beforeRead:async()=>{},maxRequests:1600,timeoutMs:150_000});
     }
    },
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
 const rangeKeeperSetupReviewCache=new RangeKeeperPaperSetupReviewCache();
 // The fork's upstream is an ordinary pinned-read endpoint: anvil's --fork-url
 // points at a local proxy this process runs, and that proxy forwards only seven
 // whitelisted eth_* methods, each pinned to the fork block (assertPinnedRead in
 // paper/fork.ts). No debug_* or trace_* is ever forwarded, so the read URL
 // serves it as well as a dedicated one -- deployments-paper-gas-sample.ts
 // already passes ROBINHOOD_READ_HTTP_URL straight through as rpcUrl.
 //
 // PAPER_FORK_RPC_URL therefore exists to let an operator point fork sampling at
 // a different endpoint, not because a different kind of endpoint is required.
 // It is worth using when set, because one sample bursts up to 1600 reads and a
 // separate endpoint keeps that off the quota the live collectors share.
 const rangeKeeperForkRpcUrl=env.PAPER_FORK_RPC_URL??env.ROBINHOOD_READ_HTTP_URL;
 // Retain address/slot shapes only, never values or evidence. The fork fetches
 // every hinted value anew at its own source and checks canonical anchors.
 const rangeKeeperReadHints=new Map<string,readonly ForkReadHint[]>();
 const rangeKeeperForkHints=(profileHash:string)=>({
  prefetchHints:rangeKeeperReadHints.get(profileHash),
  onReadHints:(hints:readonly ForkReadHint[])=>{
   rangeKeeperReadHints.delete(profileHash);
   if(rangeKeeperReadHints.size>=8)rangeKeeperReadHints.delete(rangeKeeperReadHints.keys().next().value!);
   rangeKeeperReadHints.set(profileHash,structuredClone(hints));
  },
 });
 const reportRangeKeeperTiming=(campaignId:string,phase:string,durationMs:number)=>{
  if(!setupDiagnosticsEnabled)return;
  try{log('info','rangekeeper_paper_preparation_timing',{campaignId,phase,
   durationMs:Math.min(86_400_000,Math.max(0,Math.trunc(durationMs)))});}catch{}
 };
 const runRangeKeeperPaperOpen=async(campaignId:string,frame?:PaperOpenFrame,
  pinnedQuoteCache?:RangeKeeperPaperPinnedQuoteCache)=>prepareRangeKeeperPaperOpenRuntime({store,
  client,campaignId,frame,pinnedQuoteCache,
  onPhaseTiming:(phase,durationMs)=>reportRangeKeeperTiming(campaignId,`first_${phase}`,durationMs),
  readGasProfiles:query=>store.rangeKeeperPaperGasProfiles(query.poolAddress,
   query.pathVersion,query.sizeBand),sampleOwnedFork:(request,limits,initialBalances)=>
    sampleRangeKeeperPaperGasStages(request,{rpcUrl:rangeKeeperForkRpcUrl,beforeRead:async()=>{},
     maxRequests:1600,timeoutMs:150_000,limits,initialBalances,
     ...rangeKeeperForkHints(request.scope.profileHash)})});
 // The server-side confirmation producer: the second of RangeKeeper's two
 // observations. It loads the draft and its own canonical frame, replays scoped
 // costs in the store builder, runs the owned fork, and persists the envelope
 // with a producer receipt. It was previously constructed only by tests, which
 // is why no RangeKeeper open could be confirmed in production.
 const rangeKeeperConfirmationProducer=createRangeKeeperPaperConfirmationProducer({
  store,client,rpcUrl:rangeKeeperForkRpcUrl,beforeRead:async()=>{},
  onFailure:(stage,error)=>setupDiagnostic?.(`rangekeeper_confirmation_${stage}`,safePaperDiagnosticFailure(error)),
  prepareGasEvidence:async(draft,frame,_buildId,pinnedQuoteCache)=>{
   const {model:sampled,simulation}=await prepareRangeKeeperPaperConfirmationRuntime({store,client,
    campaignId:draft.id,frame,pinnedQuoteCache,rpcUrl:rangeKeeperForkRpcUrl,beforeRead:async()=>{},
    maxRequests:1600,timeoutMs:150_000,
    ...rangeKeeperForkHints(draft.profileHash),
    onPhaseTiming:(phase,durationMs)=>reportRangeKeeperTiming(draft.id,`second_${phase}`,durationMs)});
   if(sampled.status!=='indicative'||sampled.costs?.status!=='provisional')
    throw new DeploymentConflict(sampled.blockingReason??'rangekeeper_confirmation_cost_preparation_unavailable');
   return {simulation};
  },
  maxRequests:1600,timeoutMs:150_000});
 // A parallel acceptance rather than another branch inside acceptOperation: it
 // pre-validates the published confirmation against the preview the operator is
 // accepting, then calls the bare acceptOperation, whose own static admission
 // branches are never reached.
 const rangeKeeperOpenAcceptance=createRangeKeeperPaperOpenAcceptance({store,
  verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources)});
 const rangeKeeperExitAcceptance=createRangeKeeperPaperExitAcceptance({store,
  verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources)});
 const runRangeKeeperSetupPreflight=
  async(input:RangeKeeperSetupPreflightInput,pinnedSource?:PaperOpenFrame['source'])=>
   buildRangeKeeperPaperSetupPreflight(input,{
    loadProfile:id=>store.paperSetupProfile(id),
    readFrame:(profile,source)=>readCanonicalPaperOpenFrame(client,profile,source),
    verifyCanonical:(chainId,source)=>verifyCanonicalPaperAnchors(client,chainId,[source]),
    readGasPrice:()=>client.getGasPrice(),
    // The preflight supplies the kernel's own resolved limits and the exact
    // funding its candidate needs, so nothing is re-derived here.
    sampleOwnedFork:(request,options)=>sampleRangeKeeperPaperGasStages(request,{
     rpcUrl:rangeKeeperForkRpcUrl,beforeRead:async()=>{},maxRequests:1600,timeoutMs:150_000,
     limits:options.limits,initialBalances:options.initialBalances,
     ...rangeKeeperForkHints(request.scope.profileHash)}),
   },pinnedSource);
 const rangeKeeperSetupPreflight=
  async(input:RangeKeeperSetupPreflightInput,pinnedSource?:PaperOpenFrame['source'])=>{
   // One owned fork at a time, for the same reason the static setup review
   // serialises: a concurrent second fork doubles memory and invalidates nothing.
   if(paperSetupBusy)throw new DeploymentConflict('paper_setup_preflight_busy');
   paperSetupBusy=true;
   try{
    const result=await runRangeKeeperSetupPreflight(input,pinnedSource);
    // A replay for admission must not mint a second review snapshot.
    if(pinnedSource)return result;
    if(result&&typeof result==='object'&&!Array.isArray(result)){
     const row=result as Record<string,unknown>,captured=rangeKeeperSetupReviewCache.capture(row);
     if(captured)return {...row,...captured};
     if(row.status==='available')return {...row,status:'unavailable',costs:{status:'unavailable',
      reason:'setup_review_snapshot_unavailable'},missing:['setup_review_snapshot_unavailable'],
      actionAvailable:false,draftCreated:false,operationCreated:false};
    }
    return result;
   }finally{paperSetupBusy=false;}
  };
 const rangeKeeperSetupDraftAdmission=(input:unknown)=>
  createRangeKeeperPaperDraftFromSetup(input,{
   runPreflight:(parsed,pinnedSource)=>rangeKeeperSetupPreflight(parsed,pinnedSource),
   loadProfile:id=>store.paperSetupProfile(id),
   lookupCapturedReview:review=>rangeKeeperSetupReviewCache.lookup(review),
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
      const conversionPreparationStartedAt=Date.now();
      let conversionFrameTimestamp:number|null=null;
      const conversionStage=async<T>(stage:string,run:()=>Promise<T>):Promise<T>=>{
       const startedAt=Date.now();
       try{
        const result=await run();
        reportConversionStageTiming(campaignId,stage,'completed',Date.now()-startedAt,
         conversionPreparationStartedAt,conversionFrameTimestamp);
        return result;
       }catch(error){
        reportConversionStageTiming(campaignId,stage,'failed',Date.now()-startedAt,
         conversionPreparationStartedAt,conversionFrameTimestamp);
        throw error;
       }
      };
      try{
       const valuation=await store.paperValuationState(campaignId);
       conversionPrestateStage='fee_context';
       const context=await conversionStage('fee_context',()=>readStaticPaperCloseConvertFeeContext({store,campaignId,
         revision:valuation.openModel.revision,verifyAnchors:(chainId,sources)=>
          verifyCanonicalPaperAnchors(client,chainId,sources)}));
       conversionPrestateStage='replay_head';
       const frame=await conversionStage('replay_head',async()=>{
        const selected=await waitCanonicalPaperReplayHeadFrame({client,indexer,
         profile:context.state.profile,stream:context.stream,targetSetHash:context.targetSetHash,
         // Keep anchor age low enough to leave time for fee replay and the terminal fork.
         previous:context.state.previous,maxSourceAgeMs:30_000,
         assertPreparationLeaseHealthy:()=>preparationLease.assertHealthy()});
        conversionFrameTimestamp=selected.source.timestamp;
        return selected;
       });
       setupFrameDiagnostic(campaignId,frame);
       await preparationLease.assertHealthy();
       conversionPrestateStage='route';
       const route=buildStaticPaperCloseConvertRoute(context.state);
       conversionPrestateStage='fee_replay';
       const feeReplay=await conversionStage('fee_replay',()=>replayEphemeralStaticPaperCloseConvertFees(
        {context,client,indexer,frame}));
       conversionPrestateStage='owned_fork_sample';
       const report=await conversionStage('owned_fork_sample',()=>samplePaperCloseConvertPrestate({
        rpcUrl:env.PAPER_FORK_RPC_URL!,
         openModel:context.state.openModel,openMarkId:context.state.openMarkId,
         profile:context.state.profile,frame,previous:{markId:context.state.previous.markId,
          source:context.state.previous.source},route,feeCarry:feeReplay.feeCarry,feeReplay,
         verifyPersistedContext:()=>context.verifyPersistedContext({state:context.state,
          feeCarry:context.feeCarry,feeEvidence:context.feeEvidence,source:frame.source}),
         verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources),
         beforeRead:async()=>{},deterministicClock:true,
         ...(setupDiagnosticsEnabled?{onPhaseTiming:(event:{stage:string;state:'completed'|'failed';
          durationMs:number})=>reportConversionStageTiming(campaignId,event.stage,event.state,event.durationMs,
           conversionPreparationStartedAt,conversionFrameTimestamp)}:{})}));
       await preparationLease.assertHealthy();
       conversionPrestateStage='gas_registration';
       await conversionStage('gas_registration',()=>store.registerStaticPaperCloseConvertPrestateGas({report,
        verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources),
        verifyFeeReplay:async()=>{
         const current=await readStaticPaperCloseConvertFeeContext({store,campaignId,
          revision:context.state.openModel.revision,verifyAnchors:(chainId,sources)=>
          verifyCanonicalPaperAnchors(client,chainId,sources)});
         return replayEphemeralStaticPaperCloseConvertFees({context:current,client,indexer,frame});
        }}));
       conversionPrestateStage='cost_profiles';
        const {gasPriceWei,prestateCostProfiles}=await conversionStage('cost_profiles',async()=>{
         const gasPriceWei=await client.getGasPrice(),sizeBand=
          buildProspectivePaperCloseConvertPrestateGasProfiles(report).sizeBand,prestateCostProfiles=
          await store.staticPaperCloseConvertPrestateGasProfiles({chainId:context.state.profile.pool.chainId,
           poolAddress:context.state.profile.pool.pool,sizeBand,reportHash:report.reportHash});
         return {gasPriceWei,prestateCostProfiles};
        });
       conversionPrestateStage='preview_persistence';
       const saved=await conversionStage('preview_persistence',()=>persistStaticPaperCloseConvertPreviewFromPersistedFees({store,campaignId,
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
        }}));
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
     try{gasProfiles=await store.paperGasProfiles(state.profile.pool.pool,
      state.openModel.candidate.range.tickLower,state.openModel.candidate.range.tickUpper);}
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
    if(kind==='close_retain'){
     try{
      const identity=JSON.parse(process.env.CONC_LIQ_RUNTIME_IDENTITY??'null');
      if(!identity?.buildId)throw new DeploymentConflict('rangekeeper_runtime_build_identity_unavailable');
      return await prepareRangeKeeperPaperRetainPreview({store,client,campaignId,
       buildId:identity.buildId,rpcUrl:rangeKeeperForkRpcUrl,
       onFailure:(stage,error)=>setupDiagnostic?.(`rangekeeper_retain_${stage}`,safePaperDiagnosticFailure(error))});
     }catch(error){return {status:'unavailable',kind,campaignId,actionAvailable:false,
      reason:error instanceof DeploymentConflict?error.code:'rangekeeper_retain_preparation_unavailable'};}
    }
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
    const exitKind='convert' as const;
    let marketGasPriceWei:bigint|null=null,marketGasPriceObservedAt:number|null=null;
    try{marketGasPriceWei=await client.getGasPrice();marketGasPriceObservedAt=Date.now();}
    catch{/* The builder returns a blocked model with explicit gas evidence unavailable. */}
    const now=Date.now();
    const exitModel=await buildRangeKeeperPaperExitModel({client,draft:context.draft,
     openModel:context.openModel,openMarkId:context.openMarkId,previous:context.previous,
     kernel:context.kernel,readGasProfiles:context.readGasProfiles,buildId,exitKind,frame,now,
     marketGasPriceWei,marketGasPriceObservedAt,
     // No candidate simulator is wired into the terminal preview. This throws
     // rather than returning false so the kernel reports
     // 'calldata_simulation_unavailable' instead of 'calldata_simulation_failed':
     // returning false asserts that a candidate's calldata failed a simulation
     // that never ran, and that reason is surfaced to the operator through the
     // model's kernelEvaluation.simulationAvailable.
     //
     // This gate is reached only when the kernel would propose its own entry or
     // recenter candidate while the operator is previewing a close, and it is not
     // what makes a RangeKeeper campaign uncloseable. That is the missing exit
     // operation path -- see the integration plan's section 2a.
     simulate:async()=>{throw new Error('rangekeeper_terminal_candidate_simulator_unavailable');}});
    // Persist a trusted exit preview so the exit acceptance has something to bind
    // to. Only a complete indicative model is persistable; a blocked one carries
    // its reason to the operator instead, and the preflight refuses it anyway.
    if(exitModel.status!=='indicative')return exitModel;
    try{
     const persisted=await persistTrustedRangeKeeperPaperExitPreview({store,draft:context.draft,
      model:exitModel,kind:'close_convert',
      verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>
       verifyCanonicalPaperAnchors(client,chainId,sources)});
     return {...exitModel,id:persisted.id,contentDigest:persisted.contentDigest,
      expectedRevision:persisted.expectedRevision,
      expiresAt:persisted.expiresAt.toISOString(),trustedPreviewSaved:true,
      operationAcceptanceAvailable:false,actionAvailable:false};
    }catch(error){
     return {...exitModel,status:'blocked' as const,
      blockingReason:error instanceof DeploymentConflict?error.code:
       'rangekeeper_exit_preview_unavailable',
      operationAcceptanceAvailable:false,actionAvailable:false};
    }
   }
   const draft=await store.paperDraft(campaignId);
   if(draft.strategyId==='rangekeeper_v1'){
    const rangeKeeperDraft=draft as RangeKeeperPaperDraft;
    // RangeKeeper opens on two observations at different blocks, which the
    // confirmations table enforces (confirmation_source_block>first_source_block).
    // So one preview request cannot do both: the first persists the trusted
    // preview the confirmation reads, and a later one runs the confirmation
    // producer against it.
    let previewState:Awaited<ReturnType<typeof store.rangeKeeperPaperOpenPreviewState>>=
     {livePreview:false,confirmed:false,binding:null};
    try{previewState=await store.rangeKeeperPaperOpenPreviewState(campaignId);}
    catch{/* Treated as no live preview; the first-observation path re-checks. */}
    if(previewState.livePreview&&!previewState.confirmed){
     const confirmation=await rangeKeeperConfirmationProducer(campaignId);
     // Keep the envelope intact while exposing the strategy and confirmation
     // discriminator the shared HTTP/UI actionability checks require.
     if(!confirmation||typeof confirmation!=='object'||Array.isArray(confirmation))return confirmation;
     const confirmed=(confirmation as {status?:unknown}).status==='confirmed';
     return {...confirmation,strategyId:'rangekeeper_v1',
      confirmation:{status:confirmed?'confirmed':'unavailable'},
      operationAcceptanceAvailable:false,actionAvailable:false,
      ...(confirmed&&previewState.binding?{id:previewState.binding.id,
       contentDigest:previewState.binding.contentDigest,
       expectedRevision:previewState.binding.expectedRevision,
       expiresAt:previewState.binding.expiresAt.toISOString(),
       trustedPreviewSaved:true}:{})};
    }
    if(previewState.confirmed){
     const confirmation=await store.rangeKeeperPaperConfirmationEnvelope({campaignId,
      verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(client,chainId,sources)});
     if(!previewState.binding||!confirmation)return {status:'unavailable',campaignId,strategyId:'rangekeeper_v1',
      reason:'rangekeeper_open_preview_binding_expired',actionAvailable:false};
     return {...confirmation,strategyId:'rangekeeper_v1',confirmation:{status:'confirmed'},
      ...previewState.binding,expiresAt:previewState.binding.expiresAt.toISOString(),
      trustedPreviewSaved:true,operationAcceptanceAvailable:false,actionAvailable:false};
    }
    const model=await runRangeKeeperPaperOpen(campaignId);
    if(model.status!=='indicative'||model.decision?.kernelAction!=='confirm'||
     model.decision.requiresSecondObservation!==true||model.costs?.status!=='provisional')
     return model;
    try{
     const persisted=await persistTrustedRangeKeeperPaperOpenPreview({store,
      draft:rangeKeeperDraft,model,
      verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>
       verifyCanonicalPaperAnchors(client,chainId,sources)});
     // Deliberately not trustedPreviewSaved: that flag is what the command server
     // reads to offer acceptance, and a first observation is not acceptable. The
     // confirmation has to run first.
     // The operator has to come back for the second observation, and the window
     // is narrow and not guessable: the kernel refuses one less than 30s after
     // the first (planner.ts:206) and more than maxObservationGapSeconds after it
     // (planner.ts:230). A 104-second gap is exactly what caused the recorded
     // live no-entry on 2026-09-21, so the window is reported rather than left to
     // the operator to infer.
     const gapSeconds=(rangeKeeperDraft.parameters as {limits?:{maxObservationGapSeconds?:number}}|
      undefined)?.limits?.maxObservationGapSeconds;
     const windowFrom=(model.source.timestamp+30)*1000;
     const windowUntil=typeof gapSeconds==='number'?(model.source.timestamp+gapSeconds)*1000:null;
     return {...model,openPreviewId:persisted.id,openPreviewDigest:persisted.contentDigest,
      openPreviewExpiresAt:persisted.expiresAt.toISOString(),modelHash:persisted.modelHash,
      confirmation:{status:'first_observation_recorded',
       reason:'rangekeeper_second_observation_required',
       secondObservationFrom:new Date(windowFrom).toISOString(),
       secondObservationUntil:windowUntil===null?null:new Date(windowUntil).toISOString(),
       secondObservationWindowSeconds:typeof gapSeconds==='number'?gapSeconds-30:null},
      operationAcceptanceAvailable:false,actionAvailable:false};
    }catch(error){
     return {...model,status:'unavailable' as const,
      unavailable:[...model.unavailable,error instanceof DeploymentConflict?error.code:
       'rangekeeper_open_preview_unavailable'],
      operationAcceptanceAvailable:false,actionAvailable:false};
    }
   }
   const frame=await readCanonicalPaperOpenFrame(client,draft.profile);
   const preview=buildIndicativePaperOpenPreview(draft,frame);
   if(preview.status!=='indicative')return preview;
   const rebuild=async()=>{
    const rows=await store.paperGasProfiles(draft.profile.pool.pool,
     preview.candidate.range.tickLower,preview.candidate.range.tickUpper);
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
  const url=new URL(path,'http://localhost');
  if(url.pathname==='/api/research'){
   const capitalQuoteRaw=parseResearchSummaryRequest(url.searchParams);
   if(capitalQuoteRaw===null)throw new DeploymentConflict('invalid_research_request');
   return dashboard.research(capitalQuoteRaw);
  }
  if(url.pathname==='/api/research/details'){
   const input=parseResearchDetailsRequest(url.searchParams);
   if(input===null)throw new DeploymentConflict('invalid_research_request');
   return dashboard.researchDetails(input);
  }
  if(path==='/api/dashboard')return dashboard.snapshot();
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
  setupDefaults:()=>deploymentSetupDefaults(env.DEPLOYMENT_OPERATOR_WALLET_ADDRESS),
  paperPreview,paperSetupPreflight,paperSetupDraftAdmission,paperSetupDraftList:()=>store.listStaticPaperDrafts(),
  rangeKeeperSetupPreflight,rangeKeeperSetupDraftAdmission,rangeKeeperOpenAcceptance,
  rangeKeeperExitAcceptance,
  paperSetupDraftDelete:campaignId=>store.deleteStaticPaperDraft(campaignId),
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
