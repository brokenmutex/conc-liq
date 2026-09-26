import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {contentHash,previewDigest,rangeKeeperParameters} from '../../src/deployments/contracts.ts';
import {verifyMarketProfile,marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {readCanonicalPaperOpenFrame} from '../../src/deployments/paper-preview.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {rangeKeeperConfirmedSource} from '../../src/strategy/rangekeeper/source.ts';
import {planRangeKeeper} from '../../src/strategy/rangekeeper/planner.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {resolveRangeKeeperPaperPolicy} from
 '../../src/deployments/rangekeeper-paper-open-model.ts';
import {buildRangeKeeperPaperOpenModelWhileRegistering} from
 '../../src/deployments/rangekeeper-paper-open-model-overlap.ts';
import {buildRangeKeeperPaperConfirmation,prepareRangeKeeperPaperConfirmation} from
 '../../src/deployments/rangekeeper-paper-confirmation.ts';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand}
 from '../../src/deployments/rangekeeper-paper-cost.ts';
import {produceRangeKeeperPaperGasEvidence} from '../../src/deployments/rangekeeper-paper-gas-evidence.ts';
import {simulateRangeKeeperPaperConfirmationOnOwnedFork} from
 '../../src/deployments/rangekeeper-paper-confirmation-simulation.ts';
import {createRangeKeeperPaperConfirmationProducer} from
 '../../src/deployments/rangekeeper-paper-confirmation-producer.ts';
import {processOnePaperOperation} from '../../src/deployments/paper-operation-worker.ts';
import {loadRangeKeeperPaperConfirmationContext} from
 '../../src/deployments/rangekeeper-paper-confirmation-context.ts';
import {adaptRangeKeeperConfirmedOpenContext} from
 '../../src/deployments/rangekeeper-paper-confirmed-open-adapter.ts';
import {replayRangeKeeperPaperConfirmationOnOwnedFork} from
 '../../src/deployments/rangekeeper-paper-confirmation-replay-verifier.ts';
import {verifyCanonicalPaperAnchors} from '../../src/deployments/paper-canonical-anchors.ts';
import {readRangeKeeperPaperConfirmationFrame} from
 '../../src/deployments/rangekeeper-paper-confirmation-frame.ts';
import {RangeKeeperPaperPinnedQuoteCache} from
 '../../src/deployments/rangekeeper-paper-pinned-quote-cache.ts';
import {readDeploymentRows,readDeploymentDetail} from '../../src/dashboard/deployment-position.ts';

// Opt-in end-to-end hypothetical open gate. It uses canonical read RPC plus
// fresh local Anvil forks, and a disposable PostgreSQL schema. It never loads
// a signer, broadcasts, or enables operator/UI admission.
const safeError=error=>{
 const message=error instanceof Error?error.message:'RangeKeeper booking integration failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,400)}\n`);
 process.exitCode=1;
};
const serializeCandidate=c=>({kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,
 amountIn:String(c.swap.amountIn),quotedOut:String(c.swap.quotedOut),minOut:String(c.swap.minOut),
 priceAfter:String(c.swap.priceAfter),feeValue:String(c.swap.feeValue),shortfallValue:String(c.swap.shortfallValue)}:null,
 amount0Desired:String(c.amount0Desired),amount1Desired:String(c.amount1Desired),amount0Min:String(c.amount0Min),
 amount1Min:String(c.amount1Min),liquidity:String(c.liquidity),deployedValue:String(c.deployedValue),
 sourceBlock:String(c.sourceBlock),sourceHash:c.sourceHash,expiresAt:c.expiresAt});
const rawValue=(amount,price,decimals)=>amount*price/10n**BigInt(decimals);

