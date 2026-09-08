import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { prepareExitRecovery, evidenceHash } from './paper/recovery.js';
import { NitroPaperExecutor } from './paper/executor.js';
import { loadRuntimeIdentity } from './runtime/identity.js';
import { readPaperChain } from './paper/reentry.js';
import { assertSchemaReady } from './storage/compatibility.js';
import { sanitizeRiskError } from './risk/evaluate.js';

async function main() {
 const [command, sessionId, runId, path] = process.argv.slice(2);
 assert(['audit','apply'].includes(command!) && /^[1-9]\d*$/.test(sessionId!) && /^[1-9]\d*$/.test(runId!) && path,
   'Usage: paper-recover audit|apply SESSION_ID FAILED_EXIT_RUN_ID PLAN_PATH');
 const runtime = loadRuntimeIdentity();assert(runtime, 'Recovery requires a pinned release');
 const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
 const client = await pool.connect(), executor = new NitroPaperExecutor(process.env.DATABASE_URL!);
 try {
  await assertSchemaReady(client);
  await client.query(command === 'apply' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if (command === 'apply') {
   const row = (await client.query('SELECT stream_key FROM paper_sessions WHERE id=$1', [sessionId])).rows[0];assert(row);
   await client.query("SELECT pg_advisory_xact_lock(hashtext('conc-liq-paper'),hashtext($1))", [row.stream_key]);
   await client.query('SELECT id FROM paper_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
  }
  const prepared = await prepareExitRecovery(client, sessionId!, runId!, executor);
  if (command === 'audit') {
   await client.query('COMMIT');
   await writeFile(path, JSON.stringify({ auditedAt: new Date().toISOString(), runtime, ...prepared.basis, basisHash: prepared.basisHash,
     interpretation: 'Acceptance of an already saved, timely exit simulation after source and full inventory reconciliation; not a new past fill. Automatic reentry remains stopped until explicit continuation.' }, null, 2)+'\n', { flag: 'wx' });
   console.log(JSON.stringify({ action: 'audited', sessionId, runId, basisHash: prepared.basisHash, finalCash: prepared.basis.recovered.navQuote, sessionPnl: prepared.basis.recovered.pnlQuote, plan: path }));
   return;
  }
  const plan = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(plan.runtime, runtime);assert.equal(plan.basisHash, prepared.basisHash, 'Recovery evidence changed after audit');
  // Compare the reviewable fields themselves, not only a copied hash string.
  for (const [key, value] of Object.entries(prepared.basis)) assert.equal(evidenceHash(plan[key]), evidenceHash(value), `Plan field changed: ${key}`);
  const repairedAt = new Date().toISOString();
  const state = { ...prepared.basis.recovered, reentryStoppedAt: repairedAt };
  const recovery = { version: 1, repairedAt, runtime, basisHash: prepared.basisHash,
    reason: 'audited_saved_exit_after_preflight_consistency_failure', beforeRun: prepared.run, beforeSession: prepared.session,
    priorObservationHash: evidenceHash(prepared.observation), input: prepared.basis.input };
  const snapshot = { ...prepared.run.snapshot.preflight, recovery };
  // The unique execution key remains intact; the complete original failed row
  // is preserved inside this recovery envelope and in the audit file.
  await client.query("UPDATE paper_execution_runs SET status='succeeded',snapshot=$2 WHERE id=$1", [runId, JSON.stringify(snapshot)]);
  const cp = prepared.basis.input.checkpoint;
  await client.query(`INSERT INTO paper_observations(session_id,checkpoint_id,block_number,block_hash,source_at,action,state,entry_reasons,observed_at)
    VALUES($1,$2,$3,$4,$5,'exit',$6,$7,$8)`, [sessionId,cp.id,cp.block,cp.hash,cp.blockTimestamp,JSON.stringify(state),JSON.stringify(['paper_saved_exit_recovered']),prepared.run.observed_at]);
  await client.query("UPDATE paper_sessions SET state=$2,status='closed',updated_at=clock_timestamp(),heartbeat_at=clock_timestamp(),monitor_reasons=$3 WHERE id=$1",
    [sessionId,JSON.stringify(state),JSON.stringify(['paper_saved_exit_recovered','operator_stopped_paper_reentry'])]);
  await readPaperChain(client, { ...prepared.session, state });
  await client.query('COMMIT');
  console.log(JSON.stringify({ action: 'recovered', repairedAt, sessionId, runId, finalCash: state.navQuote, sessionPnl: state.pnlQuote, reentryStopped: true, executionEligible: false }));
 } catch(error) { await client.query('ROLLBACK');throw error; }
 finally { client.release();await pool.end();await executor.close(); }
}
main().catch(error => { console.error(sanitizeRiskError(error));process.exitCode=1; });
