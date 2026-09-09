import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { USDG } from '../constants.js';
import type { PoolClient } from 'pg';
import { advancePaper, invalidatePaper, PAPER_NVDA, PAPER_POOL, policyHash, type PaperState, type TransactionPaperPolicy, type PaperInput } from './engine.js';
import { paperPolicySchema } from './config.js';
import { readPaperChain, closedPaperCash } from './reentry.js';
import { sourceSql, type PaperSessionRow } from './store.js';
import { boundaryContinuity, type BoundaryChange } from './boundary-fees.js';
import { evaluateCanaryEntryReadiness } from '../canary-plan/entry-readiness.js';
import { evaluatePaperReference } from './reference.js';
import type { RpcHealthEvaluation } from '../rpc-health/domain.js';
import type { PaperExecutor } from './executor.js';

export const evidenceHash = (value: unknown): string => {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? v instanceof Date ? v.toISOString() : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};

/** Reconcile an already recorded timely exit, never simulate a missed past order. */
export function reconcileRecordedExit(session: PaperSessionRow, previous: PaperState, run: any, input: PaperInput) {
  assert.equal(session.state.status, 'invalid');
  assert.deepEqual(session.state.reasons, ['paper_source_changed_during_preflight']);
  assert.deepEqual(session.state, invalidatePaper(previous, session.state.invalidatedAt!, session.state.reasons), 'Invalid state differs from the last accepted ledger');
  assert.equal(previous.status, 'exit_pending');assert(previous.pendingSince && previous.position && previous.execution?.entryRunId);
  assert.equal(run.session_id, session.id);assert.equal(run.action, 'exit');assert.equal(run.status, 'failed');
  assert.equal(run.snapshot.error, 'paper_source_changed_during_preflight');
  assert.equal(run.policy_hash, session.policy_hash);assert.deepEqual(run.runtime_identity, session.runtime_identity);
  const policy = paperPolicySchema.parse(session.policy) as TransactionPaperPolicy;
  assert.equal(policyHash(policy), session.policy_hash);assert.equal(policy.executionBasis, 'nitro_fork_v1');
  assert.equal(policy.feeAccounting, 'initialized_boundaries_v1');
  const saved = run.snapshot.preflight, r = saved?.result;
  assert(r && saved.valuation && r.executionEligible === false && r.scope === 'paper_restored_position_exit');
  assert.equal(policyHash(paperPolicySchema.parse(r.policy)), session.policy_hash);
  assert.equal(r.source.block, run.source_block);assert.equal(r.source.hash.toLowerCase(), run.source_hash.toLowerCase());
  assert.equal(input.checkpoint.id, run.checkpoint_id);assert.equal(input.now, new Date(run.observed_at).toISOString());
  assert(Date.parse(r.computedAt) >= Date.parse(input.checkpoint.blockTimestamp) && Date.parse(r.computedAt) <= Date.parse(input.now));
  assert(input.chainHealthy && input.dataReasons.length === 0 && input.boundaryContinuity === true);
  assert(Date.parse(input.checkpoint.blockTimestamp) > Date.parse(previous.pendingSince), 'Exit must follow its recorded signal');
  assert(BigInt(r.balances.afterExit.quote) > 0n && r.balances.afterExit.rwa === '0');
  assert.equal(r.inventory.nativeBalanceWei, String(10n**18n - BigInt(previous.execution.gasSpentWei)));
  assert.deepEqual(r.inventory.allowances, previous.execution.allowances);
  assert(r.transactions.length > 0 && r.transactions.every((tx:any) => tx.sourceBlock === run.source_block && tx.sourceHash.toLowerCase() === run.source_hash.toLowerCase()));
  assert.equal(String(r.transactions.reduce((n:bigint,tx:any) => n + BigInt(tx.estimate.totalFeeWei), 0n)), r.totalGasWei);
  const marked = advancePaper(previous, policy, { ...input, execution: { available: true } });
  assert.equal(marked.status, 'exit_pending');assert(marked.reasons.includes('paper_exit_simulation_required'));
  const { allowances, nativeBalanceWei, ...recordedInventory } = r.inventory;
  assert.deepEqual(marked.position, recordedInventory, 'Recorded exit inventory does not reconcile with the fee ledger');
  const recovered = advancePaper(previous, policy, { ...input, execution: { available: true, exit: { runId: run.id, ...saved } } });
  assert.equal(recovered.status, 'closed');assert.equal(recovered.action, 'exit');
  closedPaperCash({ ...session, policy, state: recovered });
  return recovered;
}

