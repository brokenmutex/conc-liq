import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { verifyRelease } from '../../scripts/release-files.mjs';

if(!process.env.TEST_DATABASE_URL || !process.env.TEST_RELEASE_DIR)throw Error('TEST_DATABASE_URL and TEST_RELEASE_DIR are required');
const release=realpathSync(process.env.TEST_RELEASE_DIR),manifest=verifyRelease(release);
const schema=`release_test_${randomUUID().replaceAll('-','')}`;
const db=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await db.connect();
const temp=mkdtempSync(join(tmpdir(),'conc-liq-release-test-')),envFile=join(temp,'runtime.env');
const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
const env=`DATABASE_URL=${JSON.stringify(url.toString())}\nINDEXER_STREAM_KEY=release-fixture\nRH_INDEXER_RPC_URL=http://127.0.0.1:1\nRH_RPC_URL=http://127.0.0.1:1\n`;
const run=(...args)=>execFileSync(join(release,'bin/node'),[join(release,'launch.mjs'),envFile,...args],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});
try {
 await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path=${schema}`);
 writeFileSync(envFile,env,{mode:0o600});
 run('migrate');
 run('paper','start');
 const row=(await db.query('SELECT * FROM paper_sessions')).rows[0];
 assert.equal(row.runtime_identity.buildId,manifest.buildId);assert.equal(row.runtime_identity.nodeVersion,manifest.nodeVersion);
 run('paper','tick');
 writeFileSync(envFile,env+'RPC_TIMEOUT_MS=12345\n');
 assert.throws(()=>run('paper','tick'),error=>String(error.stdout).includes('runtime differs') || String(error.stderr).includes('runtime differs'));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM paper_execution_runs')).rows[0].n,0);
 writeFileSync(envFile,env);run('paper','stop');
 assert.equal((await db.query('SELECT status FROM paper_sessions')).rows[0].status,'closed');
 assert.equal(realpathSync(join(release,'node_modules/pg/package.json')).startsWith(release+'/'),true);
 assert.equal(readFileSync(join(release,'package.json'),'utf8').includes('conc-liq'),true);
 console.log(JSON.stringify({passed:['sealed release verified','pinned migration runs','session build identity persisted','empty tick uses no RPC','configuration drift rejected','no execution on rejection','paper cancellation works','dependencies copied locally'],buildId:manifest.buildId,isolatedSchemaRemoved:true}));
}finally{await db.query('SET search_path=public');await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.end();rmSync(temp,{recursive:true,force:true});}
