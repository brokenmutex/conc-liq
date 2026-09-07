import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateDatabase } from '../../src/storage/migrations.ts';
import { assertSchemaReady } from '../../src/storage/compatibility.ts';
import { SCHEMA_SQL } from '../../src/storage/schema.ts';
import { PostgresRiskStore } from '../../src/risk/store.ts';

if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL explicitly; tests create and remove isolated schemas only');
const pool = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
const client = await pool.connect();
const schemas=[];
async function schema(){const name=`migration_test_${randomUUID().replaceAll('-','')}`;schemas.push(name);await client.query(`CREATE SCHEMA ${name}`);await client.query(`SET search_path=${name}`);return name;}
try {
 const fresh=await schema();
 await assert.rejects(assertSchemaReady(client),/schema incompatible/);
 assert.deepEqual(await migrateDatabase(client),[1,2]);
 await assertSchemaReady(client);
 assert.deepEqual(await migrateDatabase(client),[]);
 await client.query("BEGIN READ ONLY");await assertSchemaReady(client);await client.query('COMMIT');
 await client.query("UPDATE schema_migrations SET checksum='modified' WHERE version=1");
 await assert.rejects(assertSchemaReady(client),/schema incompatible/);
 await assert.rejects(migrateDatabase(client),/modified database migration history/);
 const existing=await schema();await client.query(SCHEMA_SQL);
 await client.query(`INSERT INTO paper_sessions(stream_key,policy_hash,policy,state,status) VALUES('old','unchanged','{}','{}','closed')`);
 await assert.rejects(migrateDatabase(client),/Unversioned existing database/);
 assert.deepEqual(await migrateDatabase(client,{baseline:true}),[1,2]);
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
 assert.deepEqual(await migrateDatabase(client,{baseline:true}),[1,2]);
 const broken=await schema();await client.query(SCHEMA_SQL);await client.query('ALTER TABLE paper_sessions DROP COLUMN policy_hash');
 await assert.rejects(migrateDatabase(client,{baseline:true}),/differs from the frozen baseline/);
 assert.equal((await client.query("SELECT to_regclass('schema_migrations') AS name")).rows[0].name,null);
 // search_path fallback must not let a different schema satisfy readiness.
 await schema();await client.query(`SET search_path=${schemas.at(-1)},${existing}`);
 await assert.rejects(assertSchemaReady(client),/schema incompatible/);
 console.log(JSON.stringify({passed:['fresh migration','idempotency','read-only readiness','checksum rejection','verified existing baseline','exact production legacy constraints accepted','legacy rows unchanged','worker starts without DDL','application locks do not block readiness','schema drift rejected atomically','search-path isolation']}));
}finally{
 await client.query('ROLLBACK');await client.query('SET search_path=public');
 for(const name of schemas)await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
 client.release();await pool.end();
}
