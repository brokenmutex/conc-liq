import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {privateKeyToAccount} from 'viem/accounts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {createRangeKeeperLiveReviewStoreAdapter,recordRangeKeeperLiveSetupReview,admitRangeKeeperLiveSetup} from
 '../../src/deployments/rangekeeper-live-review-admission.ts';
import {readCommitments,recordWalletSnapshot} from '../../src/deployments/live-wallet-store.ts';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from '../../src/strategy/rangekeeper/config.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {LiveWalletQueue} from '../../src/deployments/live-wallet-queue.ts';
import {createRangeKeeperLiveWalletWorker} from '../../src/deployments/rangekeeper-live-wallet-worker.ts';
import {createRangeKeeperLivePreparedIntentVerifier} from '../../src/deployments/rangekeeper-live-references.ts';
import {encodeRangeKeeperTx} from '../../src/strategy/rangekeeper/calldata.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL must name an isolated test database');
const root=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await root.connect();
const schema='rk_live_review_'+randomUUID().replaceAll('-',''),signer=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),wallet=signer.address.toLowerCase();
const token0='0x1000000000000000000000000000000000000001',token1='0x2000000000000000000000000000000000000002';
const profileId=randomUUID(),buildId='b'.repeat(64),now=Date.now();
const source={block:'78211393',hash:'0x'+'a'.repeat(64),timestamp:Math.floor(now/1000)};
const h=(c)=>'0x'+c.repeat(64);
const submittedLimits={maxDeploymentValue:'1000000000000000000',minDeploymentValue:'1',minDeploymentPpm:1,
 maxSwapInputValue:'1000000000000000000',maxSwapInputPpm:1000000,maxSwapShortfallValue:'1000',maxSlippageBps:50,
 maxActionCost:'1000',maxRollingCost:'1000',maxCampaignCost:'1000',maxExposurePpm:1000000,maxLossValue:'1000',
 maxDrawdownPpm:1000000,maxRecenters:2,maxLiquiditySharePpm:1000000,maxObservationGapSeconds:90,exitReserveWei:'1000'};
const {minDeploymentValue:_minimumDeploymentValue,...kernelLimits}=submittedLimits;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:'0x3000000000000000000000000000000000000003',
 pool:'0x4000000000000000000000000000000000000004',token0,token1,quoteToken:0,decimals0:6,decimals1:6,
 fee:500,tickSpacing:10,positionManager:'0x5000000000000000000000000000000000000005',
 router:'0x6000000000000000000000000000000000000006',quoter:'0x7000000000000000000000000000000000000007',
 poolCodeHash:h('1'),token0CodeHash:h('2'),token1CodeHash:h('3'),managerCodeHash:h('4'),quoterCodeHash:h('5'),
 reference0:'T0/USD',reference1:'T1/USD',nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
const profileHash=contentHash(profile);
const kernel=parseRangeKeeperConfig({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',broadcastEnabled:false,
 operator:wallet,pool:profile.pool,limits:{...kernelLimits,fullWidthSpacings:120},signer:null,walletCode:{kind:'eoa'},
 zeroAllowances:[],legacyRetiredTokenIds:[],campaignScope:{maxDurationSeconds:43200,maxEconomicActions:2},
 referencePolicy:profile.referencePolicy,campaignValue:'1000000000000001000',
 strategyFundingValue:'1000000000000000000',nativeFundingValue:'1000'});
const configHash=rangeKeeperConfigHash(kernel).slice(2),config=JSON.parse(JSON.stringify(kernel,(_,v)=>typeof v==='bigint'?String(v):v));

function reviewPayload(commitmentsHash){
 const requirements={token0Raw:'100',token1Raw:'100',nativeWei:'2000',quoteValueRaw:'100',freeQuoteRaw:'1000',
  shortfallQuoteRaw:'0',budgetResidualQuoteRaw:'0',strategyAllocationValueUsdX18:'1000000000000000000',
  freeToken0Raw:'900',freeToken1Raw:'900'};
 const costs={status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',feasibility:'owned_fork_success',
  scope:'entry_action_only_exit_gas_reserve_only',actionCostScope:'entry_action_only',exitEconomics:'unavailable',
  syntheticNativeFunding:true,actionGasWei:'1000',actionCostValue:'1',completeExitGasWei:'1000',exitReserveWei:'1000'};
 const references={price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'2000000000000000000000',proofHash:'d'.repeat(64)};
 const policy={config,configHash,parameters:{fullWidthSpacings:120,limits:submittedLimits},
  parametersHash:contentHash({fullWidthSpacings:120,limits:submittedLimits}),broadcastEnabled:false,signer:null};
 const candidate={kind:'open',expiresAt:Math.floor(Date.now()/1000)+60,amount0Desired:'100',amount1Desired:'100'};
 const payload={schemaVersion:1,kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',status:'indicative',
  profileId,profileHash,input:{capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits:submittedLimits},
  profile:{pool:profile.pool.pool,fee:profile.pool.fee,tickSpacing:profile.pool.tickSpacing,token0,token1,quoteToken:0,decimals0:6,decimals1:6},
  source,wallet:{id:'operator-1',address:wallet,source,nonce:'5',nftTokenIds:[],commitmentsHash,
   token0:{balanceRaw:'1000',allocatedRaw:'0',pendingRaw:'0',freeRaw:'1000'},
   token1:{balanceRaw:'1000',allocatedRaw:'0',pendingRaw:'0',freeRaw:'1000'},
   native:{balanceWei:'100000',allocatedWei:'0',pendingWei:'0',exitReserveWei:'0',freeWei:'100000'}},
  requirements,range:{tickLower:-600,tickUpper:600,centerTick:0,fullWidthSpacings:120},candidate,references,policy,costs,
  binding:{buildId,walletId:'operator-1',walletAddress:wallet,profileHash,configHash,source,
   referenceProofHash:references.proofHash,commitmentsHash,candidateHash:'f'.repeat(64),simulationAllocationHash:'1'.repeat(64),
   finalAllocationHash:contentHash({token0Raw:'100',token1Raw:'100',nativeWei:'2000'}),requirementsHash:contentHash(requirements),
   limitsHash:'2'.repeat(64),costsHash:contentHash(costs),sequenceHash:'3'.repeat(64)},missing:[],
  reason:'rangekeeper_live_execution_unavailable',actionAvailable:false,draftCreationAvailable:false,
  operationAcceptanceAvailable:false,executionEligible:false};
 payload.binding.reviewHash=contentHash(payload.binding);return payload;
}