export async function prepareExitRecovery(client: PoolClient, sessionId: string, runId: string, executor: Pick<PaperExecutor, 'boundaryFees'>) {
  const session = (await client.query<PaperSessionRow>('SELECT * FROM paper_sessions WHERE id=$1', [sessionId])).rows[0];assert(session);
  const latest = (await client.query('SELECT id::text FROM paper_sessions WHERE stream_key=$1 ORDER BY paper_sessions.id DESC LIMIT 1', [session.stream_key])).rows[0];assert.equal(latest.id, session.id, 'Only the latest session can be recovered');
  const run = (await client.query('SELECT * FROM paper_execution_runs WHERE id=$1', [runId])).rows[0];assert(run);
  const observation = (await client.query('SELECT * FROM paper_observations WHERE session_id=$1 ORDER BY id DESC LIMIT 1', [sessionId])).rows[0];assert(observation);
  const previous = observation.state as PaperState;
  const chain = await readPaperChain(client, { ...session, state: previous });
  const source = (await client.query(`${sourceSql} AND c.id=$4`, [session.stream_key, PAPER_NVDA, PAPER_POOL, run.checkpoint_id])).rows[0];
  assert(source?.canonical === true && source.covered === true && source.pool_unlocked === true, 'Exit source is not covered and canonical');
  assert.equal(source.token0.toLowerCase(), USDG.toLowerCase());assert.equal(source.token1.toLowerCase(), PAPER_NVDA);assert.equal(source.token_decimals, 18);
  const cp = source.checkpoint;
  assert(cp.block === run.source_block && cp.hash.toLowerCase() === run.source_hash.toLowerCase());
  assert.equal((await client.query('SELECT count(*)::int AS n FROM paper_observations WHERE session_id=$1 AND checkpoint_id=$2', [sessionId, cp.id])).rows[0].n, 0);
  // Corroborate the stored boundary proof against the current node's historical block.
  assert(executor.boundaryFees);const proof = await executor.boundaryFees(cp, previous.position!);
  assert.deepEqual(proof, run.snapshot.preflight.result.inventory.boundaryFees);
  const changes = (await client.query<BoundaryChange>(`SELECT event_name AS "eventName",event_args AS args FROM v3_pool_events WHERE stream_key=$1 AND lower(pool_address)=$2 AND block_number>$3 AND block_number<=$4 AND event_name IN ('Mint','Burn') ORDER BY block_number,transaction_index,log_index`, [session.stream_key, PAPER_POOL, previous.last!.block, cp.block])).rows;
  const swaps = (await client.query(`SELECT min((event_args->>'tick')::int) AS minimum,max((event_args->>'tick')::int) AS maximum,count(*)::text AS count FROM v3_pool_events WHERE stream_key=$1 AND lower(pool_address)=$2 AND block_number>$3 AND block_number<=$4 AND event_name='Swap'`, [session.stream_key, PAPER_POOL, previous.last!.block, cp.block])).rows[0];
  const now = new Date(run.observed_at).toISOString();
  const health = (await client.query<{id:string;snapshot:RpcHealthEvaluation}>(`SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at >= $1::timestamptz-interval '6 minutes' AND observed_at <= $1 ORDER BY observed_at,id`, [now])).rows;
  const readiness = evaluateCanaryEntryReadiness({ now, sourceBlock: BigInt(cp.block), samples: health });assert(readiness.chainEligible, readiness.reasons.join(', '));
  const risk = (await client.query('SELECT snapshot FROM risk_snapshot_runs WHERE id=$1', [source.risk_run_id])).rows[0];
  const policy = session.policy as TransactionPaperPolicy;
  const reference = policy.referencePolicy ? evaluatePaperReference({ snapshot: risk.snapshot, checkpoint: cp, policy: policy.referencePolicy }) : null;
  const input: PaperInput = { now, checkpoint: cp, dataReasons: [], entryReasons: reference?.reasons ?? [], chainHealthy: true,
    pathMinTick: Math.min(previous.last!.tick, cp.tick, swaps.minimum ?? cp.tick), pathMaxTick: Math.max(previous.last!.tick, cp.tick, swaps.maximum ?? cp.tick), swapCount: swaps.count,
    reference, boundaryFees: proof, boundaryContinuity: boundaryContinuity(previous.position!.boundaryFees!, proof, changes), execution: { available: true } };
  const recovered = reconcileRecordedExit(session, previous, run, input);
  const basis = { sessionId, runId, sessionHash: evidenceHash(session), runHash: evidenceHash(run), observationHash: evidenceHash(observation), ancestorHashes: chain.slice(0,-1).map(evidenceHash), healthEvidenceHash: evidenceHash(health), healthSampleIds: health.map(s=>s.id), input, recovered };
  return { basis, basisHash: evidenceHash(basis), session, run, observation };
}