try{
 assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
 const dotenv=parseEnv(readFileSync('.env','utf8')),
  archive=dotenv.RH_ARCHIVE_RPC_URL,readRpc=dotenv.ROBINHOOD_READ_HTTP_URL??archive,
  streamKey=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
 assert(archive&&readRpc&&streamKey,'Read-only RPC or indexer stream configuration unavailable');
 const rpc=createRobinhoodClient(readRpc,15_000,{retryCount:0}),rawConfig=JSON.parse(
  readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')),
  parsedConfig=parseRangeKeeperConfig(rawConfig),profile=marketProfileSchema.parse({pool:parsedConfig.pool,
   referencePolicy:parsedConfig.referencePolicy});
 assert.equal(parsedConfig.broadcastEnabled,false);
 const {fullWidthSpacings,...limitsConfig}=parsedConfig.limits,
  parameters=rangeKeeperParameters.parse({fullWidthSpacings,
   limits:{...Object.fromEntries(Object.entries(limitsConfig).map(([key,value])=>
    [key,typeof value==='bigint'?String(value):value])),minDeploymentValue:'0'}}),
  configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
  buildId='a'.repeat(64),runtimeIdentity={buildId,configHash:'f'.repeat(64),nodeVersion:process.version};
 const quoteCache=new RangeKeeperPaperPinnedQuoteCache(rpc,profile),forkReadMetrics=[];
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(runtimeIdentity);
 const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await adminPool.connect(),
  schema=`rk_open_test_${randomUUID().replaceAll('-','')}`;
 let store,proof,firstModel,secondFrame,campaignId,firstRows=[];
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
  await migrateDatabase(admin);
  const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
  scopedUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=20000`);
  store=new DeploymentStore(scopedUrl.toString());await store.assertReady();
  proof=await verifyMarketProfile(rpc,profile,streamKey);
  const targetSetHash=`0x${'f'.repeat(64)}`;
  await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
   created_block,target_set_hash,enabled) VALUES($1,$2,$3,'AAPL',$4,$5,1,$6,true)`,
   [streamKey,profile.pool.pool,profile.pool.chainId,
    profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0,profile.pool.fee,targetSetHash]);
  const market=(await store.registerVerifiedMarketProfile(proof)).id;
  const draftRow=await store.createDraft({mode:'paper',chainId:4663,wallet:rawConfig.operator,
   marketProfileId:market,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
   allocation:{token0Raw:'250000000',token1Raw:'0',nativeWei:'3000000000000000'},config:parameters});
  campaignId=(await store.paperDraft(draftRow.id)).id;
  const draft=await store.paperDraft(campaignId),policy=resolveRangeKeeperPaperPolicy(draft,buildId);
  assert(policy.policy&&policy.unavailable.length===0,'Campaign kernel policy unavailable');
  const readRows=query=>store.rangeKeeperPaperGasProfiles(
   query.poolAddress,query.pathVersion,query.sizeBand);
  const sourceFrame=()=>readCanonicalPaperOpenFrame(rpc,profile);
  const observe=frame=>{
   assert(frame.price0&&frame.price1&&frame.nativePrice);
   const token0=BigInt(draft.allocation.token0Raw),token1=BigInt(draft.allocation.token1Raw),
    strategyValue=rawValue(token0,frame.price0,profile.pool.decimals0)+
     rawValue(token1,frame.price1,profile.pool.decimals1);
   return {block:BigInt(frame.source.block),hash:frame.source.hash,timestamp:frame.source.timestamp,
    tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical',wallet0:token0,wallet1:token1,
    released0:0n,released1:0n,nativeWei:BigInt(draft.allocation.nativeWei),
    requiredExitReserveWei:policy.policy.limits.exitReserveWei,price0:frame.price0,price1:frame.price1,
    nativePrice:frame.nativePrice,position:null,pending:false,entryAllowed:true,safeExitRequired:false,
    executionReady:true,liquiditySharePpm:0,actionCost:policy.policy.limits.maxActionCost,actionGasWei:0n,
    reservedCost:0n,rollingSpentCost:0n,campaignSpentCost:0n,campaignStartValue:strategyValue,
    highWaterValue:strategyValue,recenters:0};
  };
  const planOpen=async frame=>{
   const state={schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
    configHash:`0x${policy.policy.policyHash}`,buildId,lastEligible:null,exit:null,confirmation:null};
   const quote=(token,amount)=>quoteCache.quote({block:BigInt(frame.source.block),hash:frame.source.hash,
    timestamp:frame.source.timestamp},token,amount,frame.price0,frame.price1);
   return planRangeKeeper({state,observation:observe(frame),limits:policy.policy.limits,
    spacing:profile.pool.tickSpacing,decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1,
    quoteToken:profile.pool.quoteToken,maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,
    quote,simulate:async()=>true});
  };
  const scopeFor=(frame,candidate)=>{
   const candidateHash=rangeKeeperPaperCandidateHash({campaignId,revision:1,profileHash:draft.profileHash,
    configHash:draft.configHash,source:frame.source,referenceProofHash:frame.referenceProofHash,candidate}),
    denominator=frame.poolLiquidity+candidate.liquidity;
   assert(denominator>0n);
   return {poolAddress:profile.pool.pool,profileHash:draft.profileHash,candidateHash,
    deployedValue:candidate.deployedValue,sharePpm:candidate.liquidity*1_000_000n/denominator,
    range:candidate.range,swapKind:candidate.swap?'direct_pool_exact_input':'none'};
  };
  const samplesFrom=async(frame,candidate,scope,firstCandidateHash='0'.repeat(64),prefetchHints,saveHints,saveSimulation)=>{
   const pathVersion=rangeKeeperPaperPathVersion(candidate),sizeBand=rangeKeeperPaperSizeBand(pathVersion,scope),
    probe={status:'candidate',campaignId,revision:1,firstModelHash:'0'.repeat(64),firstCandidateHash,
     source:frame.source,candidate,candidateHash:scope.candidateHash,scope,pathVersion,sizeBand,
     actionAvailable:false},
    simulation=await simulateRangeKeeperPaperConfirmationOnOwnedFork({probe,profile,frame,
     configHash:draft.configHash,initialBalances:[BigInt(draft.allocation.token0Raw),
      BigInt(draft.allocation.token1Raw)],allocation:draft.allocation,limits:policy.policy.limits,rpcUrl:archive,
     beforeRead:async()=>{},timeoutMs:180_000,onReadDiagnostics:metrics=>{
      forkReadMetrics.push(metrics);process.stdout.write(JSON.stringify({event:'rangekeeper_owned_fork_reads',
       source:{block:frame.source.block,hash:frame.source.hash},metrics})+'\n');
     },prefetchHints,onReadHints:saveHints});
   saveSimulation?.(simulation);
   return simulation.ownedForkEvidence.stages.map(stage=>({action:stage.stage,to:stage.to,
    calldata:stage.calldata,returnData:stage.returnData,localHash:stage.localTransactionHash,
    localGasUsed:stage.gasUsed,localEffectiveGasPriceWei:stage.effectiveGasPriceWei,
    sourceBlock:frame.source.block,sourceHash:frame.source.hash,estimate:stage.estimate,
    stateOverrideHash:stage.stateOverrideHash,stateOverrides:stage.stateOverrides}));
  };
  const makeReport=async(frame,candidate,scope,candidateSource,referenceProofHashValue,firstCandidateHash,
   prefetchHints,saveHints,saveSimulation)=>{
   const samples=await samplesFrom(frame,candidate,scope,firstCandidateHash,prefetchHints,saveHints,saveSimulation);
   return produceRangeKeeperPaperGasEvidence({kind:'open',campaignId,revision:1,
    configHash:draft.configHash,buildId,profile,frame,candidateSource,
    candidateReferenceProofHash:referenceProofHashValue,candidate,openMarkId:null,openModelHash:null,
    marketGasPriceWei:await rpc.getGasPrice(),scope,
    sampleOwnedFork:async()=>samples});
  };
  const register=async(report,replay)=>store.registerRangeKeeperPaperGasEvidence({report,client:rpc,
   replayPersistedContext:replay});
  const primeStartedAt=Date.now(),primeFrame=await sourceFrame(),primePlanStartedAt=Date.now(),
   primePlan=await planOpen(primeFrame),primePlanFinishedAt=Date.now();
  assert.equal(primePlan.action,'confirm',`Prime candidate unavailable: ${primePlan.reason}`);
  assert(primePlan.candidate,'Prime candidate missing');
  let primedReadHints=[];
  const primeScope=scopeFor(primeFrame,primePlan.candidate);
  await samplesFrom(primeFrame,primePlan.candidate,primeScope,'0'.repeat(64),undefined,
   hints=>{primedReadHints=hints;});
  const primeFinishedAt=Date.now();
  assert(primedReadHints.length>0,'No code/storage request shapes observed during the prime report');
  const firstFrameReadStartedAt=Date.now(),firstFrame=await sourceFrame(),firstCapturedAt=Date.now();
  let firstReportFinishedAt=0,secondFrameCapturedAt=0,firstReadHints=[];
  const secondFramePromise=(async()=>{
    const minimumTimestamp=firstFrame.source.timestamp+30;
    for(let attempt=0;attempt<24;attempt++){
     const untilMinimum=(minimumTimestamp-Math.floor(Date.now()/1000))*1000;
     await new Promise(resolve=>setTimeout(resolve,Math.max(1_000,Math.min(5_000,untilMinimum))));
     const confirmed=await rangeKeeperConfirmedSource(rpc);
     if(confirmed.timestamp>=minimumTimestamp){
      const observed=await readCanonicalPaperOpenFrame(rpc,profile,{block:String(confirmed.block),
       hash:confirmed.hash,timestamp:confirmed.timestamp});
      if(observed.source.timestamp-firstFrame.source.timestamp<=policy.policy.limits.maxObservationGapSeconds){
       secondFrameCapturedAt=Date.now();
       return observed;
      }
      throw Error('Second source exceeded frozen observation gap');
     }
    }
    throw Error('Fresh second observation did not arrive');
   })();
  const firstPlanStartedAt=Date.now(),firstPlan=await planOpen(firstFrame),firstPlanFinishedAt=Date.now();
  assert.equal(firstPlan.action,'confirm',`First candidate unavailable: ${firstPlan.reason}`);
  assert(firstPlan.candidate,'First candidate unavailable');
  const firstScope=scopeFor(firstFrame,firstPlan.candidate),firstReportStartedAt=Date.now(),firstReportPromise=makeReport(firstFrame,
   firstPlan.candidate,firstScope,firstFrame.source,firstFrame.referenceProofHash,'0'.repeat(64),primedReadHints,
   hints=>{firstReadHints=hints;}).then(report=>{
    firstReportFinishedAt=Date.now();return report;
   });
  const preparedSecondWorkPromise=secondFramePromise.then(async capturedSecondFrame=>{
   const pinnedRereadStartedAt=Date.now(),pinnedFramePromise=readRangeKeeperPaperConfirmationFrame({
    client:rpc,profile,saved:capturedSecondFrame}).then(frame=>({frame,finishedAt:Date.now()})),
    preparationStartedAt=Date.now(),preparationPromise=prepareRangeKeeperPaperConfirmation({draft,
    firstFrame,firstCandidate:firstPlan.candidate,frame:capturedSecondFrame,buildId,client:rpc,
    pinnedQuoteCache:quoteCache}),
    [pinnedReread,preparation]=await Promise.all([pinnedFramePromise,preparationPromise]),
    pinnedFrame=pinnedReread.frame,pinnedRereadFinishedAt=pinnedReread.finishedAt,
    preparationFinishedAt=Date.now();
   assert.equal(preparation.status,'prepared_candidate',
    `Speculative second observation unavailable: ${preparation.reason}`);
   let simulation;
   const speculativeScope=preparation.scope,reportStartedAt=Date.now(),report=await makeReport(pinnedFrame,
    preparation.candidate,speculativeScope,pinnedFrame.source,pinnedFrame.referenceProofHash,
    preparation.firstCandidateHash,primedReadHints,undefined,value=>{simulation=value;}),reportFinishedAt=Date.now();
   return {frame:pinnedFrame,preparation,report,simulation,pinnedRereadStartedAt,
    pinnedRereadFinishedAt,preparationStartedAt,preparationFinishedAt,reportStartedAt,reportFinishedAt};
  });
  const firstReport=await firstReportPromise;
  let firstImportFinishedAt=0,overlapTiming=null;
  const firstImportStartedAt=Date.now(),firstModelStartedAt=firstImportStartedAt,
   modelGasPrice=await rpc.getGasPrice(),modelGasPriceObservedAt=Date.now();
  firstModel=await buildRangeKeeperPaperOpenModelWhileRegistering({client:rpc,draft,frame:firstFrame,buildId,
   report:firstReport,marketGasPriceWei:modelGasPrice,marketGasPriceObservedAt,pinnedQuoteCache:quoteCache,
   register:async report=>{
    const result=await register(report,async({report,frame})=>{
   const plan=await planOpen(frame),candidateHash=rangeKeeperPaperCandidateHash({campaignId,
    revision:1,profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
    referenceProofHash:frame.referenceProofHash,candidate:plan.candidate});
   assert.equal(candidateHash,report.candidateHash,'Persisted first kernel candidate changed');
   return {replayHash:contentHash({candidateHash,source:frame.source,proofHash:frame.referenceProofHash})};
    });
    firstImportFinishedAt=Date.now();
    return result;
   },readRows:readRows,onTiming:value=>{overlapTiming=value;},now:modelGasPriceObservedAt});
  if(firstImportFinishedAt===0)firstImportFinishedAt=Date.now();
  const firstModelFinishedAt=Date.now();
  assert.equal(firstModel.status,'indicative','First source open model did not replay');
  const firstCandidate=firstModel.candidate;
  assert(firstCandidate,'First model candidate missing');
  const previewExpiry=new Date(firstCandidate.expiresAt*1000);
  assert(previewExpiry.getTime()>Date.now(),
   `First source preview expired after first report: primeFrameRead=${(primePlanStartedAt-primeStartedAt)/1000}s, primePlan=${(primePlanFinishedAt-primePlanStartedAt)/1000}s, primeFork=${(primeFinishedAt-primePlanFinishedAt)/1000}s, initialSourceAge=${Math.floor((firstCapturedAt-firstFrame.source.timestamp*1000)/1000)}s, firstPlan=${(firstPlanFinishedAt-firstPlanStartedAt)/1000}s, finalSourceAge=${Math.floor((Date.now()-firstFrame.source.timestamp*1000)/1000)}s, firstReport=${Math.floor((firstReportFinishedAt-firstReportStartedAt)/1000)}s, secondFrameWait=${Math.floor((secondFrameCapturedAt-firstCapturedAt)/1000)}s, firstImport=${Math.floor((firstImportFinishedAt-firstImportStartedAt)/1000)}s, openModelReplay=${Math.floor((firstModelFinishedAt-firstModelStartedAt)/1000)}s, prefetchHints=${primedReadHints.length}, pinnedQuoteMetrics=${JSON.stringify(quoteCache.metrics())}`);
  const previewPersistStartedAt=Date.now(),preview=await store.recordPreview({campaignId,expectedRevision:1,kind:'open',
   request:{kind:'open',source:firstFrame.source},proposal:{rangekeeperPaperOpenModel:firstModel},
   evidence:{classification:'rangekeeper_paper_open_model_v1'},expiresAt:previewExpiry}),
   previewPersistFinishedAt=Date.now();

  const preparedSecond=await preparedSecondWorkPromise;
  secondFrame=preparedSecond.frame;
  const gap=secondFrame.source.timestamp-firstFrame.source.timestamp;
  assert(gap>=30&&gap<=policy.policy.limits.maxObservationGapSeconds,'Second source gap violated frozen policy');
  const secondPlanStartedAt=Date.now(),secondPlanResult=await buildRangeKeeperPaperConfirmation({draft,firstModel,frame:secondFrame,
   buildId,client:rpc,readGasProfiles:readRows,marketGasPriceWei:await rpc.getGasPrice(),
   marketGasPriceObservedAt:Date.now(),simulate:async()=>{throw Error('probe-only must not simulate')},
   pinnedQuoteCache:quoteCache,preparation:preparedSecond.preparation,probeOnly:true}),secondPlanFinishedAt=Date.now();
  assert.equal(secondPlanResult?.status,'candidate','Fresh second observation did not confirm the candidate');
  assert.equal(secondPlanResult.candidateHash,preparedSecond.preparation.candidateHash,
   'Speculative second candidate differed from full first-model replay');
  assert.equal(contentHash(serializeCandidate(secondPlanResult.candidate)),
   contentHash(serializeCandidate(preparedSecond.preparation.candidate)),
   'Speculative second candidate body differed from full first-model replay');
  const secondCandidate=secondPlanResult.candidate,secondScope=secondPlanResult.scope,
   secondReport=preparedSecond.report,secondOwnedSimulation=preparedSecond.simulation,
   secondReportStartedAt=preparedSecond.reportStartedAt,secondReportFinishedAt=preparedSecond.reportFinishedAt;
  const secondImportStartedAt=Date.now();
  await register(secondReport,async({report,frame})=>{
   const replay=await buildRangeKeeperPaperConfirmation({draft,firstModel,frame,buildId,client:rpc,
    readGasProfiles:readRows,marketGasPriceWei:await rpc.getGasPrice(),marketGasPriceObservedAt:Date.now(),
    simulate:async()=>{throw Error('probe-only must not simulate')},pinnedQuoteCache:quoteCache,probeOnly:true});
   assert.equal(replay.status,'candidate');assert.equal(replay.candidateHash,report.candidateHash,
    'Persisted second kernel candidate changed');
   return {replayHash:contentHash({candidateHash:replay.candidateHash,
    source:frame.source,proofHash:frame.referenceProofHash})};
  });
  const secondImportFinishedAt=Date.now(),sourceAge=()=>Math.floor((Date.now()-firstFrame.source.timestamp*1000)/1000);
  process.stdout.write(JSON.stringify({event:'rangekeeper_paper_preview_timing',
   prime:{frameRead:(primePlanStartedAt-primeStartedAt)/1000,plan:(primePlanFinishedAt-primePlanStartedAt)/1000,
    ownedFork:(primeFinishedAt-primePlanFinishedAt)/1000,hintCount:primedReadHints.length},
   initialSourceAge:Math.floor((firstCapturedAt-firstFrame.source.timestamp*1000)/1000),
   phaseSeconds:{firstFrameRead:(firstCapturedAt-firstFrameReadStartedAt)/1000,
    firstPlan:(firstPlanFinishedAt-firstPlanStartedAt)/1000,
    firstReport:(firstReportFinishedAt-firstReportStartedAt)/1000,
    secondFrameWait:(secondFrameCapturedAt-firstCapturedAt)/1000,
    firstImport:(firstImportFinishedAt-firstImportStartedAt)/1000,
    openModelOverlapWall:(firstModelFinishedAt-firstModelStartedAt)/1000,
    speculativeOpenModel:overlapTiming?.speculativeModelMs/1000,
    registrationParallel:overlapTiming?.registrationMs/1000,
    secondFramePinnedReread:(preparedSecond.pinnedRereadFinishedAt-preparedSecond.pinnedRereadStartedAt)/1000,
    speculativeSecondPlan:(preparedSecond.preparationFinishedAt-preparedSecond.preparationStartedAt)/1000,
    speculativeSecondOwnedFork:(preparedSecond.reportFinishedAt-preparedSecond.reportStartedAt)/1000,
    secondProbe:(secondPlanFinishedAt-secondPlanStartedAt)/1000,
    secondReport:(secondReportFinishedAt-secondReportStartedAt)/1000,
    secondImport:(secondImportFinishedAt-secondImportStartedAt)/1000},
   sourceAge:sourceAge(),quoteCache:quoteCache.metrics(),forkReadMetrics})+'\n');
  // Keep the saved first-observation preview fresh through the expensive
  // source-bound gas sampling above. Its expiry remains the planner's original
  // 90-second candidate deadline; the test never extends it.
  assert(previewExpiry.getTime()>Date.now(),
   `First source preview expired before producer could persist confirmation: initialSourceAge=${Math.floor((firstCapturedAt-firstFrame.source.timestamp*1000)/1000)}s, firstPlan=${(firstPlanFinishedAt-firstPlanStartedAt)/1000}s, finalSourceAge=${sourceAge()}s, firstReport=${Math.floor((firstReportFinishedAt-firstReportStartedAt)/1000)}s, secondFrameWait=${Math.floor((secondFrameCapturedAt-firstCapturedAt)/1000)}s, firstImport=${Math.floor((firstImportFinishedAt-firstImportStartedAt)/1000)}s, openModelReplay=${Math.floor((firstModelFinishedAt-firstModelStartedAt)/1000)}s, secondObservationGap=${gap}s, secondPlan=${(secondPlanFinishedAt-secondPlanStartedAt)/1000}s, secondReport=${Math.floor((secondReportFinishedAt-secondReportStartedAt)/1000)}s, secondImport=${Math.floor((secondImportFinishedAt-secondImportStartedAt)/1000)}s, prefetchHintCount=${primedReadHints.length}, ownedForkReadMetrics=${JSON.stringify(forkReadMetrics)}`);
  const producerStartedAt=Date.now(),producerMetrics=[];
  let producerReceiptFailure='not_called',producerReceiptAnchorMs=0,producerReceiptCallMs=0;
  const persistProducerReceipt=store.recordRangeKeeperPaperConfirmationProducerReceipt.bind(store);
  store.recordRangeKeeperPaperConfirmationProducerReceipt=async input=>{
   const callStartedAt=Date.now();
   try{return await persistProducerReceipt({...input,verifyAnchors:async(chainId,sources)=>{
    const anchorStartedAt=Date.now();
    try{return await input.verifyAnchors(chainId,sources);}
    finally{producerReceiptAnchorMs+=Date.now()-anchorStartedAt;}
   }});}
   catch(error){const message=error instanceof Error?error.message:'';
    producerReceiptFailure=/^[a-z][a-z0-9_]+$/.test(message)?message:'nonstandard_error';throw error;}
   finally{producerReceiptCallMs=Date.now()-callStartedAt;}
  };
  const producer=createRangeKeeperPaperConfirmationProducer({store,client:rpc,rpcUrl:archive,
   beforeRead:async()=>{},pinnedQuoteCache:quoteCache,readCanonicalFrame:async(_client,receivedProfile)=>{
    assert.equal(contentHash(receivedProfile),contentHash(profile),'Prepared frame profile changed');
    return preparedSecond.frame;
   },
   preparation:preparedSecond.preparation,
   prefetchHints:firstReadHints,
   reusableSimulation:secondOwnedSimulation,
   onReadDiagnostics:metrics=>{producerMetrics.push(metrics);forkReadMetrics.push(metrics);}});
  const envelope=await producer(campaignId);
  const producerFinishedAt=Date.now();
  assert.equal(envelope.status,'confirmed',`Producer failed: ${envelope.reason??'unavailable'}, receiptError=${producerReceiptFailure}, receiptMs=${producerReceiptCallMs}, receiptAnchorMs=${producerReceiptAnchorMs}`);
  const operationId=randomUUID(),workerId='rk-open-positive-test-worker',
   requestDigest=contentHash({campaignId,previewId:preview.id,contentDigest:preview.contentDigest,
    expectedRevision:1});
  await admin.query(`INSERT INTO deployment_operations
   (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage,attempts)
   VALUES($1,$2,$3,'test','rk-open-positive-positive-test',$4,'open','queued','accepted',0)`,
   [operationId,campaignId,preview.id,requestDigest]);
  await admin.query("UPDATE deployment_campaigns SET lifecycle='opening' WHERE id=$1",[campaignId]);
  const workerStartedAt=Date.now(),workerResult=await processOnePaperOperation(store,rpc,store.readPool,workerId,{rpcUrl:archive}),
   workerFinishedAt=Date.now();
  assert.equal(workerResult.status,'completed',`Worker completion failed: ${workerResult.reason??''}`);
  const booked=(await admin.query(`SELECT count(*)::int AS marks FROM deployment_marks WHERE campaign_id=$1`,
   [campaignId])).rows[0].marks,
   capital=(await admin.query(`SELECT count(*)::int AS rows FROM deployment_ledger
    WHERE campaign_id=$1 AND operation_id=$2 AND kind='capital_in'`,[campaignId,operationId])).rows[0].rows;
  assert.equal(booked,1);assert.equal(capital,3);
  const dashboardStartedAt=Date.now(),projectionRow=(await readDeploymentRows(admin)).find(row=>row.id===campaignId);
  assert(projectionRow,'Booked RangeKeeper campaign is missing from deployment dashboard rows');
  const projected=await readDeploymentDetail(admin,projectionRow,1);
  assert.equal(projected.position.status,'open');
  assert.equal(projected.position.hasLiquidity,true);
  assert.equal(projected.position.accounting,'unavailable');
  assert.equal(projected.performance.markCount,1);
  assert.equal(projected.performance.timeline[0].action,'enter');
  assert.equal(projected.performance.timeline[0].economicNavQuote,null);
  assert.equal(projected.performance.timeline[0].feeIncomeQuote,null);
  assert.equal(projected.performance.timeline[0].gasQuote,null);
  assert(projected.position.inventory.tokens.some(token=>token.amountRaw!==null),
   'Booked RangeKeeper inventory is missing from dashboard projection');
  const dashboardFinishedAt=Date.now();
  const restart=new (store.constructor)(scopedUrl.toString());
  const restartStartedAt=Date.now(),verify=async(chainId,sources)=>verifyCanonicalPaperAnchors(rpc,chainId,sources),
   snapshot=await restart.rangeKeeperPaperConfirmationOperationSnapshot({operationId,workerId,
    verifyAnchors:verify}),
   confirmation=await loadRangeKeeperPaperConfirmationContext({campaignId,
    runtimeIdentity:snapshot.runtimeIdentity,readSnapshot:async()=>snapshot.confirmationContext,
    readGasProfiles:query=>restart.rangeKeeperPaperGasProfiles(query.poolAddress,query.pathVersion,query.sizeBand),
    now:snapshot.acceptedAt.getTime()});
  assert.equal(confirmation.status,'available',`Restart context failed: ${confirmation.reason??''}`);
  const adapter=adaptRangeKeeperConfirmedOpenContext(confirmation),saved={
   source:confirmation.envelope.confirmationObservation.source,
   tick:confirmation.envelope.confirmationObservation.poolState.tick,
   sqrtPriceX96:BigInt(confirmation.envelope.confirmationObservation.poolState.sqrtPriceX96),
   poolLiquidity:BigInt(confirmation.envelope.confirmationObservation.poolState.poolLiquidity),
   price0:BigInt(confirmation.envelope.confirmationObservation.reference.price0),
   price1:BigInt(confirmation.envelope.confirmationObservation.reference.price1),
   nativePrice:BigInt(confirmation.envelope.confirmationObservation.reference.nativePrice),
   referenceEligible:true,referenceReasons:[],
   referenceProofHash:confirmation.envelope.confirmationObservation.reference.proofHash,
   referenceProof:confirmation.envelope.confirmationObservation.reference.proof},
   frame=await readRangeKeeperPaperConfirmationFrame({client:rpc,profile,saved}),
   replay=await replayRangeKeeperPaperConfirmationOnOwnedFork({draft:confirmation.draft,
    envelope:confirmation.envelope,frame,operationId,openPreviewId:snapshot.openPreviewId,
    operationSnapshotHash:snapshot.snapshotHash,rpcUrl:archive,beforeRead:async()=>{},timeoutMs:180_000}),
   replayed=await restart.completeRangeKeeperPaperConfirmedOpen({operationId,workerId,snapshot,
    adapter,replay,verifyAnchors:verify});
  assert.equal(replayed.replayed,true,'Restart replay did not remain idempotent');
  const restartResult=await processOnePaperOperation(restart,rpc,restart.readPool,workerId,{rpcUrl:archive});
  assert.equal(restartResult.status,'idle');
  const restartFinishedAt=Date.now();
  await restart.close();
  process.stdout.write(JSON.stringify({status:'booked',campaignId,operationId,
   markCount:booked,capitalInRows:capital,producerReceipt:true,ownedForkReplay:true,
   workerRestartIdle:true,postCommitReplay:true,dashboardProjection:true,
   phaseSeconds:{firstFrameRead:(firstCapturedAt-firstFrameReadStartedAt)/1000,
    firstPlan:(firstPlanFinishedAt-firstPlanStartedAt)/1000,
    firstOwnedFork:(firstReportFinishedAt-firstReportStartedAt)/1000,
    observationWait:(secondFrameCapturedAt-firstCapturedAt)/1000,
    firstImport:(firstImportFinishedAt-firstImportStartedAt)/1000,
    firstModelReplay:(firstModelFinishedAt-firstModelStartedAt)/1000,
    previewPersistence:(previewPersistFinishedAt-previewPersistStartedAt)/1000,
    secondPlan:(secondPlanFinishedAt-secondPlanStartedAt)/1000,
    secondOwnedFork:(secondReportFinishedAt-secondReportStartedAt)/1000,
    secondImport:(secondImportFinishedAt-secondImportStartedAt)/1000,
    producerOwnedFork:(producerFinishedAt-producerStartedAt)/1000,
    workerCompletion:(workerFinishedAt-workerStartedAt)/1000,
    dashboardProjection:(dashboardFinishedAt-dashboardStartedAt)/1000,
    restartContextAndReplay:(restartFinishedAt-restartStartedAt)/1000},
   prefetchHintCount:firstReadHints.length,producerPrefetchMetrics:producerMetrics[0]??null,
   producerReceiptDiagnostics:{failure:producerReceiptFailure,elapsedMs:producerReceiptCallMs,
    anchorMs:producerReceiptAnchorMs},
   bookingAvailable:false,actionAvailable:false})+'\n');
 }finally{
  if(store)await store.close().catch(()=>{});
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});
  admin.release();await adminPool.end();
 }
}catch(error){safeError(error);}
