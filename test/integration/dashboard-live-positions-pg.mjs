// Isolated PostgreSQL check of the shared Positions projection for live RangeKeeper work: real v12-v14
// schema, real admission rows, then queue and stage-outbox states written the way the worker writes them.
// No worker, signer, RPC or production database is involved; TEST_DATABASE_URL must name a disposable database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {contentHash} from '../../src/deployments/contracts.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {createRangeKeeperLiveReviewStoreAdapter,recordRangeKeeperLiveSetupReview,admitRangeKeeperLiveSetup} from
 '../../src/deployments/rangekeeper-live-review-admission.ts';
import {readCommitments,recordWalletSnapshot} from '../../src/deployments/live-wallet-store.ts';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from '../../src/strategy/rangekeeper/config.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {rangeKeeperLiveSetupPreflightInput} from '../../src/deployments/rangekeeper-live-setup-preflight.ts';
import {readDeploymentRows,deploymentPosition,readLiveActivity} from '../../src/dashboard/deployment-position.ts';
import {migrateDatabase} from '../../src/storage/migrations.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL must name an isolated test database');
const root=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await root.connect();
const schema='rk_live_positions_'+randomUUID().replaceAll('-','');
const wallet='0x0000000000000000000000000000000000000900';
const shared='0x00000000000000000000000000000000000001f4';
const buildId='b'.repeat(64),now=Date.now();
const source={block:'78211393',hash:'0x'+'a'.repeat(64),timestamp:Math.floor(now/1000)};
const addr=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const h=c=>'0x'+c.repeat(64);
const limits={maxDeploymentValue:'1000000000000000000',minDeploymentValue:'1',minDeploymentPpm:1,
 maxSwapInputValue:'1000000000000000000',maxSwapInputPpm:1000000,maxSwapShortfallValue:'1000',maxSlippageBps:50,
 maxActionCost:'1000',maxRollingCost:'1000',maxCampaignCost:'1000',maxExposurePpm:1000000,maxLossValue:'1000',
 maxDrawdownPpm:1000000,maxRecenters:2,maxLiquiditySharePpm:1000000,maxObservationGapSeconds:90,exitReserveWei:'1'};
