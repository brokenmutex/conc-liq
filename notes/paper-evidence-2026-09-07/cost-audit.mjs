import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { readPaperReceiptCosts } from '../../src/dashboard/paper-costs.ts';
import { PaperStore } from '../../src/paper/store.ts';
import { PAPER_POOL, DEFAULT_PAPER_POLICY } from '../../src/paper/engine.ts';
const schema = `paper_cost_audit_${process.pid}_${Date.now()}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
let store;
await client.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path=${schema}`);
  assert.deepEqual(await readPaperReceiptCosts(client, 'fixture'), []);
  await client.query(`CREATE TABLE v3_action_cost_observations (
    stream_key text,chain_id int,pool_addresses jsonb,action_class text,
    transaction_hash text,block_hash text,block_number numeric,total_fee_wei numeric,observed_at timestamptz)`);
  await client.query(`CREATE TABLE v3_pool_events (
    stream_key text,pool_address text,transaction_hash text,block_hash text,block_number numeric,chain_id int)`);
  const fixture = async (hash, { stream='fixture', chain=4663, pool=PAPER_POOL, blockHash='0xAA', indexedHash=blockHash, fee='100' }={}) => {
    await client.query(`INSERT INTO v3_action_cost_observations VALUES($1,$2,$3,'mint_bundle',$4,$5,100,$6,NOW())`,
      [stream,chain,JSON.stringify([pool]),hash,blockHash,fee]);
    await client.query(`INSERT INTO v3_pool_events VALUES($1,$2,$3,$4,100,$5)`,[stream,pool,hash,indexedHash,chain]);
  };
  await fixture('0x01');
  await fixture('0x02', { fee: '900719925474099312345', indexedHash: '0xaa' });
  await fixture('0x03', { indexedHash: '0xBB' });
  await fixture('0x04', { chain: 1 });
  await fixture('0x05', { stream: 'different' });
  await fixture('0x06', { pool: '0xother' });
  // Multiple pool events must not multiply the same transaction charge.
  await client.query(`INSERT INTO v3_pool_events SELECT * FROM v3_pool_events WHERE transaction_hash='0x01'`);
  const costs = await readPaperReceiptCosts(client, 'fixture');
  assert.equal(costs.length, 1);
  assert.equal(costs[0].transactions, '2');
  assert.equal(costs[0].minFeeWei, '100');
  assert.equal(costs[0].maxFeeWei, '900719925474099312345');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  store = new PaperStore(url.toString());
  await store.migrate();
  await assert.rejects(store.start('fixture', {
    ...DEFAULT_PAPER_POLICY, entryCostQuote: '1', exitCostQuote: '1', slippageBps: 10,
  }));
  const id = await store.start('fixture', DEFAULT_PAPER_POLICY);
  const session = (await client.query('SELECT * FROM paper_sessions WHERE id=$1',[id])).rows[0];
  assert.equal(session.state.position, null);
  assert.equal(session.state.pnlQuote, null);
  assert.ok(session.state.reasons.includes('paper_transaction_simulation_unavailable'));
  assert.equal(session.policy.entryCostQuote, undefined);
  assert.equal(session.policy.exitCostQuote, undefined);
  assert.equal(session.policy.slippageBps, undefined);
  await store.stop('fixture');
  const result = { observedAt: new Date().toISOString(), passed: [
    'absent receipt data stays unavailable',
    'pool, chain and stream scoped actual costs',
    'mismatched indexed block hash excluded',
    'case insensitive hash match and no event fanout double count',
    'wei values retain integer precision',
    'new sessions reject illustrative cost fields',
    'new session exposes missing simulation without a position or PnL',
  ], isolatedSchemaRemoved: true };
  await writeFile(new URL('cost-audit.json',import.meta.url), JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  await store?.close();
  await client.query('SET search_path=public');
  await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await client.end();
}
