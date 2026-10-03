import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {privateKeyToAccount} from 'viem/accounts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {recordWalletSnapshot,readCommitments,readWalletState,recordReview} from '../../src/deployments/live-wallet-store.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {LiveWalletQueue,normalizeLiveCustodyPositionManager} from '../../src/deployments/live-wallet-queue.ts';
import {contentHash} from '../../src/deployments/contracts.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to a database where isolated schemas may be created');
const checksummedManager='0xAbCdEfabcdefABCDEFabcdefABCDEFabcdefABCD';
assert.equal(normalizeLiveCustodyPositionManager(checksummedManager),checksummedManager.toLowerCase(),
 'Checksum-cased canonical receipt evidence must map to the lowercase NFT custody key');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});
const admin=await pool.connect(),schema=`live_queue_${randomUUID().replaceAll('-','')}`;let scoped;
const signer=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),wallet=signer.address.toLowerCase(),token0='0x2222222222222222222222222222222222222222';
let verifiedFixture,verifyCalls=0,effectCalls=0,failNextReconciliation=true,failFirstEffect=true;
const unavailableAdapters={authorizeStage:async(client,{job,intent,plan,allocation,walletState})=>{
 const tokens=(await client.query(`SELECT token_address,balance_raw FROM deployment_live_wallet_tokens WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows;
 const allocationTokens=(await client.query(`SELECT token_address,allocated_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1`,[job.allocationId])).rows;
 return {intent,plan,pool:{fixture:true},before:{walletGeneration:Number(walletState.generation),
  wallet:{operator:wallet,source:{block:String(walletState.source_block),hash:walletState.source_hash,timestamp:Number(walletState.source_timestamp)},nonce:Number(walletState.nonce),pendingNonce:Number(walletState.pending_nonce),
   nativeWei:BigInt(walletState.native_balance_wei),tokens:Object.fromEntries(tokens.map(t=>[t.token_address,BigInt(t.balance_raw)])),nftTokenIds:[],allowances:[]},
  allocation:{campaignId:job.campaignId,liquidByTokenAddress:Object.fromEntries(allocationTokens.map(t=>[t.token_address,BigInt(t.allocated_raw)])),
   nativeSpendWei:BigInt(allocation.native_spend_wei),exitReserveWei:BigInt(allocation.exit_reserve_wei),nftTokenIds:[]}}};},
 reconcile:async()=>{verifyCalls++;if(failNextReconciliation){failNextReconciliation=false;throw Error('test has no canonical RPC adapter fixture');}return verifiedFixture;},
 afterReceipt:async(client,{job,outbox})=>{effectCalls++;
  assert(outbox.effects.afterWallet,'Complete receipt wallet after image must be durable before campaign effects');
  await client.query('INSERT INTO test_campaign_effects(job_id) VALUES($1)',[job.id]);
  if(failFirstEffect){failFirstEffect=false;throw Error('fixture campaign effect unavailable');}},
 verifyCleanup:async(_client,{job,allocation,walletState})=>({allowances:[{token:token0,spender:'0x5555555555555555555555555555555555555555',amount:'0'}],allocationHash:allocation.allocation_hash,
  source:{block:String(walletState.source_block),hash:walletState.source_hash,timestamp:Number(walletState.source_timestamp)},noPendingAction:true,custodyState:job.kind.startsWith('close_')?'closed_empty':'managed'})};
const queue=new LiveWalletQueue(pool,unavailableAdapters),build='a'.repeat(64),source={block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
 await admin.query('CREATE TABLE test_campaign_effects(job_id uuid PRIMARY KEY)');
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
 scoped=new pg.Pool({connectionString:url.toString(),max:6});
 // Queue connections share only schema-local tables; keep the pool and all rows inside this disposable schema.
 const scopedQueue=new LiveWalletQueue(scoped,unavailableAdapters),identity={chainId:4663,address:wallet};
 const profile=randomUUID(),campaignA=randomUUID(),campaignB=randomUUID(),allocationA=randomUUID(),allocationB=randomUUID(),reviewA=randomUUID(),reviewB=randomUUID();
 const emptyCommitmentsHash=liveWalletCommitmentFingerprint(await readCommitments(admin,identity));
 await recordWalletSnapshot(scoped,{...identity,source,nonce:'5',pendingNonce:'5',nativeBalanceWei:'1000000000000000000',
  tokens:[{address:token0,balanceRaw:'1000000'}],commitmentsHash:emptyCommitmentsHash});
 await admin.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
  VALUES($1,4663,$2,$3,$4,18,6,1,3000,60,'{}','{}',$5,now())`,[profile,'0x'+'3'.repeat(40),token0,'0x'+'4'.repeat(40),build]);
 for(const [campaign,allocation,review] of [[campaignA,allocationA,reviewA],[campaignB,allocationB,reviewB]]){
  await admin.query(`INSERT INTO deployment_campaigns(id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision)
   VALUES($1,'live',4663,$2,$3,'{}','active',1)`,[campaign,wallet,profile]);
  await admin.query(`INSERT INTO deployment_revisions(campaign_id,revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
   VALUES($1,1,'rangekeeper_v1','1.0.0',1,'{}',$2)`,[campaign,build]);
  await admin.query(`INSERT INTO deployment_live_allocations(id,chain_id,wallet,campaign_id,revision,state,native_spend_wei,exit_reserve_wei,source_generation,source_hash,allocation_hash)
   VALUES($1,4663,$2,$3,1,'active',$6,0,1,$4,$5)`,[allocation,wallet,campaign,source.hash,build,campaign===campaignB?'2000000000000':'0']);
  await admin.query(`INSERT INTO deployment_live_reviews(id,chain_id,wallet,payload,payload_hash,build_id,source_block,source_hash,source_timestamp,wallet_generation,commitments_hash,expires_at)
   VALUES($1,4663,$2,'{}',$3,$4,$5,$6,$7,1,$8,now()+interval '10 minutes')`,[review,wallet,contentHash({}),build,source.block,source.hash,source.timestamp,emptyCommitmentsHash]);
 }
 const seedJob=async(campaign,allocation,review,kind,key)=>{
  const id=randomUUID(),payload={campaign,kind};await admin.query(`INSERT INTO deployment_live_jobs(id,chain_id,wallet,campaign_id,revision,allocation_id,review_id,kind,status,priority,payload,payload_hash,build_id,idempotency_key,request_digest)
  VALUES($1,4663,$2,$3,1,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12)`,[id,wallet,campaign,allocation,review,kind,kind.startsWith('close_')?90:30,payload,contentHash(payload),build,key,contentHash({key,kind})]);return {id,status:'queued'};
 };
 const beforeInvalidEnqueue=Number((await admin.query(`SELECT count(*)::int AS n FROM deployment_live_jobs WHERE wallet=$1`,[wallet])).rows[0].n);
 await assert.rejects(()=>scopedQueue.enqueue({chainId:4663,address:wallet,campaignId:campaignB,revision:1,allocationId:allocationB,
  reviewId:reviewB,kind:'close_retain',buildId:build,idempotencyKey:'invalid-management-review',requestDigest:contentHash('invalid'),
  payload:{schemaVersion:1,kind:'rangekeeper_live_management_review',operationKind:'close_retain'}}),
  /Management action requires the current active RangeKeeper allocation/);
 assert.equal(Number((await admin.query(`SELECT count(*)::int AS n FROM deployment_live_jobs WHERE wallet=$1`,[wallet])).rows[0].n),
  beforeInvalidEnqueue,'An incomplete management review must not create a queue job');
 const first=await seedJob(campaignA,allocationA,reviewA,'resume','campaign-a-resume');
 const second=await seedJob(campaignA,allocationA,reviewA,'pause','campaign-a-pause');
 const third=await seedJob(campaignB,allocationB,reviewB,'close_retain','campaign-b-exit');
 const [claimA,claimB]=await Promise.all([scopedQueue.claimNext(identity),scopedQueue.claimNext(identity)]);
 assert.equal([claimA,claimB].filter(Boolean).length,1,'Concurrent workers claimed the same wallet twice');
 const active=claimA??claimB;assert(active);assert.equal(active.job.id,third.id,'Exit/recovery priority must win');
 assert.deepEqual(await scopedQueue.cancelQueued(identity,second.id),{jobId:second.id,status:'cancelled'});
 await admin.query(`UPDATE deployment_live_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[active.job.id]);
 const recovered=await scopedQueue.claimNext(identity);assert(recovered);assert.equal(recovered.job.id,active.job.id,'Expired lease must resume active job before queued work');
 assert.notEqual(recovered.leaseToken,active.leaseToken);
 await assert.rejects(()=>scopedQueue.renewLease(identity,active.job.id,active.leaseToken),/Lease lost|expired/);
 const extended=await scopedQueue.renewLease(identity,active.job.id,recovered.leaseToken,300_000);
 assert.equal(extended.leaseToken,recovered.leaseToken);
 assert(new Date(extended.leaseUntil).valueOf()>Date.now()+290_000,'Renewal extends only the currently owned lease');
 await assert.rejects(()=>scopedQueue.transition(identity,active.job.id,active.leaseToken,'executing'),/Lease lost|expired/);

 const intent={id:randomUUID(),chainId:4663,operator:signer.address,action:'rangekeeper_open',nonce:5,
  to:'0x5555555555555555555555555555555555555555',data:'0x1234',value:'0',gas:'200000',maxFeePerGas:'1000000000',maxPriorityFeePerGas:'1000000',sourceBlock:'100',sourceHash:source.hash};
 const plan={kind:'mint',amount:10n};
 await recovered.outbox;const prepared=await scopedQueue.prepareStage(identity,active.job.id,recovered.leaseToken,{stage:'open-mint',intent,plan});
 await scopedQueue.cancelPrepared(identity,active.job.id,'open-mint',recovered.leaseToken);
 const preparedAgain=await scopedQueue.prepareStage(identity,active.job.id,recovered.leaseToken,{stage:'open-mint-retry',intent,plan});
 assert.equal(preparedAgain.status,'prepared');assert.equal(preparedAgain.plan.amount,10n,'Prepared plan bigints survive durable JSON encoding');
 const pinned=await readWalletState(scoped,identity);
 const pinnedCommitments=liveWalletCommitmentFingerprint(await readCommitments(scoped,identity));
 await assert.rejects(()=>recordWalletSnapshot(scoped,{...identity,source,nonce:pinned.nonce,pendingNonce:pinned.pendingNonce,
  nativeBalanceWei:pinned.nativeBalanceWei,tokens:pinned.tokens,commitmentsHash:pinnedCommitments}),/unresolved stage/);
 await assert.rejects(()=>recordReview(scoped,{...identity,payload:{},payloadHash:contentHash({}),buildId:build,source,
  walletGeneration:pinned.generation,commitmentsHash:pinned.commitmentsHash,expiresAt:new Date(Date.now()+60_000).toISOString()}),/unresolved stage/);
 const raw=await signer.signTransaction({type:'eip1559',chainId:4663,nonce:5,to:intent.to,data:intent.data,value:0n,gas:200000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1000000n});
 const signed=await scopedQueue.recordSigned(identity,active.job.id,'open-mint-retry',recovered.leaseToken,raw);
 assert.equal(signed.status,'signed');assert.equal((await scopedQueue.readPersistedRaw(identity,active.job.id,'open-mint-retry')).raw,raw.toLowerCase());
 await assert.rejects(()=>scopedQueue.cancelPrepared(identity,active.job.id,'open-mint-retry',recovered.leaseToken),/Cannot cancel/);
 await assert.rejects(()=>scopedQueue.prepareStage(identity,active.job.id,recovered.leaseToken,{stage:'other',intent:{...intent,id:randomUUID()},plan}),/duplicate key|unique/i,
  'One wallet nonce cannot be prepared twice');
 assert.equal((await scopedQueue.claimNext(identity)),null,'Signed unresolved action retains wallet ownership');
 assert.equal(second.status,'queued');
 // Exercise the database's exactly-once atomic effect path through the mandatory adapter seam.
 // Canonical receipt authenticity itself is covered by the separate reducer tests.
 verifiedFixture={receipt:{status:'reverted',gasUsed:1000000000000n},receiptHash:'d'.repeat(64),proofHash:'e'.repeat(64),effects:{gasWei:'1000000000000'},gasWei:1000000000000n,status:'reverted',
  source:{block:101n,hash:`0x${'c'.repeat(64)}`,timestamp:source.timestamp},
  afterWallet:{operator:wallet,source:{block:101n,hash:`0x${'c'.repeat(64)}`,timestamp:source.timestamp},nonce:6,pendingNonce:6,nativeWei:999999000000000000n,
   tokens:{[token0]:1000000n},nftTokenIds:[],allowances:[]},
  nextLiquidByTokenAddress:{},nextNativeSpendWei:1000000000000n,nextExitReserveWei:0n,nextNftTokenIds:[],retiredNftTokenIds:[],
  positionManager:'0x6666666666666666666666666666666666666666',position:null};
 // Allow canonical-like source time while keeping the row fresh for the store's age gate.
 verifiedFixture.source.timestamp=Math.floor(Date.now()/1000);
 verifiedFixture.afterWallet.source.timestamp=verifiedFixture.source.timestamp;
 await assert.rejects(()=>scopedQueue.reconcileStage(identity,active.job.id,'open-mint-retry',recovered.leaseToken),/test has no canonical RPC adapter fixture/);
 assert.equal(Number((await scoped.query(`SELECT generation FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows[0].generation),1,
  'Failed canonical callback must leave wallet snapshot and allocation unchanged');
 await assert.rejects(()=>scopedQueue.reconcileStage(identity,active.job.id,'open-mint-retry',recovered.leaseToken),/campaign effect unavailable/);
 assert.equal(Number((await scoped.query('SELECT count(*) FROM test_campaign_effects')).rows[0].count),0,'Campaign effect failure rolls back its own append');
 assert.equal(Number((await scoped.query(`SELECT generation FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows[0].generation),1,
  'Campaign effect failure rolls back wallet, allocation and canonical receipt together');
 const result=await scopedQueue.reconcileStage(identity,active.job.id,'open-mint-retry',recovered.leaseToken);
 assert.equal(result.status,'reverted');assert.equal(verifyCalls,3);assert.equal(effectCalls,2);
 const receiptReplay=await scopedQueue.reconcileStage(identity,active.job.id,'open-mint-retry',recovered.leaseToken);
 assert.equal(receiptReplay.status,'reverted');assert.equal(verifyCalls,3,'Persisted receipt replay must not rerun attribution');
 assert.equal(effectCalls,2,'Persisted receipt replay must not charge campaign state twice');
 assert.equal(Number((await scoped.query('SELECT count(*) FROM test_campaign_effects')).rows[0].count),1);
 assert.equal((await scoped.query(`SELECT status FROM deployment_live_jobs WHERE id=$1`,[active.job.id])).rows[0].status,'blocked');
 assert.equal(Number((await scoped.query(`SELECT generation FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows[0].generation),2,
  'Whole-wallet gas/token snapshot and allocation accounting commit exactly once');
 const accounted=(await scoped.query(`SELECT a.campaign_id,a.native_spend_wei FROM deployment_live_allocations a WHERE a.chain_id=4663 AND a.wallet=$1 ORDER BY campaign_id`,[wallet])).rows;
 assert.equal(String(accounted.find(r=>r.campaign_id===campaignB).native_spend_wei),'1000000000000','Initiating campaign pays canonical gas once');
 assert.equal(String(accounted.find(r=>r.campaign_id===campaignA).native_spend_wei),'0','Sibling campaign reserve remains unchanged');
 const savedReceipt=(await scoped.query(`SELECT canonical_receipt_json FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage='open-mint-retry'`,[active.job.id])).rows[0].canonical_receipt_json;
 assert.equal(savedReceipt.receipt.gasUsed,'1000000000000','Receipt bigints are JSON safe and lossless');
 await assert.rejects(()=>scopedQueue.finish(identity,active.job.id,recovered.leaseToken),/Only successfully reconciled actions can finish/);
 // A successful receipt turn may yield its lease, but the active job keeps
 // wallet ownership so queued sibling campaigns cannot interleave stages.
 await scoped.query(`UPDATE deployment_live_jobs SET status='reconciling',completed_at=NULL WHERE id=$1`,[active.job.id]);
 await assert.rejects(()=>scopedQueue.yieldAfterConfirmedReceipt(identity,active.job.id,'open-mint-retry',recovered.leaseToken),
  /Only a fully attributed successful receipt can yield its lease/);
 await scoped.query(`UPDATE deployment_live_stage_outbox SET status='confirmed',canonical_receipt_json=$3::jsonb,
  effect_evidence_json=$4::jsonb WHERE job_id=$1 AND stage=$2`,[active.job.id,'open-mint-retry',
   JSON.stringify({receiptHash:'f'.repeat(64),status:'success'}),JSON.stringify({afterWallet:{allowances:[]}})]);
 await scoped.query(`INSERT INTO deployment_live_stage_outbox(job_id,stage,chain_id,wallet,intent_json,plan_json,before_json,nonce,status)
  VALUES($1,'next-pending',4663,$2,'{}','{}','{}',6,'prepared')`,[active.job.id,wallet]);
 await assert.rejects(()=>scopedQueue.yieldAfterConfirmedReceipt(identity,active.job.id,'open-mint-retry',recovered.leaseToken),
  /Unresolved action must retain its active lease/);
 await scoped.query(`DELETE FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage='next-pending'`,[active.job.id]);
 assert.deepEqual(await scopedQueue.yieldAfterConfirmedReceipt(identity,active.job.id,'open-mint-retry',recovered.leaseToken),
  {jobId:active.job.id,status:'reconciling',yielded:true});
 const immediateResume=await scopedQueue.claimNext(identity);
 assert.equal(immediateResume?.job.id,active.job.id,'Confirmed active job resumes immediately ahead of sibling campaigns');
 assert.notEqual(immediateResume?.leaseToken,recovered.leaseToken);
 await assert.rejects(()=>scopedQueue.yieldAfterConfirmedReceipt(identity,active.job.id,'open-mint-retry',recovered.leaseToken),/Lease lost|expired/);
 assert.equal((await scoped.query(`SELECT status FROM deployment_live_jobs WHERE id=$1`,[first.id])).rows[0].status,'queued');
 console.log('live wallet queue integration: wallet-wide claims, exit priority, stale lease fencing/recovery, immediate confirmed-stage lease yield, nonce uniqueness, immutable signed raw, no signed cancel, follow-on admission fail-closed, atomic revert/gas attribution and receipt replay passed');
}finally{
 try{await scoped?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{admin.release();await pool.end();}
}