const {minDeploymentValue:_minimumDeploymentValue,...kernelLimits}=limits;
const feeProfiles=[['AAPL',500],['NVDA',3000],['GOOGL',500]];
const profiles=feeProfiles.map(([symbol,fee],index)=>{
 const riskyToken=addr(({AAPL:600,NVDA:700,GOOGL:200,SPY:300,QQQ:800,MSFT:900})[symbol]);
 const quoteAt0=!['GOOGL','SPY'].includes(symbol);
 const token0=quoteAt0?shared:riskyToken,token1=quoteAt0?riskyToken:shared;
 const poolProfile=marketProfileSchema.parse({pool:{chainId:4663,factory:addr(300),pool:addr(100+index),
  token0,token1,quoteToken:quoteAt0?0:1,
  decimals0:quoteAt0?6:18,decimals1:quoteAt0?18:6,fee,tickSpacing:fee===500?10:fee===3000?60:200,
  positionManager:addr(500),router:addr(600),quoter:addr(700),poolCodeHash:h('1'),token0CodeHash:h('2'),
  token1CodeHash:h('3'),managerCodeHash:h('4'),quoterCodeHash:h('5'),reference0:quoteAt0?'USDG/USD':`${symbol}/USD`,
  reference1:quoteAt0?`${symbol}/USD`:'USDG/USD',nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
  token0:{kind:quoteAt0?'stablecoin':'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:quoteAt0?'stock_token':'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
 return {id:`${String(index+1).padStart(8,'0')}-1111-4111-8111-${String(index+1).padStart(12,'0')}`,
  profile:poolProfile,hash:contentHash(poolProfile)};
});

function makePayload(profileRow,commitments,allocated,nativeAllocated){
 const p=profileRow.profile,pool=p.pool,token0=pool.token0,token1=pool.token1;
 const balance='10000',t0Allocated=String(allocated.get(token0.toLowerCase())??0n),t1Allocated=String(allocated.get(token1.toLowerCase())??0n);
 const requirements={token0Raw:'100',token1Raw:'100',nativeWei:'2',strategyAllocationValueUsdX18:'1000000000000000000'};
 const costs={status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',feasibility:'owned_fork_success',
  scope:'entry_action_only_exit_gas_reserve_only',actionCostScope:'entry_action_only',exitEconomics:'unavailable',
  syntheticNativeFunding:true,actionGasWei:'1',actionCostValue:'1',completeExitGasWei:'1',exitReserveWei:'1'};
 const references={price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'2000000000000000000000',proofHash:'d'.repeat(64)};
 const params={fullWidthSpacings:120,limits};
 const kernel=parseRangeKeeperConfig({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',broadcastEnabled:false,
  operator:wallet,pool,limits:{...kernelLimits,fullWidthSpacings:120},signer:null,walletCode:{kind:'eoa'},zeroAllowances:[],
  legacyRetiredTokenIds:[],campaignScope:{maxDurationSeconds:43200,maxEconomicActions:2},referencePolicy:p.referencePolicy,
  campaignValue:'1000000000000000002',strategyFundingValue:'1000000000000000000',nativeFundingValue:'2'});
 const config=JSON.parse(JSON.stringify(kernel,(_,v)=>typeof v==='bigint'?String(v):v));
 const configHash=rangeKeeperConfigHash(kernel).slice(2);
 const candidate={kind:'open',expiresAt:Math.floor(Date.now()/1000)+60,amount0Desired:'100',amount1Desired:'100'};
 const profileId=profileRow.id,profileHash=profileRow.hash;
 const payload={schemaVersion:1,kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',status:'indicative',
  profileId,profileHash,input:{capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits},
  profile:{pool:pool.pool,fee:pool.fee,tickSpacing:pool.tickSpacing,token0,token1,quoteToken:pool.quoteToken,
   decimals0:pool.decimals0,decimals1:pool.decimals1},source,
  wallet:{id:'operator-1',address:wallet,source,nonce:'5',nftTokenIds:[],commitmentsHash:commitments,
   token0:{balanceRaw:balance,allocatedRaw:t0Allocated,pendingRaw:'0',freeRaw:String(BigInt(balance)-BigInt(t0Allocated))},
   token1:{balanceRaw:balance,allocatedRaw:t1Allocated,pendingRaw:'0',freeRaw:String(BigInt(balance)-BigInt(t1Allocated))},
   native:{balanceWei:'100000',allocatedWei:String(nativeAllocated),pendingWei:'0',exitReserveWei:String(nativeAllocated),
    freeWei:String(100000n-nativeAllocated*2n)}},
  requirements,range:{tickLower:-600,tickUpper:600,centerTick:0,fullWidthSpacings:120},candidate,references,
  policy:{config,configHash,parameters:params,parametersHash:contentHash(params),broadcastEnabled:false,signer:null},costs,
  binding:{buildId,walletId:'operator-1',walletAddress:wallet,profileHash,configHash,source,referenceProofHash:references.proofHash,
   commitmentsHash:commitments,candidateHash:'f'.repeat(64),simulationAllocationHash:'1'.repeat(64),
   finalAllocationHash:contentHash({token0Raw:requirements.token0Raw,token1Raw:requirements.token1Raw,nativeWei:requirements.nativeWei}),
   requirementsHash:contentHash(requirements),limitsHash:'2'.repeat(64),costsHash:contentHash(costs),sequenceHash:'3'.repeat(64)},
  missing:[],reason:'rangekeeper_live_execution_unavailable',actionAvailable:false,draftCreationAvailable:false,
  operationAcceptanceAvailable:false,executionEligible:false};
 payload.binding.reviewHash=contentHash(payload.binding);return payload;
}

try{
 await admin.query('CREATE SCHEMA '+schema);await admin.query('SET search_path='+schema);await migrateDatabase(admin);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 const db=new pg.Pool({connectionString:url.toString(),max:4});
 try{
  const allTokens=[...new Set([shared,...profiles.map(x=>x.profile.pool.token0),...profiles.map(x=>x.profile.pool.token1)]
   .map(address=>address.toLowerCase()))];
  for(const row of profiles){const p=row.profile.pool;
   await db.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,
    token0_decimals,token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
    VALUES($1,4663,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11,clock_timestamp())`,
    [row.id,p.pool,p.token0,p.token1,p.decimals0,p.decimals1,p.quoteToken,p.fee,p.tickSpacing,row.profile,row.hash]);}
  const empty=liveWalletCommitmentFingerprint({wallet:{chainId:4663,address:wallet},allocations:[],nftCustody:[]});
  await recordWalletSnapshot(db,{chainId:4663,address:wallet,source,nonce:'5',pendingNonce:'5',nativeBalanceWei:'100000',
   tokens:allTokens.map(address=>({address,balanceRaw:'10000'})),commitmentsHash:empty});
  const store=createRangeKeeperLiveReviewStoreAdapter(db,wallet),allocated=new Map();let nativeAllocated=0n;
  const accepted=[];
  for(const row of profiles){
   const state=await store.readWalletState(wallet);assert.equal(state.status,'available');
   const commits=await readCommitments(db,{chainId:4663,address:wallet});
   assert.equal(state.commitmentsHash,liveWalletCommitmentFingerprint(commits));
   const payload=makePayload(row,state.commitmentsHash,allocated,nativeAllocated),reviewId=randomUUID();
   rangeKeeperLiveSetupPreflightInput.parse({profileId:row.id,capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits});
   const reviewed=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload},store);
   assert.equal(reviewed.status,'review_recorded',`profile ${row.id}: ${JSON.stringify(reviewed)}`);
   const result=await admitRangeKeeperLiveSetup({reviewId,reviewHash:reviewed.reviewHash,requestId:randomUUID()},
    {...store,wallet,buildId,now:()=>Date.now(),revalidatePinned:async frozen=>frozen,verifyCanonical:async()=>{}});
   assert.equal(result.status,'queued',JSON.stringify(result));accepted.push({row,result});
   allocated.set(row.profile.pool.token0.toLowerCase(),(allocated.get(row.profile.pool.token0.toLowerCase())??0n)+100n);
   allocated.set(row.profile.pool.token1.toLowerCase(),(allocated.get(row.profile.pool.token1.toLowerCase())??0n)+100n);
   nativeAllocated+=2n;
  }
  const [a,b,c]=accepted.map(item=>item.result);
  const dashboard=await db.connect();
  try{
   const project=async()=>new Map((await readDeploymentRows(dashboard)).map(row=>[row.id,deploymentPosition(row)]));

   // 1. Three accepted campaigns are three queued rows from first acceptance, with no invented economics.
   let positions=await project();
   assert.equal(positions.size,3);
   for(const {campaignId,jobId} of [a,b,c]){
    const p=positions.get(campaignId);assert(p,'accepted campaign is projected');
    assert.equal(p.mode,'live');assert.equal(p.status,'waiting');assert.equal(p.deployment.live.lifecycle,'queued');
    assert.equal(p.deployment.live.job.id,jobId);assert.equal(p.deployment.live.job.kind,'open');
    assert.equal(p.deployment.live.job.status,'queued');assert.equal(p.deployment.live.job.nonce,null);
    assert.equal(p.navQuote,null);assert.equal(p.feesQuote,null);assert.equal(p.gasQuote,null);assert.equal(p.history,false);
    assert.deepEqual(p.deployment.live.allocation,{token0Raw:'100',token1Raw:'100',nativeWei:'2'});
   }

   // 2. An automatic recenter in flight: the newest stage by numeric nonce wins a created_at tie (1000 beats 999).
   const tie=new Date(Date.now()-5000);
   await db.query(`UPDATE deployment_campaigns SET lifecycle='active' WHERE id=$1`,[a.campaignId]);
   await db.query(`UPDATE deployment_live_jobs SET kind='change_range',status='executing',resume_stage=$2 WHERE id=$1`,[a.jobId,'withdraw:bb']);
   const outbox=(stage,nonce,status,rawHash,receipt)=>db.query(`INSERT INTO deployment_live_stage_outbox(job_id,stage,chain_id,wallet,
    intent_json,plan_json,before_json,nonce,status,signed_raw,signed_raw_hash,canonical_receipt_json,created_at,updated_at)
    VALUES($1,$2,4663,$3,'{}','{}','{}',$4,$5,$6,$7,$8,$9,$9)`,[a.jobId,stage,wallet,nonce,status,
     rawHash?'0x'+'01'.repeat(8):null,rawHash,receipt?JSON.stringify({status:'success'}):null,tie]);
   await outbox('approve:aa','999','confirmed',h('1'),true);
   await outbox('withdraw:bb','1000','signed',h('3'),false);
   positions=await project();
   let live=positions.get(a.campaignId).deployment.live;
   assert.equal(live.lifecycle,'recentering');assert.equal(positions.get(a.campaignId).status,'recentring');
   assert.equal(live.job.kind,'change_range');assert.equal(live.job.status,'executing');assert.equal(live.job.inFlight,true);
   assert.equal(live.job.nonce,'1000','nonce 1000 sorts after 999 numerically, not as text');
   assert.equal(live.job.txHash,h('3'));assert.equal(live.job.stageKind,'withdraw');assert.equal(live.job.stageStatus,'signed');
   assert.equal(positions.get(b.campaignId).deployment.live.lifecycle,'queued','other campaigns are unaffected');

   // 3. The same job blocks: the row carries a human-mappable reason, not a healthy state.
   await db.query(`UPDATE deployment_live_stage_outbox SET status='blocked' WHERE job_id=$1 AND stage='withdraw:bb'`,[a.jobId]);
   await db.query(`UPDATE deployment_live_jobs SET status='blocked',completed_at=clock_timestamp() WHERE id=$1`,[a.jobId]);
   positions=await project();
   live=positions.get(a.campaignId).deployment.live;
   assert.equal(positions.get(a.campaignId).status,'blocked');assert.equal(live.lifecycle,'blocked');
   assert.equal(live.blockedReason,'job_blocked:withdraw');assert.equal(live.job.status,'blocked');
   assert.equal(positions.get(a.campaignId).deployment.operation.reason,'job_blocked:withdraw');

   // 4. A closed campaign is a History row.
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',closed_at=clock_timestamp() WHERE id=$1`,[c.campaignId]);
   await db.query(`UPDATE deployment_live_jobs SET kind='close_retain',status='succeeded',completed_at=clock_timestamp() WHERE id=$1`,[c.jobId]);
   positions=await project();
   const closed=positions.get(c.campaignId);
   assert.equal(closed.history,true);assert.equal(closed.status,'closed');assert.equal(closed.deployment.live.lifecycle,'closed');
   assert.equal(closed.deployment.live.job.kind,'close_retain');assert.equal(closed.nextAction,null);
   assert.doesNotThrow(()=>JSON.stringify([...positions.values()]));

   // 5. Activity history orders stages numerically and exposes nonce and hash text.
   const activity=await readLiveActivity(dashboard,a.campaignId,new Date(0));
   assert.deepEqual(activity.events.filter(event=>event.kind==='stage').map(event=>event.nonce),['1000','999']);
   assert.equal(activity.events.find(event=>event.nonce==='1000').hash,h('3'));
   assert.equal(activity.events.filter(event=>event.kind==='job').length,1);
   assert.equal(activity.recenterAttempts,1);

   // 6. A database without the v12-v14 live tables (production is still v11) projects the campaigns with no live
   // queue columns and no error.
   const tables=(await db.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'deployment_live_%'`,[schema])).rows;
   assert(tables.length>0);
   await db.query(`DROP TABLE ${tables.map(row=>'"'+row.tablename+'"').join(',')} CASCADE`);
   const v11=await project();
   assert.equal(v11.size,3,'live campaign rows survive the missing queue tables');
   for(const position of v11.values()){
    assert.equal(position.deployment.live.job,null);assert.equal(position.deployment.live.runtimeVerified,false);
    assert.equal(position.navQuote,null);
   }
   assert.deepEqual(await readLiveActivity(dashboard,a.campaignId,new Date(0)),{events:[],recenterAttempts:0,swaps:0});
   console.log('Dashboard live positions isolated PG projection passed (queued x3, change_range 999/1000 nonce order, blocked, closed History, v11 without live tables)');
  }finally{dashboard.release();}
 }finally{await db.end();}
}finally{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');admin.release();await root.end();}
