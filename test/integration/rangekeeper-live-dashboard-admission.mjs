// Isolated PostgreSQL + real command-server admission contract. This exercises
// HTTP session/CSRF and inert campaign/allocation/job persistence only: there
// is no worker, signer, publisher, or executable receipt adapter.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer as createHttpServer} from 'node:http';
import pg from 'pg';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {createRangeKeeperLiveReviewStoreAdapter,recordRangeKeeperLiveSetupReview,admitRangeKeeperLiveSetup} from
 '../../src/deployments/rangekeeper-live-review-admission.ts';
import {readCommitments,recordWalletSnapshot} from '../../src/deployments/live-wallet-store.ts';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from '../../src/strategy/rangekeeper/config.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {rangeKeeperLiveSetupPreflightInput} from '../../src/deployments/rangekeeper-live-setup-preflight.ts';
import {readDeploymentRows,deploymentPosition} from '../../src/dashboard/deployment-position.ts';
import {migrateDatabase} from '../../src/storage/migrations.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL must name an isolated test database');
const root=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await root.connect();
const schema='rk_live_http_admit_'+randomUUID().replaceAll('-','');
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
const feeProfiles=[['AAPL',500],['AAPL',3000],['AAPL',10000],['NVDA',500],['NVDA',3000],
 ['GOOGL',500],['GOOGL',3000],['SPY',500],['SPY',3000],['QQQ',500],['QQQ',3000],['MSFT',3000]];
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
 const db=new pg.Pool({connectionString:url.toString(),max:8});
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
  const byReview=new Map();let callbackCalls=0,ready=true;
  const commandStore={createDraft:async()=>{throw Error('unreachable');},acceptOperation:async()=>{throw Error('unreachable');},
   operation:async()=>null,listMarketProfiles:async()=>profiles.map(x=>({id:x.id,pool:x.profile.pool.pool,fee:x.profile.pool.fee}))};
  const probe=createHttpServer();probe.listen(0,'127.0.0.1');await new Promise(resolve=>probe.once('listening',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const server=createDeploymentCommandServer(commandStore,{origin,
   rangeKeeperLiveAdmissionReady:async()=>ready,
   rangeKeeperLiveSetupAdmission:async input=>{callbackCalls++;const custom=byReview.get(input.reviewId);
    return admitRangeKeeperLiveSetup(input,{...store,wallet,buildId,now:()=>Date.now(),
     revalidatePinned:async frozen=>frozen,verifyCanonical:async pinned=>{
      if(custom==='stale')throw Error('canonical source changed');assert.deepEqual(pinned,source);
     }});}});
  server.listen(port,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
   const sessionResponse=await fetch(`${origin}/api/session`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
   assert.equal(sessionResponse.status,200);const session=await sessionResponse.json();
   const cookie=sessionResponse.headers.get('set-cookie')?.split(';')[0];assert(cookie&&session.csrfToken);
   const post=(body,overrides={})=>fetch(`${origin}/api/deployments/rangekeeper/live-setup-admit`,{method:'POST',
    headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','x-csrf-token':session.csrfToken,...overrides},body:JSON.stringify(body)});
   const catalog=await fetch(`${origin}/api/strategies`,{headers:{Cookie:cookie}}).then(r=>r.json());
   const rk=catalog.strategies.find(x=>x.id==='rangekeeper_v1');assert.equal(rk.live,false);
   assert.equal(rk.liveAdmission,true,'test-only readiness reports admission surface; strategy execution remains disabled');
   assert.deepEqual(rk.liveWorker,{ready:true,missing:[]},'boolean readiness is reported as the worker state');
   const beforeBad=await db.query('SELECT count(*)::int AS n FROM deployment_live_jobs');
   assert.equal((await post({reviewId:randomUUID(),reviewHash:'x',requestId:randomUUID()},{'x-csrf-token':'0'.repeat(64)})).status,403);
   assert.equal((await post({reviewId:randomUUID(),reviewHash:'a'.repeat(64),requestId:randomUUID(),wallet})).status,400,
    'strict request contract excludes wallet/key/calldata overrides');
   assert.equal((await post({reviewId:randomUUID(),reviewHash:'a'.repeat(64),requestId:randomUUID()},{Origin:'http://127.0.0.1:1'})).status,403,
    'cross-origin admission is rejected before callback');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM deployment_live_jobs')).rows[0].n,beforeBad.rows[0].n);

   const accepted=[];
   for(const row of profiles){
    const state=await store.readWalletState(wallet);assert.equal(state.status,'available');
    const commits=await readCommitments(db,{chainId:4663,address:wallet});
    assert.equal(state.commitmentsHash,liveWalletCommitmentFingerprint(commits));
    const payload=makePayload(row,state.commitmentsHash,allocated,nativeAllocated),reviewId=randomUUID();
    rangeKeeperLiveSetupPreflightInput.parse({profileId:row.id,capitalQuoteRaw:'100000000',fullWidthSpacings:120,limits});
    const reviewed=await recordRangeKeeperLiveSetupReview({wallet,reviewId,payload},store);
    assert.equal(reviewed.status,'review_recorded',`profile ${row.id}: ${JSON.stringify(reviewed)}`);
    const requestId=randomUUID();byReview.set(reviewId,'valid');
    const response=await post({reviewId,reviewHash:reviewed.reviewHash,requestId});
    assert.equal(response.status,202,`profile ${row.id}: ${await response.clone().text()}`);
    const result=await response.json();assert.equal(result.status,'queued');assert.equal(result.executionEligible,false);
    accepted.push({row,result,reviewId,reviewHash:reviewed.reviewHash,requestId});
    allocated.set(row.profile.pool.token0.toLowerCase(),(allocated.get(row.profile.pool.token0.toLowerCase())??0n)+100n);
    allocated.set(row.profile.pool.token1.toLowerCase(),(allocated.get(row.profile.pool.token1.toLowerCase())??0n)+100n);
    nativeAllocated+=2n;
    if(accepted.length===1){
     const replay=await post({reviewId,reviewHash:reviewed.reviewHash,requestId});assert.equal(replay.status,200);
     const replayBody=await replay.json();assert.equal(replayBody.replayed,true);assert.equal(replayBody.campaignId,result.campaignId);
     assert.equal(replayBody.jobId,result.jobId);assert.equal(replayBody.allocationId,result.allocationId);
     const collision=await post({reviewId,reviewHash:'c'.repeat(64),requestId});assert.equal(collision.status,409,
      'same idempotency key with a different request digest conflicts');
    }
   }
   assert.equal(accepted.length,12,'each fee/spacing registry profile is accepted through its registered profile binding');
   const campaigns=await db.query(`SELECT c.market_profile_id,c.lifecycle,a.native_spend_wei,a.exit_reserve_wei,
    t.token_address,t.allocated_raw FROM deployment_campaigns c JOIN deployment_live_allocations a ON a.campaign_id=c.id
    JOIN deployment_live_allocation_tokens t ON t.allocation_id=a.id WHERE c.mode='live' ORDER BY c.market_profile_id,t.token_address`);
   assert.equal(campaigns.rowCount,24);assert(campaigns.rows.every(r=>r.lifecycle==='opening'));
   assert.equal(new Set(campaigns.rows.map(r=>r.market_profile_id)).size,12);
   const sharedAllocated=campaigns.rows.filter(r=>r.token_address===shared).reduce((sum,r)=>sum+BigInt(r.allocated_raw),0n);
   assert.equal(sharedAllocated,1200n,'shared quote-token reservations aggregate across all registered pool variants without overlap');
   const jobs=await db.query('SELECT count(*)::int AS n FROM deployment_live_jobs WHERE status=\'queued\'');assert.equal(jobs.rows[0].n,12);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM deployment_live_stage_outbox')).rows[0].n,0,
    'admission creates no signed, published, or receipt-bearing stage');
   assert.equal(callbackCalls,14,'12 fresh admissions, exact replay, and conflicting-key check');

   const dashboardClient=await db.connect();
   try{
    const positions=(await readDeploymentRows(dashboardClient)).map(deploymentPosition);
    for(const {row,result} of accepted){
     const position=positions.find(item=>item.deployment.campaignId===result.campaignId);
     assert(position,`accepted live campaign ${result.campaignId} is visible in the shared positions projection`);
     assert.equal(position.mode,'live');assert.equal(position.status,'waiting');
     assert.equal(position.deployment.operation.id,result.jobId);assert.equal(position.deployment.operation.status,'queued');
     assert.equal(position.deployment.pool,row.profile.pool.pool);assert.equal(position.deployment.strategyId,'rangekeeper_v1');
     assert.equal(position.navQuote,null);assert.equal(position.feesQuote,null);assert.equal(position.gasQuote,null);
     assert.equal(position.accounting,'unavailable');
    }
   }finally{dashboardClient.release();}

   const state=await store.readWalletState(wallet),stalePayload=makePayload(profiles[0],state.commitmentsHash,allocated,nativeAllocated);
   const staleId=randomUUID(),staleReview=await recordRangeKeeperLiveSetupReview({wallet,reviewId:staleId,payload:stalePayload},store);
   assert.equal(staleReview.status,'review_recorded');byReview.set(staleId,'stale');
   const beforeStale=await db.query('SELECT count(*)::int AS n FROM deployment_live_jobs');
   const staleResponse=await post({reviewId:staleId,reviewHash:staleReview.reviewHash,requestId:randomUUID()});
   assert.equal(staleResponse.status,409);assert.equal((await staleResponse.json()).status,'unavailable');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM deployment_live_jobs')).rows[0].n,beforeStale.rows[0].n,
    'changed canonical source fails before campaign/reservation/job writes');

   ready=false;const callsBeforeClosed=callbackCalls;
   const closedCatalog=await fetch(`${origin}/api/strategies`,{headers:{Cookie:cookie}}).then(r=>r.json());
   assert.equal(closedCatalog.strategies.find(x=>x.id==='rangekeeper_v1').liveAdmission,false);
   assert.deepEqual(closedCatalog.strategies.find(x=>x.id==='rangekeeper_v1').liveWorker,{ready:false,missing:['live_wallet_worker_not_ready']});
   const closed=await post({reviewId:staleId,reviewHash:staleReview.reviewHash,requestId:randomUUID()});
   assert.equal(closed.status,503);assert.equal(callbackCalls,callsBeforeClosed,'readiness gate precedes admission callback');
   const closedBody=await closed.json();assert.equal(closedBody.actionAvailable,false);
   assert.deepEqual(closedBody.liveWorker,{ready:false,missing:['live_wallet_worker_not_ready']});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM deployment_live_jobs')).rows[0].n,beforeStale.rows[0].n);
   console.log('RangeKeeper live dashboard admission isolated HTTP/PG integration passed (12 profiles, 12 allocations/jobs, replay, stale-source/readiness/CSRF guards)');
  }finally{await new Promise(resolve=>server.close(resolve));}
 }finally{await db.end();}
}finally{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');admin.release();await root.end();}
