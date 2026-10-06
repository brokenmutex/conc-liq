// Synthetic isolated PostgreSQL qualification of the operator management hold (preview lock and pending-review window).
// It creates no RPC client, transaction, signer, or production write.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {recordWalletSnapshot,readCommitments,readReview,readWalletState,recordReview,releaseLiveWalletAllocation} from
 '../../src/deployments/live-wallet-store.ts';
import {LiveWalletQueue} from '../../src/deployments/live-wallet-queue.ts';
import {recordRangeKeeperLiveManagementReview,admitRangeKeeperLiveManagement} from '../../src/deployments/rangekeeper-live-management.ts';
import {readRangeKeeperLiveCampaign,recordRangeKeeperLiveValuationMarkInTransaction,rangeKeeperLiveInitialCapitalValueX18} from '../../src/deployments/rangekeeper-live-campaign-store.ts';
import {createRangeKeeperLiveReviewRuntime} from '../../src/deployments/rangekeeper-live-review-runtime.ts';
import {createRangeKeeperLiveManagementPlanner} from '../../src/deployments/rangekeeper-live-management-planner.ts';
import {createRangeKeeperLiveManagementObserver} from "../../src/deployments/rangekeeper-live-management-observer.ts";
import {createRangeKeeperLiveManagementRuntime} from "../../src/deployments/rangekeeper-live-management.ts";
import {withLiveManagementPreviewHold,tryAcquireLiveWalletObservationLease,liveWalletHasPendingManagementReview,LiveManagementHoldUnavailable} from "../../src/deployments/live-management-hold.ts";
import {parseRangeKeeperConfig,rangeKeeperConfigHash,initialRangeKeeperState} from '../../src/strategy/rangekeeper/config.ts';
import {rangeKeeperJson} from '../../src/strategy/rangekeeper/live-domain.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL must name a disposable isolated database');
const root=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await root.connect();
const schema=`rk_live_management_${randomUUID().replaceAll('-','')}`;
const wallet='0x0000000000000000000000000000000000000900',token0='0x1000000000000000000000000000000000000001';
const token1='0x2000000000000000000000000000000000000002',manager='0x5000000000000000000000000000000000000005';
// The campaign is opened under buildId and managed by a different, later build (managerBuildId): a deploy never strands it.
const buildId='b'.repeat(64),managerBuildId='9'.repeat(64),otherBuildId='8'.repeat(64),profileId=randomUUID(),campaignId=randomUUID(),allocationId=randomUUID(),openReviewId=randomUUID(),openJobId=randomUUID();
const source={block:'78211393',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
const addr=n=>`0x${BigInt(n).toString(16).padStart(40,'0')}`,hash=c=>`0x${c.repeat(64)}`;
const limits={maxDeploymentValue:'1000000000000000000',minDeploymentPpm:1,maxSwapInputValue:'1000000000000000000',
 maxSwapInputPpm:1000000,maxSwapShortfallValue:'1000',maxSlippageBps:50,maxActionCost:'1000',maxRollingCost:'1000',
 maxCampaignCost:'1000',maxExposurePpm:1000000,maxLossValue:'1000',maxDrawdownPpm:1000000,maxRecenters:2,
 maxLiquiditySharePpm:1000000,maxObservationGapSeconds:90,exitReserveWei:'1000',fullWidthSpacings:120};
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:addr(300),pool:addr(400),token0,token1,quoteToken:0,
 decimals0:6,decimals1:18,fee:500,tickSpacing:10,positionManager:manager,router:addr(600),quoter:addr(700),
 poolCodeHash:hash('1'),token0CodeHash:hash('2'),token1CodeHash:hash('3'),managerCodeHash:hash('4'),quoterCodeHash:hash('5'),
 reference0:'USDG/USD',reference1:'TEST/USD',nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
const profileHash=contentHash(profile),walletIdentity={chainId:4663,address:wallet};
const config=parseRangeKeeperConfig({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',broadcastEnabled:false,
 operator:wallet,pool:profile.pool,limits,signer:null,walletCode:{kind:'eoa'},zeroAllowances:[],legacyRetiredTokenIds:[],
 campaignScope:{maxDurationSeconds:43200,maxEconomicActions:2},referencePolicy:profile.referencePolicy,
 campaignValue:'2000000000000000000',strategyFundingValue:'1000000000000000000',nativeFundingValue:'2000'});
const configHash=rangeKeeperConfigHash(config),configJson=JSON.parse(JSON.stringify(config,(_,v)=>typeof v==='bigint'?String(v):v));
const setupPayload={schemaVersion:1,kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',
 profileId,profileHash,source,wallet:{address:wallet,source,nonce:'5',commitmentsHash:'0'.repeat(64)},
 requirements:{token0Raw:'100',token1Raw:'100',nativeWei:'2000'},references:{price0:'1',price1:'1',nativePrice:'1',proofHash:'d'.repeat(64)},
 policy:{config:configJson,configHash:configHash.slice(2),parameters:limits},binding:{buildId},missing:[],executionEligible:false};
const revisionConfig={...limits,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1};
const allocationHash='c'.repeat(64);
const position={tokenId:77n,owner:wallet,token0,token1,fee:500,tickLower:-60,tickUpper:60,liquidity:10_000n,tokensOwed0:0n,tokensOwed1:0n};
const snapshot={source:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp},operator:wallet,wallet0:1000n,wallet1:1000n,
 nativeWei:100_000n,nonce:5n,nftCount:1n,tick:0,sqrtPriceX96:1n<<96n,unlocked:true,poolLiquidity:100_000n,allowances:[],position};
