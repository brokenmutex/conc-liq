// Synthetic isolated PostgreSQL qualification for management-review durability.
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

  // Automatic policy observations use the same wallet lock/CAS as lifecycle
  // effects, and the holding valuation callback sees the post-CAS hash. An
  // exact-source retry must not append a second policy event.
  const plannerSource={block:String(BigInt(source.block)+1n),hash:hash('8'),timestamp:source.timestamp+60};
  const plannerSnapshot={...snapshot,source:{...plannerSource,block:BigInt(plannerSource.block)},tick:0};
  const plannerReferences={...references,source:plannerSource,price1:100_000_000_000_000n};let valuationSawPersistedState=false;
  const planner=createRangeKeeperLiveManagementPlanner({pool:db,wallet:walletIdentity,client:{
   getBlock:async(args)=>args?.blockNumber!==undefined?{number:args.blockNumber,hash:args.blockNumber===BigInt(plannerSource.block)?plannerSource.hash:source.hash,
    timestamp:args.blockNumber===BigInt(plannerSource.block)?plannerSource.timestamp:source.timestamp,baseFeePerGas:1n}:
    {number:BigInt(plannerSource.block)+64n,hash:plannerSource.hash,timestamp:plannerSource.timestamp},
   getGasPrice:async()=>{throw Error('An inside-range observation must not request fork gas pricing');}},
   rpcUrl:'http://127.0.0.1:1',anvilBinary:'/unused',buildId:managerBuildId,enabled:true,queueReady:async()=>true,
   enqueue:async()=>{throw Error('An inside-range observation must not enqueue an operation');},
   observer:{observeForManagement:async()=>({source:plannerSource,snapshot:plannerSnapshot,references:plannerReferences,
    position:{principal0Raw:'100',principal1Raw:'100',uncollected0Raw:'0',uncollected1Raw:'0',inventory0Raw:'1100',inventory1Raw:'1100'},
    expiresAt:plannerSource.timestamp+90}),observe:async(c)=>{throw Error(`Unexpected safe retain: desired=${c.state?.desired} expired=${c.state?.expiresAt} actions=${c.state?.economicActions}/${c.config.campaignScope.maxEconomicActions}`);},
    verifyPinned:async()=>true,observeHoldingCampaigns:async()=>{
     const after=await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId});
     const latest=(await db.query("SELECT after_state_hash FROM deployment_live_runtime_events WHERE campaign_id=$1 AND kind='mark' ORDER BY sequence DESC LIMIT 1",[campaignId])).rows[0];
     assert.equal(after.stateHash,latest.after_state_hash);valuationSawPersistedState=true;return {status:'recorded'};
    }}});
  const plannerResult=await planner.planCampaign(campaignId);
  assert.equal(plannerResult.status,'wait');
  await planner.observeAndEnqueueManagement();
  assert(valuationSawPersistedState,'Holding valuation must run after the policy CAS');
  const afterPlanner=await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId});
  const plannerEventCount=Number((await db.query("SELECT count(*) n FROM deployment_live_runtime_events WHERE campaign_id=$1 AND payload->>'kind'='rangekeeper_live_management_observation_v1'",[campaignId])).rows[0].n);
  assert.equal(plannerEventCount,1,'One fresh inside-range source may append one policy observation');
  const duplicatePlanner=await planner.planCampaign(campaignId);
  assert.equal(duplicatePlanner.status,'wait');
  assert.equal(Number((await db.query("SELECT count(*) n FROM deployment_live_runtime_events WHERE campaign_id=$1 AND payload->>'kind'='rangekeeper_live_management_observation_v1'",[campaignId])).rows[0].n),plannerEventCount,
   'Duplicate source must not advance policy timers or append another event');
  const campaignAfterPlanner=await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId});
  assert.equal(campaignAfterPlanner.stateHash,afterPlanner.stateHash);
  campaign=campaignAfterPlanner;

  const queue=new LiveWalletQueue(db,managementQueueAdapters);
  const reviewInput={wallet:walletIdentity,campaign,operationKind:'close_retain',source,snapshot,
   references,position:{tokenId:'77',liquidityRaw:'10000',principal0Raw:'100',principal1Raw:'100',uncollected0Raw:'0',uncollected1Raw:'0'},
   decision:{reason:'fixture_retain',observationHash:'f'.repeat(64)},candidate:null,policy:null,
   costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,gasWei:'5',gasValueUsdX18:'7',actionCostValue:'7'},
   expiresAt:source.timestamp+90};
  // A campaign state/revision identity this build cannot manage fails closed, for the preview and for admission.
  await mutateRevision(db,'state_schema_version=2');
  const incompatible=await recordRangeKeeperLiveManagementReview(db,{...reviewInput,campaign:await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId})},{buildId:managerBuildId,verifyPinned:async()=>true});
  assert.equal(incompatible.status,'unavailable');
  assert(incompatible.missing.some(m=>m.startsWith('rangekeeper_live_campaign_build_incompatible')),JSON.stringify(incompatible));
  await mutateRevision(db,'state_schema_version=1');
  const preview=await recordRangeKeeperLiveManagementReview(db,reviewInput,{buildId:managerBuildId,verifyPinned:async()=>true});
  assert.equal(preview.status,'indicative',JSON.stringify(preview));
  assert.equal(preview.trustedPreviewSaved,true);const persisted=await readReview(db,{...walletIdentity,reviewId:preview.previewId});
  assert(persisted);const frozen=persisted.payload;
  assert.equal(frozen.buildId,managerBuildId,'The review binds to the build that previewed it');
  assert.equal(frozen.campaignBuildId,buildId,'The review records the build the campaign was opened under');
  assert.equal(persisted.buildId,managerBuildId);
  const requestId='retain-review-atomicity-1',requestDigest=contentHash({kind:'fixture_management_request',reviewId:preview.previewId});
  const jobInput={...walletIdentity,campaignId,revision:1,allocationId,reviewId:preview.previewId,kind:'close_retain',payload:frozen,
   buildId:managerBuildId,idempotencyKey:requestId,requestDigest};
  const counts=async()=>({campaigns:Number((await db.query("SELECT count(*) n FROM deployment_campaigns WHERE mode='live'")).rows[0].n),
   allocations:Number((await db.query('SELECT count(*) n FROM deployment_live_allocations')).rows[0].n),
   tokenRows:(await db.query('SELECT allocation_id,token_address,allocated_raw FROM deployment_live_allocation_tokens ORDER BY token_address')).rows,
   native:(await db.query('SELECT native_spend_wei,exit_reserve_wei FROM deployment_live_allocations WHERE id=$1',[allocationId])).rows[0]});
  const before=await counts();

  // Freshness failures are rejected before queue insertion or review consumption.
  const originalTimes=(await db.query('SELECT expires_at,created_at FROM deployment_live_reviews WHERE id=$1',[preview.previewId])).rows[0];
  await db.query("UPDATE deployment_live_reviews SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '2 seconds' WHERE id=$1",[preview.previewId]);
  await assert.rejects(queue.enqueue(jobInput),/expired/i);await db.query('UPDATE deployment_live_reviews SET expires_at=$2,created_at=$3 WHERE id=$1',[preview.previewId,originalTimes.expires_at,originalTimes.created_at]);
  await db.query('UPDATE deployment_live_wallets SET generation=generation+1 WHERE chain_id=4663 AND wallet=$1',[wallet]);
  await assert.rejects(queue.enqueue(jobInput),/wallet\/campaign state/i);
  await db.query('UPDATE deployment_live_wallets SET generation=2 WHERE chain_id=4663 AND wallet=$1',[wallet]);
  await db.query('UPDATE deployment_live_campaign_runtime SET state_hash=$2 WHERE campaign_id=$1',[campaignId,'1'.repeat(64)]);
  await assert.rejects(queue.enqueue(jobInput),/wallet\/campaign state/i);
  await db.query('UPDATE deployment_live_campaign_runtime SET state_hash=$2 WHERE campaign_id=$1',[campaignId,campaign.stateHash]);
  const originalPayloadHash=(await db.query('SELECT payload_hash FROM deployment_live_reviews WHERE id=$1',[preview.previewId])).rows[0].payload_hash;
  await db.query("UPDATE deployment_live_reviews SET payload_hash=$2 WHERE id=$1",[preview.previewId,'1'.repeat(64)]);
  await assert.rejects(queue.enqueue(jobInput),/review is missing, consumed, or stale/i);
  await db.query('UPDATE deployment_live_reviews SET payload_hash=$2 WHERE id=$1',[preview.previewId,originalPayloadHash]);
  assert.equal((await db.query('SELECT count(*) n FROM deployment_live_jobs WHERE kind IN(\'change_range\',\'close_retain\')')).rows[0].n,'0');
  assert.equal((await readReview(db,{...walletIdentity,reviewId:preview.previewId})).consumedByJob,null);

  const managementRequest={wallet:walletIdentity,campaignId,previewId:preview.previewId,contentDigest:preview.contentDigest,
   expectedRevision:preview.expectedRevision,idempotencyKey:requestId};
  const managementAdmissionDeps={pool:db,buildId:managerBuildId,verifyPinned:async()=>true,enqueue:job=>queue.enqueue(job)};
  // A preview made by one build is never admitted by another (not the open build, not a third build), nor queued with another build id.
  for(const other of [buildId,otherBuildId]){
   const wrongBuild=await admitRangeKeeperLiveManagement(managementRequest,{...managementAdmissionDeps,buildId:other});
   assert.equal(wrongBuild.status,'unavailable',JSON.stringify(wrongBuild));
   assert(wrongBuild.missing.some(m=>/Runtime build changed after management preview/.test(m)),JSON.stringify(wrongBuild));
   await assert.rejects(queue.enqueue({...jobInput,buildId:other}),/no longer matches|missing, consumed, or stale/i);
  }
  assert.equal((await readReview(db,{...walletIdentity,reviewId:preview.previewId})).consumedByJob,null);
  await mutateRevision(db,'state_schema_version=2');
  const incompatibleAdmission=await admitRangeKeeperLiveManagement(managementRequest,managementAdmissionDeps);
  assert.equal(incompatibleAdmission.status,'unavailable');
  assert(incompatibleAdmission.missing.some(m=>m.startsWith('rangekeeper_live_campaign_build_incompatible')),JSON.stringify(incompatibleAdmission));
  await mutateRevision(db,'state_schema_version=1');
  const accepted=await admitRangeKeeperLiveManagement(managementRequest,managementAdmissionDeps);
  assert.equal(accepted.status,'queued',JSON.stringify(accepted));assert.equal(accepted.replayed,false);
  assert.equal(accepted.allocationId,allocationId);assert.equal(accepted.campaignId,campaignId);
  assert.equal((await db.query('SELECT build_id FROM deployment_live_jobs WHERE id=$1',[accepted.jobId])).rows[0].build_id,managerBuildId,
   'The queued management job carries the managing build');
  assert.equal((await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId})).state.buildId,buildId,
   'Management leaves the campaign open-build provenance untouched');
  const after=await counts();assert.equal(after.campaigns,before.campaigns,'Management must not create another campaign');
  assert.equal(after.allocations,before.allocations,'Management must not create another allocation');
  assert.deepEqual(after.tokenRows,before.tokenRows,'Management must not reserve or borrow liquid wallet capital');
  assert.deepEqual(after.native,before.native,'Management must not borrow native from free or sibling capital');
  assert.equal((await readReview(db,{...walletIdentity,reviewId:preview.previewId})).consumedByJob,accepted.jobId);
  assert.equal(Number((await db.query('SELECT source_generation FROM deployment_live_allocations WHERE id=$1',[allocationId])).rows[0].source_generation),1,
   'A valid campaign allocation may retain an older sourceGeneration than the global wallet after sibling activity');

  // The idle snapshot runtime must refuse a fresh source write while the newly
  // accepted management job owns the shared wallet queue.
  const beforeBusyGeneration=(await readWalletState(db,walletIdentity)).generation;
  const snapshotRuntime=createRangeKeeperLiveReviewRuntime({pool:db,wallet:walletIdentity,buildId,requireIdleQueue:true,
   observeWallet:async()=>({snapshot:{...walletIdentity,source,nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
    tokens:[{address:token0,balanceRaw:'1000'},{address:token1,balanceRaw:'1000'}],commitmentsHash,status:'available'},
    complete:true,missing:[],nft:{positionManager:manager,completeEvidence:{},positions:[],retiredEmptyTokenIds:[]}}),
   verifyCanonical:async()=>{}});
  const busyRefresh=await snapshotRuntime.refreshSnapshot();assert.equal(busyRefresh.status,'unavailable');
  assert(busyRefresh.missing.includes('persisted_live_queue_has_priority'));
  assert.equal((await readWalletState(db,walletIdentity)).generation,beforeBusyGeneration,'Busy queue must not refresh wallet generation');

  // Live time-in-range accrual (left-Riemann on the previous snapshot, oversized gaps dropped) and the
  // campaign-row range_state mirror, written in the mark transaction and only on change.
  {
   const rangeState=async()=>(await db.query('SELECT range_state,updated_at FROM deployment_campaigns WHERE id=$1',[campaignId])).rows[0];
   const secs=async()=>{const c=await readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId});return {a:c.state.activeSeconds,o:c.state.outsideSeconds,c};};
   // Policy events advance the runtime source beyond state.last, so start after both and prime with an in-range mark.
   const rt=(await db.query('SELECT source_block,source_timestamp FROM deployment_live_campaign_runtime WHERE campaign_id=$1',[campaignId])).rows[0];
   let t=Math.max(Number(rt.source_timestamp),(await secs()).c.state.last.source.timestamp),blk=BigInt(rt.source_block);
   const mark=async(dt,tick,pos=position)=>{
    t+=dt;blk+=1n;const before=await secs();
    const snap={...snapshot,source:{block:blk,hash:hash(String(Number(blk%10n))),timestamp:t},tick,position:pos};
    const c=await db.connect();let r;try{r=await recordRangeKeeperLiveValuationMarkInTransaction(c,{wallet:walletIdentity,campaignId,revision:1,snapshot:snap,references:null});}finally{c.release();}
    assert.equal(r.replayed,false);const after=await secs();
    assert.equal(after.c.state.lastMarkTimestamp,t);
    return {da:after.a-before.a,do:after.o-before.o};
   };
   await mark(1,0);
   assert.deepEqual(await mark(30,0),{da:30,do:0},'prev in range: gap is in-range time');
   assert.equal((await rangeState()).range_state,'inside');
   assert.deepEqual(await mark(20,100),{da:20,do:0},'gap belongs to the previous (in-range) tick');
   assert.equal((await rangeState()).range_state,'outside');
   assert.deepEqual(await mark(30,100),{da:0,do:30},'prev out of range: gap is outside time');
   const stamp=(await rangeState()).updated_at.toISOString();
   assert.deepEqual(await mark(5,101),{da:0,do:5});
   assert.equal((await rangeState()).updated_at.toISOString(),stamp,'unchanged range_state must not rewrite the campaign row');
   assert.deepEqual(await mark(200,0),{da:0,do:0},'gap above maxObservationGapSeconds is not attributed');
   assert.equal((await rangeState()).range_state,'inside');
   assert.deepEqual(await mark(10,0,null),{da:10,do:0},'last snapshot had liquidity; gap counts');
   assert.equal((await rangeState()).range_state,'no_liquidity');
   assert.deepEqual(await mark(10,0,null),{da:0,do:0},'no active position: nothing accrues');
  }

  // Complete/release this synthetic job and allocation, then replay the exact
  // idempotency request. Lookup must happen before stale review/allocation checks.
  await db.query("UPDATE deployment_live_jobs SET status='succeeded',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[accepted.jobId]);
  await db.query("UPDATE deployment_live_nft_custody SET status='retired_empty',liquidity=0,tokens_owed0=0,tokens_owed1=0 WHERE allocation_id=$1",[allocationId]);
  await db.query("UPDATE deployment_campaigns SET lifecycle='closed',closed_at=clock_timestamp() WHERE id=$1",[campaignId]);
  await db.query("UPDATE deployment_live_campaign_runtime SET status='closed',closed_at=clock_timestamp() WHERE campaign_id=$1",[campaignId]);
  await releaseLiveWalletAllocation(db,{...walletIdentity,allocationId});
  const exactReplay=await admitRangeKeeperLiveManagement(managementRequest,managementAdmissionDeps);
  assert.equal(exactReplay.status,'queued');assert.equal(exactReplay.jobId,accepted.jobId);assert.equal(exactReplay.replayed,true);
  assert.deepEqual(Object.keys(exactReplay).sort(),Object.keys(accepted).sort(),'Fresh and replay admission responses expose the same public fields');
  assert.equal('requestDigest' in exactReplay,false,'Internal request digest must not leak on exact replay');
  const conflict=await admitRangeKeeperLiveManagement({...managementRequest,contentDigest:'9'.repeat(64)},managementAdmissionDeps);
  assert.equal(conflict.status,'request_conflict',JSON.stringify(conflict));
  assert.equal((await db.query('SELECT count(*) n FROM deployment_live_jobs WHERE kind=\'close_retain\'')).rows[0].n,'1',
   'Exact retry after closure/release returns the original job and never creates a second job');
  console.log('RangeKeeper live management isolated PostgreSQL integration passed');
 }finally{await db.end();}
}finally{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await root.end();}
