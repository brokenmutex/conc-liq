import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateDatabase,MIGRATIONS } from '../../src/storage/migrations.ts';
import { MIGRATION_CHECKSUMS } from '../../src/storage/migration-checksums.ts';
import { assertSchemaReady,assertDeploymentSchemaReady } from '../../src/storage/compatibility.ts';
import { SCHEMA_SQL } from '../../src/storage/schema.ts';
import { PostgresRiskStore } from '../../src/risk/store.ts';
import { PostgresPositionManagerTransferStore,scanPositionManagerTransferHistory } from '../../src/nft/position-manager-transfer-index.ts';
import { readCompletePositionManagerNftCustody } from '../../src/deployments/live-transfer-nft-enumeration.ts';

if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL explicitly; tests create and remove isolated schemas only');
const pool = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
const client = await pool.connect();
const schemas=[];
async function schema(){const name=`migration_test_${randomUUID().replaceAll('-','')}`;schemas.push(name);await client.query(`CREATE SCHEMA ${name}`);await client.query(`SET search_path=${name}`);return name;}
try {
 const fresh=await schema();
 await assert.rejects(assertSchemaReady(client),/schema incompatible/);
 assert.deepEqual(await migrateDatabase(client),[1,2,3,4,5,6,7,8,9,10,11]);
 await assertSchemaReady(client);
 assert.equal((await client.query("SELECT to_regclass('deployment_rangekeeper_paper_confirmations') AS name")).rows[0].name,
  'deployment_rangekeeper_paper_confirmations');
 assert.equal((await client.query("SELECT to_regclass('position_manager_transfer_cursors') AS name")).rows[0].name,
  'position_manager_transfer_cursors');
 assert.equal((await client.query("SELECT to_regclass('position_manager_transfer_checkpoints') AS name")).rows[0].name,
  'position_manager_transfer_checkpoints');
 assert.equal((await client.query("SELECT to_regclass('position_manager_transfers') AS name")).rows[0].name,
  'position_manager_transfers');
 // The real SQL adapter persists bounded scanner chunks and rewinds a reorged
 // suffix atomically. Chain reads are mocked; PostgreSQL/DDL are real and isolated.
 const schemaUrl=new URL(process.env.TEST_DATABASE_URL);schemaUrl.searchParams.set('options',`-c search_path=${fresh}`);
 const transferStore=new PostgresPositionManagerTransferStore(schemaUrl.toString());
 const manager='0x1111111111111111111111111111111111111111';
 const alice='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
 const blockHash=(number,epoch=0)=>`0x${(BigInt(number)+1n+((epoch&&BigInt(number)>=2n)?100n:0n)).toString(16).padStart(64,'0')}`;
 const block=(number,epoch=0)=>({number:BigInt(number),hash:blockHash(number,epoch),
  parentHash:`0x${(BigInt(number)+((epoch&&BigInt(number)-1n>=2n)?100n:0n)).toString(16).padStart(64,'0')}`,
  timestamp:1700000000n+BigInt(number)});
 const chain=(epoch=0)=>({getChainId:async()=>4663,getBlock:async({blockNumber}={})=>block(blockNumber??100n,epoch),
  getBytecode:async()=> '0x6000',readContract:async({functionName})=>functionName==='balanceOf'?1n:alice,
  getLogs:async({fromBlock,toBlock})=>fromBlock<=1n&&toBlock>=1n?[{
   address:manager,eventName:'Transfer',blockNumber:1n,blockHash:blockHash(1,epoch),
   transactionHash:`0x${'5'.repeat(64)}`,transactionIndex:0,logIndex:0,
   args:{from:'0x0000000000000000000000000000000000000000',to:alice,tokenId:7n},
  }]:[]});
 try {
  const oldSource={block:3n,hash:blockHash(3),timestamp:Number(block(3).timestamp)};
  const scan=await scanPositionManagerTransferHistory({client:chain(),store:transferStore,chainId:4663,
   manager,startBlock:0n,source:oldSource,chunkBlocks:2n,maxBlocksPerRun:2n});
  assert.equal(scan.status,'scanned');assert.equal(scan.coveredThroughBlock,'1');
  const next=await scanPositionManagerTransferHistory({client:chain(),store:transferStore,chainId:4663,
   manager,startBlock:0n,source:oldSource,chunkBlocks:2n,maxBlocksPerRun:2n});
  assert.equal(next.status,'scanned');assert.equal(next.coveredThroughBlock,'3');assert.equal(next.enumerationComplete,false);
  assert.equal((await transferStore.loadTransfers(4663,manager,0n,3n,10)).length,1);
  const custody=await readCompletePositionManagerNftCustody({client:chain(),store:transferStore,
   targetStrategyId:'static_manual_v1',operator:alice,positionManager:manager,startBlock:0n,source:oldSource});
  assert.equal(custody.status,'available');assert.equal(custody.enumerationComplete,true);
  assert.deepEqual(custody.tokenIds,['7']);assert.equal(custody.actionAvailable,false);
  const forkSource={block:3n,hash:blockHash(3,1),timestamp:Number(block(3,1).timestamp)};
  const fork=await scanPositionManagerTransferHistory({client:chain(1),store:transferStore,chainId:4663,
   manager,startBlock:0n,source:forkSource,chunkBlocks:2n,maxBlocksPerRun:2n});
  assert.equal(fork.status,'scanned');assert.equal(fork.enumerationComplete,false);
  assert.equal((await transferStore.getCursor(4663,manager,0n)).coveredThroughBlock,3n);
  assert.equal((await transferStore.loadTransfers(4663,manager,0n,3n,10)).length,1);
 } finally {await transferStore.close();}
 assert.deepEqual(await migrateDatabase(client),[]);
 await schema();
 await client.query(`CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),method text NOT NULL)`);
 for(let i=0;i<3;i++){
  await client.query(MIGRATIONS[i]);
  await client.query('INSERT INTO schema_migrations(version,checksum,method) VALUES($1,$2,$3)',
   [i+1,MIGRATION_CHECKSUMS[i],'applied']);
 }
 await assertSchemaReady(client);
 await assert.rejects(assertDeploymentSchemaReady(client),/schema incompatible/);
 await client.query("INSERT INTO paper_sessions(stream_key,policy_hash,policy,state,status) VALUES('upgrade','same','{}','{}','closed')");
 assert.deepEqual(await migrateDatabase(client),[4,5,6,7,8,9,10,11]);
 await assertSchemaReady(client);
 await assertDeploymentSchemaReady(client);
 assert.equal((await client.query("SELECT policy_hash FROM paper_sessions WHERE stream_key='upgrade'")).rows[0].policy_hash,'same');
 await schema();
 await client.query(`CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),method text NOT NULL)`);
 for(let i=0;i<4;i++){
  await client.query(MIGRATIONS[i]);
  await client.query('INSERT INTO schema_migrations(version,checksum,method) VALUES($1,$2,$3)',
   [i+1,MIGRATION_CHECKSUMS[i],'applied']);
 }
 await assertSchemaReady(client);
 await assert.rejects(assertDeploymentSchemaReady(client),/schema incompatible/);
 assert.deepEqual(await migrateDatabase(client),[5,6,7,8,9,10,11]);
 await assertDeploymentSchemaReady(client);
 assert.equal((await client.query("SELECT to_regclass('deployment_paper_fee_evidence') AS name")).rows[0].name,
  'deployment_paper_fee_evidence');
 assert.equal((await client.query("SELECT to_regclass('deployment_paper_accounting') AS name")).rows[0].name,
  'deployment_paper_accounting');
 assert.equal((await client.query("SELECT to_regclass('deployment_paper_accounting_invalidations') AS name")).rows[0].name,
  'deployment_paper_accounting_invalidations');
 await schema();
 await client.query(`CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),method text NOT NULL)`);
 for(let i=0;i<6;i++){
  await client.query(MIGRATIONS[i]);
  await client.query('INSERT INTO schema_migrations(version,checksum,method) VALUES($1,$2,$3)',
   [i+1,MIGRATION_CHECKSUMS[i],'applied']);
 }
 await assertSchemaReady(client);
 await assert.rejects(assertDeploymentSchemaReady(client),/schema incompatible/);
 assert.deepEqual(await migrateDatabase(client),[7,8,9,10,11]);
 await assertDeploymentSchemaReady(client);
 assert.equal((await client.query("SELECT to_regclass('deployment_paper_accounting_invalidations') AS name")).rows[0].name,
  'deployment_paper_accounting_invalidations');
 await client.query(`SET search_path=${fresh}`);
 await client.query("BEGIN READ ONLY");await assertSchemaReady(client);await client.query('COMMIT');
 await client.query("UPDATE schema_migrations SET checksum='modified' WHERE version=1");
 await assert.rejects(assertSchemaReady(client),/schema incompatible/);
 await assert.rejects(migrateDatabase(client),/modified database migration history/);
 // Coverage high-water mark: saveChunk only raises it, rewind lowers it no
 // further than the block it invalidated, and a stale writer cannot move it
 // back. Exercised as SQL because that is where the guard lives.
 await client.query(`SET search_path=${fresh}`);
 const cursor=async(next,scanned,covered)=>client.query(
  `INSERT INTO indexer_cursors (stream_key,chain_id,target_set_hash,next_block,last_scanned_block,last_scanned_hash,covered_through_block)
   VALUES('s',4663,'0x00',$1,$2,'0x01',$3)
   ON CONFLICT (stream_key) DO UPDATE SET next_block=EXCLUDED.next_block,
     last_scanned_block=EXCLUDED.last_scanned_block,last_scanned_hash=EXCLUDED.last_scanned_hash,
     covered_through_block=GREATEST(COALESCE(indexer_cursors.covered_through_block,0),EXCLUDED.covered_through_block)`,
  [String(next),String(scanned),String(covered)]);
 const rewind=async(from,anchor)=>client.query(
  `INSERT INTO indexer_cursors (stream_key,chain_id,target_set_hash,next_block,last_scanned_block,last_scanned_hash,covered_through_block)
   VALUES('s',4663,'0x00',$1,$2,'0x01',$3)
   ON CONFLICT (stream_key) DO UPDATE SET next_block=EXCLUDED.next_block,
     last_scanned_block=EXCLUDED.last_scanned_block,last_scanned_hash=EXCLUDED.last_scanned_hash,
     covered_through_block=LEAST(COALESCE(indexer_cursors.covered_through_block,indexer_cursors.last_scanned_block,EXCLUDED.covered_through_block),EXCLUDED.covered_through_block)`,
  [String(from),String(anchor),String(from-1n)]);
 const covered=async()=>(await client.query("SELECT covered_through_block::text AS b,last_scanned_block::text AS s FROM indexer_cursors WHERE stream_key='s'")).rows[0];
 await cursor(1001n,1000n,1000n);assert.deepEqual(await covered(),{b:'1000',s:'1000'});
 await cursor(2001n,2000n,2000n);assert.deepEqual(await covered(),{b:'2000',s:'2000'});
 // A stale chunk save must not move coverage backwards.
 await cursor(1501n,1500n,1500n);assert.equal((await covered()).b,'2000');
 // A rewind past the reorg overlap drops coverage to the invalidated block
 // only, even though the surviving checkpoint anchor is far older.
 await rewind(1900n,50n);assert.deepEqual(await covered(),{b:'1899',s:'50'});
 await cursor(2101n,2100n,2100n);assert.equal((await covered()).b,'2100');
 const existing=await schema();await client.query(SCHEMA_SQL);
 await client.query(`INSERT INTO paper_sessions(stream_key,policy_hash,policy,state,status) VALUES('old','unchanged','{}','{}','closed')`);
 await assert.rejects(migrateDatabase(client),/Unversioned existing database/);
 assert.deepEqual(await migrateDatabase(client,{baseline:true}),[1,2,3,4,5,6,7,8,9,10,11]);
 const old=(await client.query("SELECT policy_hash,state,runtime_identity FROM paper_sessions")).rows[0];
 assert.deepEqual(old,{policy_hash:'unchanged',state:{},runtime_identity:null});
 assert.equal((await client.query('SELECT method FROM schema_migrations WHERE version=1')).rows[0].method,'verified_baseline');
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${existing} -c default_transaction_read_only=on -c statement_timeout=2000`);
 const worker=new PostgresRiskStore(url.toString());try{await worker.assertReady();}finally{await worker.close();}
 // A held read lock on an application table cannot block worker startup checks.
 const other=await pool.connect();try{
  await other.query('BEGIN');await other.query(`LOCK TABLE ${existing}.risk_snapshot_runs IN ACCESS EXCLUSIVE MODE`);
  await assertSchemaReady(client);
 }finally{await other.query('ROLLBACK');other.release();}
 const legacy=await schema();await client.query(SCHEMA_SQL);
 const fixture=JSON.parse(readFileSync(new URL('../fixtures/legacy-schema-constraints.json',import.meta.url),'utf8'));
 const current=(await client.query('SELECT c.relname,k.conname FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])',[fixture.tables])).rows;
 for(const row of current)await client.query(`ALTER TABLE ${row.relname} DROP CONSTRAINT "${row.conname}"`);
 for(const row of fixture.constraints)await client.query(`ALTER TABLE ${row.table_name} ADD CONSTRAINT "${row.name}" ${row.definition}`);
 assert.deepEqual(await migrateDatabase(client,{baseline:true}),[1,2,3,4,5,6,7,8,9,10,11]);
 const broken=await schema();await client.query(SCHEMA_SQL);await client.query('ALTER TABLE paper_sessions DROP COLUMN policy_hash');
 await assert.rejects(migrateDatabase(client,{baseline:true}),/differs from the frozen baseline/);
 assert.equal((await client.query("SELECT to_regclass('schema_migrations') AS name")).rows[0].name,null);
 // search_path fallback must not let a different schema satisfy readiness.
 await schema();await client.query(`SET search_path=${schemas.at(-1)},${existing}`);
 await assert.rejects(assertSchemaReady(client),/schema incompatible/);
 console.log(JSON.stringify({passed:['fresh migration through v11 including dedicated Position Manager Transfer index','real Postgres scanner chunk persistence and reorg rewind with mocked chain reads','v3-to-v11 isolated upgrade','v4-to-v11 isolated upgrade','v6-to-v11 isolated upgrade','idempotency','read-only readiness','checksum rejection','verified existing baseline','exact production legacy constraints accepted','legacy rows unchanged','worker starts without DDL','application locks do not block readiness','schema drift rejected atomically','search-path isolation','monotone coverage cursor']}));
}finally{
 await client.query('ROLLBACK');await client.query('SET search_path=public');
 for(const name of schemas)await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
 client.release();await pool.end();
}