const state={version:1,id:campaignId,operator:wallet,configHash,buildId,phase:'holding',desired:'running',exitMode:null,haltReason:null,
 createdAt:source.timestamp-1,expiresAt:source.timestamp+43200,economicActions:1,recenters:0,policy:initialRangeKeeperState(config,buildId),
 last:snapshot,activeTokenId:77n,retiredTokenIds:[],legacyNftCount:1n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,
 initial0:100n,initial1:100n,initialNativeWei:2000n,initialStrategyValue:1n,candidate:null,swapDone:false,swapConfirmedAt:null,
 withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,collectedFee0:0n,collectedFee1:0n,
 gasSpentWei:0n,costEvents:[],highWaterValue:1n,activeSeconds:1,outsideSeconds:0,lastMarkTimestamp:source.timestamp,
 lastReason:'live_open_reserved',closedAt:null};
const runtimeStateJson=JSON.parse(rangeKeeperJson(state)),runtimeStateHash=contentHash(runtimeStateJson);
assert.equal(rangeKeeperLiveInitialCapitalValueX18({initialNativeWei:2n*10n**18n,initialStrategyValue:5n*10n**18n},
 {references:{nativePrice:String(3n*10n**18n)}}),'11000000000000000000');
assert.equal(rangeKeeperLiveInitialCapitalValueX18({initialNativeWei:1n,initialStrategyValue:5n},{references:{}}),null);
const references={source,price0:100n,price1:200n,nativePrice:300n,proofHash:'d'.repeat(64),evidence:{kind:'synthetic_test_reference'}};
const managementQueueAdapters={authorizeStage:async()=>{throw Error('No stage authorization in this storage test');},
 reconcile:async()=>{throw Error('No canonical receipt adapter in this storage test');},
 verifyCleanup:async()=>{throw Error('No cleanup adapter in this storage test');}};
// Revision rows are immutable evidence; the disposable schema lifts that only to simulate a future incompatible persisted identity.
const mutateRevision=async(db,set)=>{await db.query('ALTER TABLE deployment_revisions DISABLE TRIGGER USER');
 try{await db.query(`UPDATE deployment_revisions SET ${set} WHERE campaign_id=$1`,[campaignId]);}
 finally{await db.query('ALTER TABLE deployment_revisions ENABLE TRIGGER USER');}};
const json=(v)=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));

