import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore,DeploymentConflict} from '../../src/deployments/store.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to a database where isolated schemas may be created');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const admin=await pool.connect();
const schema=`deployment_test_${randomUUID().replaceAll('-','')}`;
let store;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);
 await admin.query(`SET search_path=${schema}`);
 assert.deepEqual(await migrateDatabase(admin),[1,2,3,4]);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(url.toString());
 await store.assertReady();
 const profile=randomUUID(),wallet='0x1111111111111111111111111111111111111111';
 await admin.query(`INSERT INTO deployment_market_profiles
  (id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,
   quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
  VALUES($1,4663,$2,$3,$4,18,6,1,3000,60,'{}','{}',$5,clock_timestamp())`,
  [profile,'0x'+'a'.repeat(40),'0x'+'b'.repeat(40),'0x'+'c'.repeat(40),'1'.repeat(64)]);
 const draftInput={mode:'live',chainId:4663,wallet,marketProfileId:profile,
  strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:'0',token1Raw:'250000000',nativeWei:'10000000000000000'},config:{tickLower:10,tickUpper:20}};
 await assert.rejects(store.createDraft({...draftInput,strategyId:'adaptive_v1'}));
 await assert.rejects(store.createDraft({...draftInput,config:{...draftInput.config,spender:'0x'+'d'.repeat(40)}}));
 await assert.rejects(store.createDraft({...draftInput,config:{...draftInput.config,calldata:'0xdeadbeef'}}));
 const draft=await store.createDraft(draftInput);
 const preview=await store.recordPreview({campaignId:draft.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'1',token0Raw:'0'},
  evidence:{blockHash:'0x'+'2'.repeat(64)},expiresAt:new Date(Date.now()+60000)});
 await assert.rejects(admin.query('UPDATE deployment_revisions SET config=$2 WHERE campaign_id=$1',
  [draft.id,'{}']),/append-only/);
 await assert.rejects(admin.query('DELETE FROM deployment_previews WHERE id=$1',[preview.id]),/append-only/);
 const command={previewId:preview.id,contentDigest:preview.contentDigest,expectedRevision:1,
  idempotencyKey:'deployment-open-unique-1'};
 const blocker=await pool.connect();
 try{
  await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`conc-liq-live:4663:${wallet.toLowerCase()}`]);
  await assert.rejects(store.acceptOperation(draft.id,command,'operator'),
   error=>error instanceof DeploymentConflict&&error.code==='predecessor_wallet_locked');
 }finally{
  await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`conc-liq-live:4663:${wallet.toLowerCase()}`]);
  blocker.release();
 }
 const first=await store.acceptOperation(draft.id,command,'operator');
 assert.equal(first.status,'queued');assert.equal(first.replayed,false);
 assert.equal((await store.operation(first.id)).status,'queued');
 const replay=await store.acceptOperation(draft.id,command,'operator');
 assert.equal(replay.id,first.id);assert.equal(replay.replayed,true);
 await assert.rejects(store.acceptOperation(draft.id,{...command,contentDigest:'f'.repeat(64)},'operator'),
  error=>error instanceof DeploymentConflict&&error.code==='idempotency_conflict');
 const claimed=await Promise.all([store.claimNext('worker-one',30),store.claimNext('worker-two',30)]);
 assert.equal(claimed.filter(Boolean).length,1);
 const owner=claimed[0]?'worker-one':'worker-two';
 assert.equal(claimed.find(Boolean).id,first.id);
 await assert.rejects(store.advanceClaim(first.id,owner==='worker-one'?'worker-two':'worker-one',
  'preflight','executing',null),error=>error instanceof DeploymentConflict&&error.code==='claim_lost');
 await store.advanceClaim(first.id,owner,'source_checked','executing',null);
 await admin.query(`UPDATE deployment_operations SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[first.id]);
 const recovered=await store.claimNext('worker-restart',30);
 assert.equal(recovered.id,first.id);assert.equal(recovered.stage,'source_checked');
 assert.equal(recovered.status,'executing');
 const second=await store.createDraft(draftInput);
 const secondPreview=await store.recordPreview({campaignId:second.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'2'},evidence:{blockHash:'0x'+'3'.repeat(64)},
  expiresAt:new Date(Date.now()+60000)});
 await assert.rejects(store.acceptOperation(second.id,{previewId:secondPreview.id,
  contentDigest:secondPreview.contentDigest,expectedRevision:1,idempotencyKey:'deployment-open-unique-2'},'operator'),
  error=>error instanceof DeploymentConflict&&error.code==='wallet_reserved');
 const rows=(await admin.query('SELECT id,status FROM deployment_operations')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].id,first.id);
 const reservations=(await admin.query('SELECT campaign_id FROM deployment_wallet_reservations WHERE released_at IS NULL')).rows;
 assert.deepEqual(reservations.map(row=>row.campaign_id),[draft.id]);
 console.log(JSON.stringify({passed:['explicit migration','strategy allowlist','draft and trusted preview','immutable evidence','predecessor lock','idempotent operation','conflicting retry','single worker claim','restart resumes stage','wallet exclusivity','atomic failure']}));
}finally{
 if(store)await store.close();
 await admin.query('SET search_path=public');
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