try{
 await admin.query('CREATE SCHEMA '+schema);await admin.query('SET search_path='+schema);await migrateDatabase(admin);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 const db=new pg.Pool({connectionString:url.toString(),max:5});
 try{
  await db.query('INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at) VALUES($1,4663,$2,$3,$4,6,6,0,500,10,$5,$6,$7,clock_timestamp())',
   [profileId,profile.pool.pool,token0,token1,profile,{},profileHash]);
  const empty=liveWalletCommitmentFingerprint({wallet:{chainId:4663,address:wallet},allocations:[],nftCustody:[]});
  await recordWalletSnapshot(db,{chainId:4663,address:wallet,source,nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
   tokens:[{address:token0,balanceRaw:'1000'},{address:token1,balanceRaw:'1000'}],commitmentsHash:empty});
  const store=createRangeKeeperLiveReviewStoreAdapter(db,wallet),payload=reviewPayload(empty),reviewId=randomUUID();
  const recorded=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload},store);
  assert.equal(recorded.status,'review_recorded',JSON.stringify(recorded));
  const requestId=randomUUID(),admissionDeps={...store,wallet,buildId,now:()=>Date.now(),
   revalidatePinned:async frozen=>frozen,verifyCanonical:async pinned=>{
    assert.deepEqual(pinned,source);
   }};
  const accepted=await admitRangeKeeperLiveSetup({reviewId,reviewHash:recorded.reviewHash,requestId},admissionDeps);
  assert.equal(accepted.status,'queued',JSON.stringify(accepted));
  const replay=await admitRangeKeeperLiveSetup({reviewId,reviewHash:recorded.reviewHash,requestId},admissionDeps);
  assert.equal(replay.status,'queued');if(replay.status==='queued')assert.equal(replay.replayed,true);
  const rows=await db.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[accepted.campaignId]);
  assert.equal(rows.rows[0]?.lifecycle,'opening');
  const current=await store.readWalletState(wallet),failedPayload=reviewPayload(current.commitmentsHash),failedReviewId=randomUUID();
  failedPayload.wallet.token0.allocatedRaw='100';failedPayload.wallet.token0.freeRaw='900';
  failedPayload.wallet.token1.allocatedRaw='100';failedPayload.wallet.token1.freeRaw='900';
  failedPayload.wallet.native.allocatedWei='1000';failedPayload.wallet.native.exitReserveWei='1000';
  failedPayload.wallet.native.freeWei='98000';
  failedPayload.requirements.freeToken0Raw='800';failedPayload.requirements.freeToken1Raw='800';
  failedPayload.binding.commitmentsHash=current.commitmentsHash;
  failedPayload.binding.requirementsHash=contentHash(failedPayload.requirements);
  failedPayload.binding.reviewHash=contentHash(Object.fromEntries(Object.entries(failedPayload.binding).filter(([key])=>key!=='reviewHash')));
  const failedReview=await recordRangeKeeperLiveSetupReview({wallet,reviewId:failedReviewId,payload:failedPayload},store);
  assert.equal(failedReview.status,'review_recorded');
  const rejected=await admitRangeKeeperLiveSetup({reviewId:failedReviewId,reviewHash:failedReview.reviewHash,
   requestId:randomUUID()},{...admissionDeps,verifyCanonical:async()=>{throw Error('source changed');}});
  assert.equal(rejected.status,'unavailable');
  const afterFailure=await db.query('SELECT count(*)::int AS count FROM deployment_campaigns WHERE mode=\'live\'');
  assert.equal(afterFailure.rows[0].count,1,'canonical verifier failure must roll back campaign/allocation/job insertion');
  // Bridge the real admission store to the queue using a fixture-only strategy
  // authorizer. This verifies persistence; it provides no execution qualification.
  const wholeWallet={operator:wallet,source:{...source,block:BigInt(source.block)},nonce:5,pendingNonce:5,nativeWei:100000n,
   tokens:{[token0]:1000n,[token1]:1000n},nftTokenIds:[],allowances:[]};
  const campaignAllocation={campaignId:accepted.campaignId,liquidByTokenAddress:{[token0]:100n,[token1]:100n},
   nativeSpendWei:1000n,exitReserveWei:1000n,nftTokenIds:[]};
  const poolSnapshot={source:wholeWallet.source,operator:wallet,wallet0:1000n,wallet1:1000n,nativeWei:100000n,
   nonce:5,nftCount:0n,tick:0,sqrtPriceX96:1n<<96n,unlocked:true,poolLiquidity:1n,allowances:[],position:null};
  const queue=new LiveWalletQueue(db,{
   authorizeStage:async(_client,{intent,plan,walletState})=>({intent,plan,pool:poolSnapshot,
    before:{walletGeneration:Number(walletState.generation),wallet:wholeWallet,allocation:campaignAllocation}}),
   reconcile:async()=>{throw Error('canonical execution adapter unavailable in this admission fixture');},
   verifyCleanup:async()=>{throw Error('canonical cleanup adapter unavailable in this admission fixture');},
  });
  const claimed=await queue.claimNext({chainId:4663,address:wallet});
  assert.equal(claimed.job.id,accepted.jobId);
  const plan={kind:'approve',token:0,spender:'positionManager',amount:1n};
  const call=encodeRangeKeeperTx(kernel.pool,wallet,plan);
  const intent={id:randomUUID(),chainId:4663,operator:wallet,action:'rangekeeper_open',nonce:5,
   to:call.to,data:call.data,value:'0',gas:'100000',maxFeePerGas:'2',maxPriorityFeePerGas:'0',
   sourceBlock:source.block,sourceHash:source.hash};
  const stage=await queue.prepareStage({chainId:4663,address:wallet},accepted.jobId,claimed.leaseToken,
   {stage:'approve-mint-token0',intent,plan});
  assert.equal(stage.status,'prepared');assert.equal(stage.plan.amount,1n);
  assert.equal(stage.before.wallet.nativeWei,100000n);
  const verifyPrepared=createRangeKeeperLivePreparedIntentVerifier({pool:db,client:{},wallet:{chainId:4663,address:wallet}});
  assert.equal(await verifyPrepared({job:claimed.job,outbox:stage}),false,
   'worker signer must fail closed when durable stage authorization evidence is missing');
  const stageReplay=await queue.prepareStage({chainId:4663,address:wallet},accepted.jobId,claimed.leaseToken,
   {stage:'approve-mint-token0',intent,plan});
  assert.equal(stageReplay.status,'prepared','identical typed stage must replay after JSONB persistence');
  assert.equal((await db.query('SELECT signed_raw FROM deployment_live_stage_outbox WHERE job_id=$1',
   [accepted.jobId])).rows[0].signed_raw,null,'this bridge fixture never signs or broadcasts');
  // Exercise the actual worker against PostgreSQL's leased queue and persisted
  // authorized stage. Signing is a test fixture only; publisher remains gated.
  await db.query("UPDATE deployment_live_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[accepted.jobId]);
  const worker=createRangeKeeperLiveWalletWorker({queue,wallet:{chainId:4663,address:wallet},options:{signerEnabled:true},adapters:{
   recoverFinishedOpenings:async()=>{},initializeOpeningCampaign:async()=>{},verifyPreparedIntent:async()=>true,
   nextStage:async()=>({kind:'complete'}),advanceCampaignEffect:async()=>{},completeOpeningLifecycle:async()=>{},
   signIntent:async authorized=>signer.signTransaction({type:'eip1559',chainId:4663,nonce:authorized.nonce,
    to:authorized.to,data:authorized.data,value:0n,gas:BigInt(authorized.gas),maxFeePerGas:BigInt(authorized.maxFeePerGas),
    maxPriorityFeePerGas:BigInt(authorized.maxPriorityFeePerGas)}),
   publishRaw:async()=>{throw Error('publisher must stay gated');},waitForCanonicalReceipt:async()=>{},
  }});
  const workerResult=await worker.execute();assert.equal(workerResult.status,'disabled',JSON.stringify(workerResult));
  if(workerResult.status==='disabled')assert.equal(workerResult.reason,'publisher_disabled');
  const recovered=await queue.readPersistedRaw({chainId:4663,address:wallet},accepted.jobId,'approve-mint-token0');
  assert(recovered?.raw&&recovered.hash,'worker must persist only the exact signed authorized stage');
  assert.equal((await db.query('SELECT status FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2',
   [accepted.jobId,'approve-mint-token0'])).rows[0].status,'signed');
  assert.equal((await db.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[accepted.campaignId])).rows[0].lifecycle,'opening',
   'signing without a canonical receipt cannot move the campaign to holding');
  console.log('RangeKeeper live review admission isolated PG integration passed');
 }finally{await db.end();}
}finally{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');admin.release();await root.end();}
