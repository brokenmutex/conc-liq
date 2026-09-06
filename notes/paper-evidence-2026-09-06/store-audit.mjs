import assert from 'node:assert/strict';
import pg from 'pg';
import { PaperStore } from '../../src/paper/store.ts';
import { DEFAULT_PAPER_POLICY, initialPaperState } from '../../src/paper/engine.ts';
const database = process.env.DATABASE_URL;
const schema = `paper_audit_${process.pid}_${Date.now()}`;
const client = new pg.Client({ connectionString: database });
await client.connect();
let store;
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database);
  url.searchParams.set('options', `-c search_path=${schema}`);
  store = new PaperStore(url.toString());
  await store.migrate();
  const id = await store.start('paper-audit-fixture', DEFAULT_PAPER_POLICY);
  await assert.rejects(store.start('paper-audit-fixture', DEFAULT_PAPER_POLICY), /duplicate key/);
  await store.close();
  url.searchParams.set('options', `-c search_path=${schema},public`);
  store = new PaperStore(url.toString());
  assert.equal((await store.tick('paper-audit-fixture')).status, 'waiting');
  assert.equal((await store.tick('paper-audit-fixture')).status, 'waiting');
  assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM ${schema}.paper_observations`)).rows[0].n, 0);
  assert.equal(await store.stop('paper-audit-fixture'), id);
  let row = (await client.query(`SELECT * FROM ${schema}.paper_sessions WHERE id=$1`,[id])).rows[0];
  assert.equal(row.status, 'closed'); assert.equal(row.state.navQuote,null);
  const next = await store.start('paper-audit-fixture', DEFAULT_PAPER_POLICY);
  const state = { ...initialPaperState(), status:'open', position:{ liquidity:'1', tickLower:-10, tickUpper:10, idle0:'1000000',idle1:'0',fee0:'0',fee1:'0',hold0:'1',hold1:'1',enteredAt:new Date().toISOString() } };
  await client.query(`UPDATE ${schema}.paper_sessions SET status='open',state=$2 WHERE id=$1`,[next,JSON.stringify(state)]);
  assert.equal(await store.stop('paper-audit-fixture'),next);
  row = (await client.query(`SELECT * FROM ${schema}.paper_sessions WHERE id=$1`,[next])).rows[0];
  assert.equal(row.status,'exit_pending'); assert.ok(row.state.pendingSince);
  assert.equal(row.state.costsPaidQuote,'0');
  // An incomplete canonicality proof must invalidate an earlier result, even
  // if its canonical flag was accidentally left true. All rows are isolated.
  await client.query(`CREATE TABLE ${schema}.v3_strategy_checkpoint_runs(id bigint,risk_run_id bigint,block_number numeric,block_hash text)`);
  await client.query(`CREATE TABLE ${schema}.risk_snapshot_canonicality(risk_run_id bigint,canonical boolean,block_number numeric,expected_hash text,observed_hash text)`);
  await client.query(`INSERT INTO ${schema}.v3_strategy_checkpoint_runs VALUES(1,1,100,'0x11')`);
  await client.query(`INSERT INTO ${schema}.risk_snapshot_canonicality VALUES(1,true,100,'0x11',NULL)`);
  await client.query(`INSERT INTO ${schema}.paper_observations(session_id,checkpoint_id,block_number,block_hash,source_at,action,state,entry_reasons) VALUES($1,1,100,'0x11',NOW(),'mark',$2,'[]')`,[next,JSON.stringify({...state,navQuote:'100',pnlQuote:'1'})]);
  const invalid=await store.tick('paper-audit-fixture');
  assert.equal(invalid.status,'invalid');
  row=(await client.query(`SELECT state FROM ${schema}.paper_sessions WHERE id=$1`,[next])).rows[0];
  assert.equal(row.state.navQuote,null);
  console.log(JSON.stringify({ passed:['one active session per stream','JSON policy survives database serialization and worker restart','no historical fill or duplicate journal on idle ticks','stop before entry closes without invented PnL','stop after entry requests a later exit without charging early','missing canonical hash revokes the recorded result'], fixtureSchemaRemoved:true }));
} finally {
  await store?.close();
  await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await client.end();
}