try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
 const db=new pg.Pool({connectionString:url.toString(),max:8});
 try{
  await db.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,token0_decimals,
   token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
   VALUES($1,4663,$2,$3,$4,6,18,0,500,10,$5,'{}',$6,clock_timestamp())`,
   [profileId,profile.pool.pool,token0,token1,profile,profileHash]);
  const empty=liveWalletCommitmentFingerprint({wallet:walletIdentity,allocations:[],nftCustody:[]});
  await recordWalletSnapshot(db,{...walletIdentity,source,nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
   tokens:[{address:token0,balanceRaw:'1000'},{address:token1,balanceRaw:'1000'}],commitmentsHash:empty});
  await db.query(`INSERT INTO deployment_campaigns(id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision,runtime_identity)
   VALUES($1,'live',4663,$2,$3,$4,'opening',1,$5)`,[campaignId,wallet,profileId,{token0Raw:'100',token1Raw:'100',nativeWei:'2000'},
    {buildId,source}]);
  await db.query(`INSERT INTO deployment_revisions(campaign_id,revision,parent_revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
   VALUES($1,1,NULL,'rangekeeper_v1','1.0.0',1,$2,$3)`,[campaignId,revisionConfig,contentHash(revisionConfig)]);
  await db.query(`INSERT INTO deployment_live_allocations(id,chain_id,wallet,campaign_id,revision,state,native_spend_wei,exit_reserve_wei,
   source_generation,source_hash,allocation_hash) VALUES($1,4663,$2,$3,1,'reserved',1000,1000,1,$4,$5)`,
   [allocationId,wallet,campaignId,source.hash,allocationHash]);
  await db.query(`INSERT INTO deployment_live_allocation_tokens(allocation_id,chain_id,wallet,token_address,allocated_raw)
   VALUES($1,4663,$2,$3,100),($1,4663,$2,$4,100)`,[allocationId,wallet,token0,token1]);
  await db.query(`INSERT INTO deployment_live_nft_custody(chain_id,wallet,position_manager,token_id,allocation_id,campaign_id,status,
   liquidity,tokens_owed0,tokens_owed1,source_block,source_hash,source_timestamp)
   VALUES(4663,$1,$2,77,$3,$4,'active',10000,0,0,$5,$6,$7)`,[wallet,manager,allocationId,campaignId,source.block,source.hash,source.timestamp]);
  let commitments=await readCommitments(db,walletIdentity),commitmentsHash=liveWalletCommitmentFingerprint(commitments);
  let walletState=await recordWalletSnapshot(db,{...walletIdentity,source,nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
   tokens:[{address:token0,balanceRaw:'1000'},{address:token1,balanceRaw:'1000'}],commitmentsHash});
  // Model a source-only wallet refresh: wallet generation is a content version, so identical funds, nonce and
  // commitments keep generation 2 (the allocation insert above already advanced it past this allocation's 1).
  walletState=await recordWalletSnapshot(db,{...walletIdentity,source,nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
   tokens:[{address:token0,balanceRaw:'1000'},{address:token1,balanceRaw:'1000'}],commitmentsHash});
  assert.equal(walletState.generation,2);assert.equal(Number((await db.query('SELECT source_generation FROM deployment_live_allocations WHERE id=$1',[allocationId])).rows[0].source_generation),1);

  const openReview=await recordReview(db,{...walletIdentity,reviewId:openReviewId,payload:setupPayload,payloadHash:contentHash(setupPayload),
   buildId,source,expiresAt:new Date(Date.now()+60_000),walletGeneration:walletState.generation,commitmentsHash});
  const openPayloadHash=contentHash(setupPayload);
  await db.query(`INSERT INTO deployment_live_jobs(id,chain_id,wallet,campaign_id,revision,allocation_id,review_id,kind,status,payload,
   payload_hash,build_id,idempotency_key,request_digest,completed_at)
   VALUES($1,4663,$2,$3,1,$4,$5,'open','succeeded',$6,$7,$8,'fixture-open',$9,clock_timestamp())`,
   [openJobId,wallet,campaignId,allocationId,openReview.reviewId,setupPayload,openPayloadHash,buildId,'e'.repeat(64)]);
  // Campaign source reservation intentionally predates sibling-wide generation.
  const baseline={requirements:{nativeWei:'2000'},references:{},source};
  await db.query(`INSERT INTO deployment_live_campaign_runtime(campaign_id,revision,chain_id,wallet,profile_id,profile_hash,config_hash,
   allocation_id,state_json,state_hash,state_revision,source_block,source_hash,source_timestamp,status,initial_token0_raw,initial_token1_raw,
   initial_native_wei,initial_baseline,opened_at)
   VALUES($1,1,4663,$2,$3,$4,$5,$6,$7,$8,4,$9,$10,$11,'active',100,100,2000,$12,clock_timestamp())`,
   [campaignId,wallet,profileId,profileHash,configHash.slice(2),allocationId,runtimeStateJson,runtimeStateHash,source.block,source.hash,
    source.timestamp,baseline]);
  await db.query(`UPDATE deployment_campaigns SET lifecycle='active' WHERE id=$1`,[campaignId]);
  await db.query(`UPDATE deployment_live_allocations SET state='active' WHERE id=$1`,[allocationId]);
  const valuationInput={wallet:walletIdentity,campaignId,revision:1,snapshot,references,positionFeeEvidence:{kind:'synthetic_fee_evidence'}};
  const markClient=await db.connect();
  try{
   const firstValuation=await recordRangeKeeperLiveValuationMarkInTransaction(markClient,valuationInput);
   assert.equal(firstValuation.replayed,false);
   const secondValuation=await recordRangeKeeperLiveValuationMarkInTransaction(markClient,valuationInput);
   assert.equal(secondValuation.replayed,true,'Repeated same-source valuation must replay after state-bound mark persistence');
  }finally{markClient.release();}
  assert.equal((await db.query(`SELECT count(*) n FROM deployment_live_runtime_events WHERE campaign_id=$1 AND kind='mark'`,[campaignId])).rows[0].n,'1');
  // Keep the campaign state snapshot nonce and wallet source in exact agreement.
  let campaign=await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId});
  assert.equal(campaign.allocation.sourceGeneration,1);assert.equal((await readWalletState(db,walletIdentity)).generation,2);

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const advisoryHeld=async()=>Number((await db.query("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND granted")).rows[0].n);
  const queue=new LiveWalletQueue(db,managementQueueAdapters);
  const otherWallet={chainId:4663,address:'0x0000000000000000000000000000000000000901'};
  const stateNow=async()=>{const c=await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId});return {hash:c.stateHash,rev:c.stateRevision,c};};
  const walletSourceNow=async()=>(await readWalletState(db,walletIdentity)).source;

  // 1. The preview lock: mutual exclusion with the observer lease, per wallet, released in every exit path.
  assert.equal(await advisoryHeld(),0);
  await withLiveManagementPreviewHold(db,walletIdentity,async()=>{
   assert.equal(await tryAcquireLiveWalletObservationLease(db,walletIdentity),null,'observer lease must fail while a preview holds the wallet');
   const sibling=await tryAcquireLiveWalletObservationLease(db,otherWallet);
   assert(sibling,'another wallet is never held');await sibling.release();
  });
  assert.equal(await advisoryHeld(),0,'preview lock released after fn');
  await assert.rejects(withLiveManagementPreviewHold(db,walletIdentity,async()=>{throw Error('preview failed');}),/preview failed/);
  assert.equal(await advisoryHeld(),0,'preview lock released after fn throws');
  const lease=await tryAcquireLiveWalletObservationLease(db,walletIdentity);assert(lease);
  assert.equal(await tryAcquireLiveWalletObservationLease(db,walletIdentity),null,'one observer lease at a time');
  // A preview waits for an observer refresh in progress, then runs once it ends.
  const waiting=withLiveManagementPreviewHold(db,walletIdentity,async()=>'ran',{waitMs:5000});
  await sleep(150);await lease.release();assert.equal(await waiting,'ran');assert.equal(await advisoryHeld(),0);
  // ...and fails closed (no lock left behind) when the observer outlasts the wait.
  const stuck=await tryAcquireLiveWalletObservationLease(db,walletIdentity);assert(stuck);
  await assert.rejects(withLiveManagementPreviewHold(db,walletIdentity,async()=>'never',{waitMs:200}),
   e=>e instanceof LiveManagementHoldUnavailable&&e.reason==='live_management_hold_busy');
  await stuck.release();assert.equal(await advisoryHeld(),0);
  // A preview that outlives maxHoldMs loses the lock: its connection is destroyed, so PostgreSQL drops the session lock.
  await withLiveManagementPreviewHold(db,walletIdentity,async()=>{
   await sleep(600);
   const reacquired=await tryAcquireLiveWalletObservationLease(db,walletIdentity);
   assert(reacquired,'a hung preview must not hold the wallet past its bound');await reacquired.release();
  },{maxHoldMs:200});
  assert.equal(await advisoryHeld(),0);
  assert.equal(db.waitingCount,0);

  // 2. The pending-review hold: unexpired and unconsumed close reviews only.
  const walletGeneration=(await readWalletState(db,walletIdentity)).generation;
  const putReview=async(operationKind,kind='rangekeeper_live_management_review')=>{
   const payload={schemaVersion:1,kind,operationKind,campaignId,fixture:randomUUID()};const reviewId=randomUUID();
   await recordReview(db,{...walletIdentity,reviewId,payload,payloadHash:contentHash(payload),buildId:managerBuildId,source,
    expiresAt:new Date(Date.now()+60_000),walletGeneration,commitmentsHash});return reviewId;};
  const expire=id=>db.query("UPDATE deployment_live_reviews SET created_at=clock_timestamp()-interval '10 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
  assert.equal(await liveWalletHasPendingManagementReview(db,walletIdentity),false);
  const setupOnly=await putReview('close_retain','rangekeeper_live_setup_preflight');
  assert.equal(await liveWalletHasPendingManagementReview(db,walletIdentity),false,'a non-management review is not a hold');
  const autoRecenter=await putReview('change_range');
  assert.equal(await liveWalletHasPendingManagementReview(db,walletIdentity),false,'worker recenter reviews are admitted at once and never hold');
  await expire(setupOnly);await expire(autoRecenter);

  // 3. The observer skips while held and resumes at expiry or consumption. A skipped campaign never reaches the wallet
  // refresh: the profile loader is the first thing a refresh would call, and the RPC client throws on any use.
  let profileLoads=0;
  const observer=createRangeKeeperLiveManagementObserver({pool:db,client:new Proxy({},{get(){throw Error('no RPC in this test');}}),
   wallet:walletIdentity,loadProfiles:async()=>{profileLoads++;throw Error('profile load stub');},transferStore:{},buildId:managerBuildId,
   rpcUrl:'http://127.0.0.1:1',anvilBinary:'/unused',queueReady:async()=>true,enqueue:async()=>{throw Error('no enqueue');},persistReviews:true});
  const before0=await stateNow(),sourceBefore=await walletSourceNow();
  let pass=await observer.observeHoldingCampaigns();
  assert.equal(pass.status,'observed');assert.equal(profileLoads,1,'control: with no hold the observer attempts the campaign');
  assert.equal(await advisoryHeld(),0,'the observer releases its lease');
  await withLiveManagementPreviewHold(db,walletIdentity,async()=>{
   pass=await observer.observeHoldingCampaigns();
   assert.equal(pass.status,'held');assert(pass.missing.includes('operator_management_preview_in_progress'));
  });
  assert.equal(profileLoads,1,'no wallet refresh while a preview is in progress');
  const pendingRetain=await putReview('close_retain');
  assert.equal(await liveWalletHasPendingManagementReview(db,walletIdentity),true);
  pass=await observer.observeHoldingCampaigns();
  assert.equal(pass.status,'held');assert(pass.missing.includes('operator_management_review_pending'));
  assert.equal(profileLoads,1,'no wallet refresh while an unexpired review exists');
  assert.equal(await advisoryHeld(),0,'the held observer releases its lease');
  await expire(pendingRetain);
  assert.equal(await liveWalletHasPendingManagementReview(db,walletIdentity),false);
  pass=await observer.observeHoldingCampaigns();assert.equal(pass.status,'observed');assert.equal(profileLoads,2,'resumes at expiry');
  const pendingConvert=await putReview('close_convert');
  pass=await observer.observeHoldingCampaigns();assert.equal(pass.status,'held');assert.equal(profileLoads,2);
  await db.query('UPDATE deployment_live_reviews SET consumed_by_job=$2 WHERE id=$1',[pendingConvert,openJobId]);
  pass=await observer.observeHoldingCampaigns();assert.equal(pass.status,'observed');assert.equal(profileLoads,3,'resumes once the review is consumed');
  const after0=await stateNow();assert.equal(after0.hash,before0.hash);assert.deepEqual(await walletSourceNow(),sourceBefore);

  // 4. Preview then admission with worker passes before, during and after the preview. The preview rereads the campaign under
  // the hold, so a mark written before it started cannot be frozen into the review.
  const costs={status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,gasWei:'5',gasValueUsdX18:'7',actionCostValue:'7'};
  const runtimeLoads=profileLoads;let seenByObserve=null,passesDuringPreview=[];
  const makeRuntime=(observe)=>createRangeKeeperLiveManagementRuntime({pool:db,wallet:walletIdentity,buildId:managerBuildId,persistReviews:true,
   observe,verifyPinned:async()=>true,enqueue:job=>queue.enqueue(job)});
  let obsSource=source;
  const fakeObserve=async c=>{
   seenByObserve=c.stateHash;
   // The worker's pass runs while the (slow) preview simulation is in flight.
   passesDuringPreview.push(await observer.observeHoldingCampaigns());
   const pinned={block:BigInt(obsSource.block),hash:obsSource.hash,timestamp:obsSource.timestamp};
   return {source:obsSource,snapshot:{...snapshot,source:pinned},references:{...references,source:obsSource},
    position:{tokenId:'77',liquidityRaw:'10000',principal0Raw:'100',principal1Raw:'100',uncollected0Raw:'0',uncollected1Raw:'0'},
    decision:{reason:'retain_only_preview',observationHash:'f'.repeat(64)},costs:{...costs,source:obsSource},expiresAt:obsSource.timestamp+90};};
  const management=makeRuntime(fakeObserve);
  const preState=await stateNow();
  const preview=await management.retainPreview(campaignId);
  assert.equal(preview.status,'indicative',JSON.stringify(preview));
  assert.equal(passesDuringPreview[0].status,'held','worker pass during the preview is held');
  assert.equal(seenByObserve,preState.hash);assert.equal(await advisoryHeld(),0,'the preview releases its lock once the review is recorded');
  // Worker passes between preview and admission (the operator's confirm delay) change nothing.
  for(let i=0;i<3;i++){pass=await observer.observeHoldingCampaigns();assert.equal(pass.status,'held');await sleep(50);}
  assert.equal(profileLoads,runtimeLoads,'no wallet refresh at any point of the preview window');
  assert.deepEqual(await walletSourceNow(),source,'wallet source stays at the review source');
  assert.equal((await stateNow()).hash,preState.hash,'no mark rewrote the campaign state');
  const admitted=await management.retainOperation(campaignId,{previewId:preview.previewId,contentDigest:preview.contentDigest,
   expectedRevision:preview.expectedRevision,idempotencyKey:'hold-retain-1'});
  assert.equal(admitted.status,'queued',JSON.stringify(admitted));
  assert.equal((await readReview(db,{...walletIdentity,reviewId:preview.previewId})).consumedByJob,admitted.jobId);
  assert.equal(await liveWalletHasPendingManagementReview(db,walletIdentity),false,'admission consumes the hold');
  // The campaign now has its own job, which the observer already respects.
  pass=await observer.observeHoldingCampaigns();assert.equal(pass.status,'observed');assert.equal(profileLoads,runtimeLoads,'campaignWork still skips');
  await db.query("UPDATE deployment_live_jobs SET status='succeeded',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[admitted.jobId]);

  // Integrity is not loosened: a mark written between preview and confirm still fails admission.
  const staleManagement=makeRuntime(async c=>({...(await fakeObserve(c))}));
  const stalePreview=await staleManagement.retainPreview(campaignId);assert.equal(stalePreview.status,'indicative',JSON.stringify(stalePreview));
  const markClient2=await db.connect();
  try{await recordRangeKeeperLiveValuationMarkInTransaction(markClient2,{wallet:walletIdentity,campaignId,revision:1,
   snapshot:{...snapshot,source:{block:BigInt(source.block)+9n,hash:hash('7'),timestamp:source.timestamp+5}},references:null});}
  finally{markClient2.release();}
  // The wallet and runtime move on together, as the worker's refresh-then-mark does; later reviews pin the new source.
  obsSource={block:String(BigInt(source.block)+9n),hash:hash('7'),timestamp:source.timestamp+5};
  await recordWalletSnapshot(db,{...walletIdentity,source:obsSource,nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
   tokens:[{address:token0,balanceRaw:'1000'},{address:token1,balanceRaw:'1000'}],commitmentsHash});
  const rejected=await staleManagement.retainOperation(campaignId,{previewId:stalePreview.previewId,contentDigest:stalePreview.contentDigest,
   expectedRevision:stalePreview.expectedRevision,idempotencyKey:'hold-retain-stale'});
  assert.equal(rejected.status,'unavailable');assert(rejected.missing.some(m=>/Campaign changed after management preview/.test(m)),JSON.stringify(rejected));
  await expire(stalePreview.previewId);

  // 5. The worker's risk exit is never blocked by the hold. A pending operator review plus a held preview lock, and the
  // planner still freezes and queues its safety retain; the operator's review is then no longer admissible.
  const operatorPreview=await makeRuntime(async c=>({...(await fakeObserve(c))})).retainPreview(campaignId);
  assert.equal(operatorPreview.status,'indicative',JSON.stringify(operatorPreview));
  const stopped=structuredClone((await stateNow()).c.state);stopped.desired='stopped';
  const stoppedJson=JSON.parse(rangeKeeperJson(stopped));
  await db.query('UPDATE deployment_live_campaign_runtime SET state_json=$2,state_hash=$3,state_revision=state_revision+1 WHERE campaign_id=$1',
   [campaignId,stoppedJson,contentHash(stoppedJson)]);
  const exitSource={block:String(BigInt(obsSource.block)+1n),hash:hash('8'),timestamp:obsSource.timestamp+60};
  const exitSnapshot={...snapshot,source:{...exitSource,block:BigInt(exitSource.block)},tick:0};
  const exitReferences={...references,source:exitSource,price1:100_000_000_000_000n};
  const riskPlanner=createRangeKeeperLiveManagementPlanner({pool:db,wallet:walletIdentity,client:{
   getBlock:async(args)=>args?.blockNumber!==undefined?{number:args.blockNumber,hash:args.blockNumber===BigInt(exitSource.block)?exitSource.hash:obsSource.hash,
    timestamp:args.blockNumber===BigInt(exitSource.block)?exitSource.timestamp:obsSource.timestamp,baseFeePerGas:1n}:
    {number:BigInt(exitSource.block)+64n,hash:exitSource.hash,timestamp:exitSource.timestamp},
   getGasPrice:async()=>1n},rpcUrl:'http://127.0.0.1:1',anvilBinary:'/unused',buildId:managerBuildId,enabled:true,queueReady:async()=>true,
   enqueue:job=>queue.enqueue(job),observer:{observeForManagement:async()=>({source:exitSource,snapshot:exitSnapshot,references:exitReferences,
    position:{principal0Raw:'100',principal1Raw:'100',uncollected0Raw:'0',uncollected1Raw:'0',inventory0Raw:'1100',inventory1Raw:'1100'},
    expiresAt:exitSource.timestamp+90}),observe:fakeObserve,verifyPinned:async()=>true}});
  let riskResult;
  await withLiveManagementPreviewHold(db,walletIdentity,async()=>{
   assert.equal(await liveWalletHasPendingManagementReview(db,walletIdentity),true);
   riskResult=await riskPlanner.planCampaign(campaignId);
  });
  assert.equal(riskResult.status,'queued',JSON.stringify(riskResult));assert.equal(riskResult.reason,'safety_retain_queued');
  const lateOperator=await makeRuntime(fakeObserve).retainOperation(campaignId,{previewId:operatorPreview.previewId,
   contentDigest:operatorPreview.contentDigest,expectedRevision:operatorPreview.expectedRevision,idempotencyKey:'hold-retain-after-risk'});
  assert.notEqual(lateOperator.status,'queued','the operator admission loses to the risk exit');
  assert.equal(await advisoryHeld(),0);
  console.log('RangeKeeper live management hold isolated PostgreSQL integration passed');
 }finally{await db.end();}
}finally{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await root.end();}
