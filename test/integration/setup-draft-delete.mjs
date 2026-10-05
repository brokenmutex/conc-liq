import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore,DeploymentConflict} from '../../src/deployments/store.ts';
import {readDeploymentRows} from '../../src/dashboard/deployment-position.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const schema=`draft_delete_${randomUUID().replaceAll('-','')}`;
let store,fixturePool;
try{
 const admin=await adminPool.connect();
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
  assert.deepEqual(await migrateDatabase(admin),[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
 }finally{admin.release();}
 const dbUrl=new URL(process.env.TEST_DATABASE_URL);
 dbUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=10000`);
 store=new DeploymentStore(dbUrl.toString());await store.assertReady();
 fixturePool=new pg.Pool({connectionString:dbUrl.toString(),max:2});
 const db=fixturePool,profileId=randomUUID(),campaignId=randomUUID(),historicalId=randomUUID();
 const wallet='0x1111111111111111111111111111111111111111';
 await db.query(`INSERT INTO deployment_market_profiles
  (id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,
   quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
  VALUES($1,4663,$2,$3,$4,18,6,1,3000,60,'{}','{}',$5,clock_timestamp())`,
  [profileId,'0x'+'a'.repeat(40),'0x'+'b'.repeat(40),'0x'+'c'.repeat(40),'a'.repeat(64)]);
 const createCampaign=async(id,lifecycle)=>{
  await db.query(`INSERT INTO deployment_campaigns
   (id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision,closed_at)
   VALUES($1,'paper',4663,$2,$3,'{}',$4,1,CASE WHEN $4='closed' THEN clock_timestamp() ELSE NULL END)`,
   [id,wallet,profileId,lifecycle]);
  await db.query(`INSERT INTO deployment_revisions
   (campaign_id,revision,parent_revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
   VALUES($1,1,NULL,'static_manual_v1','1.0.0',1,'{}',$2)`,[id,'c'.repeat(64)]);
 };
 await createCampaign(campaignId,'draft');await createCampaign(historicalId,'closed');
 // A real historical close has an operation, so the dashboard exclusion for
 // pristine deleted drafts must leave it visible.
 const previewId=randomUUID(),operationId=randomUUID();
 await db.query(`INSERT INTO deployment_previews
  (id,campaign_id,expected_revision,kind,request,proposal,evidence,content_digest,created_at,expires_at)
  VALUES($1,$2,1,'open','{}','{}','{}',$3,clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 hour')`,
  [previewId,historicalId,'d'.repeat(64)]);
 await db.query(`INSERT INTO deployment_operations
  (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage)
  VALUES($1,$2,$3,'operator','historical',repeat('e',64),'open','succeeded','complete')`,
  [operationId,historicalId,previewId]);

 assert.deepEqual(await store.deleteStaticPaperDraft(campaignId),
  {status:'deleted',campaignId,idempotent:false});
 assert.deepEqual(await store.deleteStaticPaperDraft(campaignId),
  {status:'deleted',campaignId,idempotent:true});
 await assert.rejects(store.paperDraft(campaignId),e=>e instanceof DeploymentConflict&&e.code==='paper_draft_unavailable');
 const rows=await readDeploymentRows(db);
 assert(rows.some(row=>row.id===historicalId),'real closed deployment remains visible');
 assert(!rows.some(row=>row.id===campaignId),'deleted untouched draft stays out of positions');

 for(const lifecycle of ['active','paused','blocked']){
  const protectedId=randomUUID();await createCampaign(protectedId,lifecycle);
  await assert.rejects(store.deleteStaticPaperDraft(protectedId),e=>e instanceof DeploymentConflict&&e.code==='static_paper_draft_not_deletable');
 }
 await assert.rejects(store.deleteStaticPaperDraft(historicalId),e=>e instanceof DeploymentConflict&&e.code==='static_paper_draft_not_deletable');
 const racedId=randomUUID();await createCampaign(racedId,'draft');
 const lock=await adminPool.connect();
 await lock.query(`SET search_path=${schema}`);await lock.query('BEGIN');
 await lock.query('SELECT id FROM deployment_campaigns WHERE id=$1 FOR UPDATE',[racedId]);
 const deletePromise=store.deleteStaticPaperDraft(racedId);
 await new Promise(resolve=>setTimeout(resolve,40));
 const racedPreview=randomUUID(),racedOperation=randomUUID();
 await lock.query(`INSERT INTO deployment_previews
  (id,campaign_id,expected_revision,kind,request,proposal,evidence,content_digest,expires_at)
  VALUES($1,$2,1,'open','{}','{}','{}',$3,clock_timestamp()+interval '1 hour')`,
  [racedPreview,racedId,'f'.repeat(64)]);
 await lock.query(`INSERT INTO deployment_operations
  (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage)
  VALUES($1,$2,$3,'operator','accepted',repeat('a',64),'open','queued','accepted')`,
  [racedOperation,racedId,racedPreview]);
 await lock.query('COMMIT');lock.release();
 await assert.rejects(deletePromise,e=>e instanceof DeploymentConflict&&e.code==='static_paper_draft_not_deletable');
 await assert.rejects(store.deleteStaticPaperDraft(randomUUID()),
  e=>e instanceof DeploymentConflict&&e.code==='campaign_not_found');
 assert.equal((await db.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[racedId])).rows[0].lifecycle,'draft');
 console.log('Saved draft deletion integration passed: logical tombstone, idempotency, dashboard filter, and acceptance race.');
}finally{
 if(store)await store.close();
 if(fixturePool)await fixturePool.end();
 await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await adminPool.end();
}
