import assert from "node:assert/strict";
import { continuationPolicy, readPaperChain } from "./reentry.js";
import { assertRuntimeMatches, type RuntimeIdentity } from "../runtime/identity.js";
import pg, { type PoolClient } from "pg";
import { evaluateCanaryEntryReadiness } from "../canary-plan/entry-readiness.js";
import type { RpcHealthEvaluation } from "../rpc-health/domain.js";
import { readRiskGate } from "../risk/gate.js";
import { USDG } from "../constants.js";
import { advancePaper, initialPaperState, invalidatePaper, PAPER_NVDA, PAPER_POOL, paperEntryRange, policyHash, type PaperCheckpoint, type PaperInput, type PaperPolicy, type PaperState, type TransactionPaperPolicy } from "./engine.js";
import type { PaperExecutor } from "./executor.js";
import { sanitizeRiskError } from "../risk/evaluate.js";
import { paperExecutionEvidenceValid } from "./evidence.js";
import { readPaperReferenceGate, PaperReferenceGateError } from "./reference.js";

import { assertSchemaReady } from "../storage/compatibility.js";
import { paperPolicy, paperPolicySchema } from "./config.js";
import { boundaryContinuity, type BoundaryChange, type BoundaryFeeProof } from "./boundary-fees.js";
import { centeredRange } from "../simulator/math.js";
import { sqrtRatioAtTick } from "../backtest/principal.js";
export interface PaperSessionRow {
  id: string; stream_key: string; created_at: Date; updated_at: Date; heartbeat_at: Date | null;
  runtime_identity: RuntimeIdentity | null;
  policy: PaperPolicy; policy_hash: string; state: PaperState; monitor_reasons: string[];
}
interface SourceRow {
  checkpoint: PaperCheckpoint; risk_run_id: string; token0: string; token1: string;
  token_decimals: number | null; pool_unlocked: boolean; status: string; reasons: string[];
  canonical: boolean; covered: boolean; coverage_identity_valid: boolean; asset_reasons: string[] | null;
  asset_eligible: boolean | null; deviation_ppm: string | null;
}
export const sourceSql = `SELECT jsonb_build_object('id',c.id::text,'block',c.block_number::text,
  'hash',c.block_hash,'blockTimestamp',c.block_timestamp,'capturedAt',c.captured_at,
  'tick',p.tick,'sqrtPriceX96',p.sqrt_price_x96::text,'liquidity',p.liquidity::text,
  'feeGrowth0',p.fee_growth_global0_x128::text,'feeGrowth1',p.fee_growth_global1_x128::text,
  'targetSetHash',c.target_set_hash) AS checkpoint,
  c.risk_run_id::text, p.token0,p.token1,p.token_decimals,p.pool_unlocked,p.status,p.reasons,p.deviation_ppm::text,
  a.execution_eligible AS asset_eligible,a.reasons AS asset_reasons,
  (v.canonical IS TRUE AND v.block_number=c.block_number AND LOWER(v.expected_hash)=LOWER(c.block_hash)
    AND LOWER(v.observed_hash)=LOWER(c.block_hash)) AS canonical,
  (i.last_scanned_block>=c.block_number AND r.complete_through_block>=c.block_number
    AND i.chain_id=c.chain_id AND r.chain_id=c.chain_id AND i.target_set_hash=c.target_set_hash
    AND r.target_set_hash=c.target_set_hash AND t.target_set_hash=c.target_set_hash AND t.enabled
    AND t.chain_id=4663 AND t.fee=500 AND LOWER(t.rwa_address)=$2
    AND t.created_block<=c.block_number) AS covered,
  (i.chain_id=c.chain_id AND r.chain_id=c.chain_id AND i.target_set_hash=c.target_set_hash
    AND r.target_set_hash=c.target_set_hash AND t.target_set_hash=c.target_set_hash AND t.enabled
    AND t.chain_id=4663 AND t.fee=500 AND LOWER(t.rwa_address)=$2
    AND t.created_block<=c.block_number) AS coverage_identity_valid
 FROM v3_strategy_checkpoint_runs c JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id=c.id
 LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id
 LEFT JOIN asset_risk_snapshots a ON a.run_id=c.risk_run_id AND a.symbol='NVDA'
 LEFT JOIN indexer_cursors i ON i.stream_key=c.stream_key
 LEFT JOIN v3_replay_cursors r ON r.stream_key=c.stream_key
 LEFT JOIN indexer_pools t ON t.stream_key=c.stream_key AND LOWER(t.pool_address)=$3
 WHERE c.stream_key=$1 AND c.chain_id=4663 AND LOWER(p.pool_address)=$3 AND p.fee=500
   AND p.rwa_symbol='NVDA' AND LOWER(p.rwa_address)=$2`;

export class PaperStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string, private readonly executor?: PaperExecutor, private readonly runtimeIdentity?: RuntimeIdentity) { this.pool = new pg.Pool({ connectionString, max: 1 }); }
  async assertReady() { await assertSchemaReady(this.pool); }
  private async insertSession(client: PoolClient, streamKey: string, policy: PaperPolicy): Promise<string> {
    const state = initialPaperState();
    state.reasons = ["awaiting_first_live_checkpoint"];
    const result = await client.query<{ id: string }>(
      `INSERT INTO paper_sessions(stream_key,policy_hash,policy,state,status,runtime_identity) VALUES($1,$2,$3,$4,'waiting',$5) RETURNING id::text`,
      [streamKey,policyHash(policy),JSON.stringify(policy),JSON.stringify(state),JSON.stringify(this.runtimeIdentity)]);
    return result.rows[0]!.id;
  }
  async start(streamKey: string, policy: PaperPolicy, after?: string): Promise<string> {
    assertRuntimeMatches(this.runtimeIdentity ?? null, this.runtimeIdentity);
    let next = paperPolicy(policy);
    assert(!next.reentry?.previousSessionId, "Use --after to validate carried paper funding");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('conc-liq-paper'),hashtext($1))", [streamKey]);
      const latest = (await client.query<PaperSessionRow>("SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE", [streamKey])).rows[0];
      if (after) {
        assert(latest?.id === after, "Continue only the latest paper session");
        await readPaperChain(client, latest);
        next = continuationPolicy(latest, next);
      }
      const id = await this.insertSession(client, streamKey, next);
      await client.query("COMMIT");
      return id;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  /** Caller holds the stream advisory lock. A stopped/invalid session is terminal. */
  private async maybeReenter(client: PoolClient, streamKey: string) {
    await client.query("BEGIN");
    try {
      const row = (await client.query<PaperSessionRow>("SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE", [streamKey])).rows[0];
      if (!row || row.state.status !== "closed" || row.state.reentryStoppedAt || !("reentry" in row.policy) || !row.policy.reentry) {
        await client.query("COMMIT"); return;
      }
      assertRuntimeMatches(row.runtime_identity, this.runtimeIdentity);
      // Cash conservation and canonical evidence are checked before every successor.
      let next;
      try {
        await readPaperChain(client, row);
        next = continuationPolicy(row, paperPolicySchema.parse(row.policy) as TransactionPaperPolicy);
      } catch (error) {
        row.state.reentryStoppedAt = new Date().toISOString();
        await this.update(client, row.id, row.state, ["paper_reentry_history_or_cash_invalid", sanitizeRiskError(error)]);
        await client.query("COMMIT"); return;
      }
      // The successor's entry gate enforces cooldown and current recovery/reference
      // checks, including after a restart or an explicit continuation.
      await this.insertSession(client, streamKey, next);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  async stop(streamKey: string): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A stop during network preflight must remain possible. Recheck the latest
      // row after acquiring its lock in case a successor was just committed.
      let row: PaperSessionRow | undefined;
      for (;;) {
        row = (await client.query<PaperSessionRow>("SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE",[streamKey])).rows[0];
        const latest = (await client.query<{id:string}>("SELECT id::text FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1",[streamKey])).rows[0];
        if (row?.id === latest?.id) break;
      }
      if (!row) { await client.query("COMMIT"); return null; }
      const now = (await client.query<{ now: Date }>("SELECT NOW() AS now")).rows[0]!.now.toISOString();
      const state = row.state;
      state.reentryStoppedAt = now;
      if (state.status === "closed" || state.status === "invalid") {
        await this.update(client,row.id,state,["operator_stopped_paper_reentry"]);
        await client.query("COMMIT"); return row.id;
      }
      state.status = state.position ? "exit_pending" : "closed";
      state.action = state.position ? "signal_exit" : "wait";
      state.pendingSince = state.position ? now : null;
      state.reasons = [state.position ? "operator_requested_paper_exit" : "paper_session_cancelled_before_entry"];
      await this.update(client,row.id,state,[]);
      await client.query("COMMIT"); return row.id;
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async tick(streamKey: string): Promise<{ id: string; status: string; action: string; reasons: readonly string[] } | null> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext('conc-liq-paper'),hashtext($1)) AS locked",[streamKey])).rows[0]!.locked;
      if (!locked) return null;
      await this.maybeReenter(client, streamKey);
      // Bounded boundary reads happen before the DB transaction, under the
      // session advisory lock. Main selection below revalidates source/state.
      let feeProof: BoundaryFeeProof | undefined;
      const preview=(await client.query<PaperSessionRow>("SELECT * FROM paper_sessions WHERE stream_key=$1 AND status NOT IN ('closed','invalid') ORDER BY id LIMIT 1",[streamKey])).rows[0];
      if(preview&&"feeAccounting" in preview.policy&&preview.policy.feeAccounting){
        assertRuntimeMatches(preview.runtime_identity,this.runtimeIdentity);
        const range=preview.state.position??preview.state.entryRange;
        if(range){
          const source=(await client.query<SourceRow>(`${sourceSql}
            AND c.captured_at >= $4 AND c.block_timestamp >= $4
            AND NOT EXISTS (SELECT 1 FROM paper_observations o WHERE o.session_id=$5 AND o.checkpoint_id=c.id)
            AND NOT EXISTS (SELECT 1 FROM paper_execution_runs x WHERE x.session_id=$5 AND x.checkpoint_id=c.id AND x.status='failed' AND x.snapshot->>'error'='paper_event_coverage_deferred')
            AND c.block_number > $6 ORDER BY c.block_number,c.id LIMIT 1`,
            [preview.stream_key,PAPER_NVDA,PAPER_POOL,preview.created_at,preview.id,preview.state.last?.block??"0"])).rows[0];
          if(source?.covered===true&&source.canonical===true){
            try{
              if(!this.executor?.boundaryFees)throw new Error("Paper boundary reader unavailable");
              feeProof=await this.executor.boundaryFees(source.checkpoint,range);
            }catch(error){
              const reason=sanitizeRiskError(error);
              if((Date.now()-Date.parse(source.checkpoint.blockTimestamp))/1000<=preview.policy.maxSourceAgeSeconds){
              await client.query("UPDATE paper_sessions SET heartbeat_at=clock_timestamp(),monitor_reasons=$2 WHERE id=$1",[preview.id,JSON.stringify(["awaiting_boundary_fee_evidence",reason])]);
              return {id:preview.id,status:preview.state.status,action:"wait",reasons:["awaiting_boundary_fee_evidence",reason]};
              }
            }
          }
        }
      }
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const sessions = await client.query<PaperSessionRow>(
        `SELECT * FROM paper_sessions WHERE stream_key=$1 AND status NOT IN ('closed','invalid') ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [streamKey]);
      const session = sessions.rows[0];
      if (!session) { await client.query("COMMIT"); return null; }
      const now = (await client.query<{ now: Date }>("SELECT NOW() AS now")).rows[0]!.now.toISOString();
      assertRuntimeMatches(session.runtime_identity, this.runtimeIdentity);
      session.policy = paperPolicySchema.parse(session.policy);
      if (policyHash(session.policy) !== session.policy_hash) throw new Error("Stored paper policy hash mismatch");
      if ("executionBasis" in session.policy && session.policy.executionBasis === "nitro_fork_v1" &&
        !(await paperExecutionEvidenceValid(client, session))) {
        session.state = invalidatePaper(session.state, now, ["paper_execution_evidence_invalid"]);
        await this.update(client, session.id, session.state, session.state.reasons);
        await client.query("COMMIT");
        return { id: session.id, status: session.state.status, action: session.state.action, reasons: session.state.reasons };
      }
      if ("reentry" in session.policy && session.policy.reentry?.previousSessionId) {
        try { await readPaperChain(client, session); }
        catch {
          session.state = invalidatePaper(session.state, now, ["paper_continuation_history_invalid"]);
          await this.update(client, session.id, session.state, session.state.reasons);
          await client.query("COMMIT");
          return { id: session.id, status: "invalid", action: "invalidate", reasons: session.state.reasons };
        }
      }
      // Preserve the journal on reorgs; revoke the result rather than rewriting it.
      const invalidSql = `SELECT COUNT(*)::text AS invalid FROM paper_observations o
         LEFT JOIN v3_strategy_checkpoint_runs c ON c.id=o.checkpoint_id
         LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id
         WHERE o.session_id=$1 AND (c.id IS NULL OR v.canonical IS DISTINCT FROM TRUE
           OR c.block_number IS DISTINCT FROM o.block_number OR LOWER(c.block_hash) IS DISTINCT FROM LOWER(o.block_hash)
           OR v.block_number IS DISTINCT FROM o.block_number OR LOWER(v.expected_hash) IS DISTINCT FROM LOWER(o.block_hash)
           OR LOWER(v.observed_hash) IS DISTINCT FROM LOWER(o.block_hash))`;
      const invalid = await client.query<{ invalid: string }>(invalidSql, [session.id]);
      if (invalid.rows[0]!.invalid !== "0") {
        session.state = invalidatePaper(session.state, now, ["prior_paper_source_no_longer_canonical"]);
        await this.update(client, session.id, session.state, session.state.reasons);
        await client.query("COMMIT");
        return { id: session.id, status: session.state.status, action: session.state.action, reasons: session.state.reasons };
      }
      const source = (await client.query<SourceRow>(`${sourceSql}
        AND c.captured_at >= $4 AND c.block_timestamp >= $4
        AND NOT EXISTS (SELECT 1 FROM paper_observations o WHERE o.session_id=$5 AND o.checkpoint_id=c.id)
            AND NOT EXISTS (SELECT 1 FROM paper_execution_runs x WHERE x.session_id=$5 AND x.checkpoint_id=c.id AND x.status='failed' AND x.snapshot->>'error'='paper_event_coverage_deferred')
        AND c.block_number > $6 ORDER BY c.block_number,c.id LIMIT 1`,
        [session.stream_key,PAPER_NVDA,PAPER_POOL,session.created_at,session.id,session.state.last?.block ?? "0"])).rows[0];
      if (!source) {
        await client.query("UPDATE paper_sessions SET heartbeat_at=NOW(),monitor_reasons=$2 WHERE id=$1",[session.id,JSON.stringify(["awaiting_next_live_checkpoint"])]);
        await client.query("COMMIT");
        return { id: session.id, status: session.state.status, action: "wait", reasons: ["awaiting_next_live_checkpoint"] };
      }
      const cp = source.checkpoint;
      if(feeProof&&(feeProof.block!==cp.block||feeProof.hash.toLowerCase()!==cp.hash.toLowerCase()))feeProof=undefined;
      const dataReasons: string[] = [];
      if (source.canonical !== true) dataReasons.push("checkpoint_canonicality_unproven");
      if (source.covered !== true) {
        // The indexer may still be catching up to this freshly collected checkpoint.
        await client.query("UPDATE paper_sessions SET heartbeat_at=NOW(),monitor_reasons=$2 WHERE id=$1",[session.id,JSON.stringify(["awaiting_canonical_event_coverage"])]);
        await client.query("COMMIT"); return { id: session.id, status: session.state.status, action: "wait", reasons: ["awaiting_canonical_event_coverage"] };
      }
      if (source.token0.toLowerCase() !== USDG.toLowerCase() || source.token1.toLowerCase() !== PAPER_NVDA || source.token_decimals !== 18) dataReasons.push("paper_token_identity_mismatch");
      const health = await client.query<{ id: string; snapshot: RpcHealthEvaluation }>(`SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at >= NOW()-INTERVAL '6 minutes' ORDER BY observed_at DESC,id DESC LIMIT 128`);
      const readiness = evaluateCanaryEntryReadiness({ now, sourceBlock: BigInt(cp.block), samples: health.rows });
      if (readiness.reasons.includes("source_ahead_of_confirmed_quorum")) {
        // A just-collected snapshot can precede the next health poll's anchor.
        // Leave it unconsumed so the following tick can use it after confirmation.
        await client.query("UPDATE paper_sessions SET heartbeat_at=clock_timestamp(),monitor_reasons=$2 WHERE id=$1",
          [session.id, JSON.stringify(["awaiting_checkpoint_confirmation"])]);
        await client.query("COMMIT");
        return { id: session.id, status: session.state.status, action: "wait", reasons: ["awaiting_checkpoint_confirmation"] };
      }
      const risk = await readRiskGate(client, session.stream_key, 180, 30, "NVDA");
      const residual = (reasons: readonly string[]) => reasons.filter(r => !(r === "sequencer_feed_unavailable" && readiness.chainEligible));
      let entryReasons = [...readiness.reasons, ...residual(risk.reasons), ...source.reasons,
        ...residual(source.asset_reasons ?? ["asset_risk_missing"])];
      if (source.asset_eligible !== true && source.asset_reasons?.length === 0) entryReasons.push("asset_risk_ineligible");
      if (!source.pool_unlocked) entryReasons.push("pool_locked");
      if (source.status !== "valid") entryReasons.push("pool_reference_excluded");
      if (source.risk_run_id !== risk.snapshotId) entryReasons.push("checkpoint_not_latest_risk_snapshot");
      if (source.deviation_ppm === null || BigInt(source.deviation_ppm) > 5000n || BigInt(source.deviation_ppm) < -5000n) entryReasons.push("oracle_deviation_over_0_5_percent_or_unavailable");
      let reference = null;
      let referenceEvidence;
      if ("referencePolicy" in session.policy && session.policy.referencePolicy) {
        const gate = await readPaperReferenceGate(client, cp, session.policy.referencePolicy, now);
        reference = gate.reference;
        referenceEvidence = gate.evidence;
        entryReasons = [...readiness.reasons.filter(r => !r.startsWith("equity_session_")), ...gate.reasons];
        if (!source.pool_unlocked) entryReasons.push("pool_locked");
        entryReasons.push(...source.reasons.filter(r => !["rwa_oracle_price_stale", "quote_oracle_price_stale"].includes(r)));
        if("feeAccounting" in session.policy&&session.policy.feeAccounting&&reference?.referencePriceX18){
          const range=session.state.position??session.state.entryRange??paperEntryRange(cp,session.policy);
          const ref=BigInt(reference.referencePriceX18),bound=BigInt(session.policy.referencePolicy.maxDeviationPpm);
          for(const tick of [range.tickLower,range.tickUpper]){
            const price=(1n<<192n)*10n**30n/sqrtRatioAtTick(tick)**2n;
            if(price*1000000n<ref*(1000000n-bound)||price*1000000n>ref*(1000000n+bound)){entryReasons.push("paper_range_reference_band_exceeded");break;}
          }
        }
      }
      if (!session.state.position && "reentry" in session.policy && session.policy.reentry?.previousSessionId) {
        const exited = (await client.query<{at:Date|null}>("SELECT MAX(observed_at) AS at FROM paper_observations WHERE session_id=$1 AND action='exit'", [session.policy.reentry.previousSessionId])).rows[0]?.at;
        if (!exited || !Number.isFinite(exited.getTime()) ||
          Date.parse(cp.blockTimestamp) < exited.getTime() + session.policy.reentry.cooldownSeconds * 1000) {
          entryReasons.push("paper_reentry_cooldown");
        }
      }
      const path = await client.query<{ minimum: number | null; maximum: number | null; count: string }>(
        `SELECT MIN((event_args->>'tick')::int) AS minimum,MAX((event_args->>'tick')::int) AS maximum,COUNT(*)::text AS count
         FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4 AND event_name='Swap'`,
        [session.stream_key,PAPER_POOL,session.state.last?.block ?? cp.block,cp.block]);
      const swaps = path.rows[0]!;
      let feeContinuity=false;
      if(feeProof&&session.state.position?.boundaryFees){
        const changes=await client.query<BoundaryChange>(`SELECT event_name AS "eventName",event_args AS args FROM v3_pool_events
          WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4
          AND event_name IN ('Mint','Burn') ORDER BY block_number,transaction_index,log_index`,
          [session.stream_key,PAPER_POOL,session.state.last!.block,cp.block]);
        feeContinuity=boundaryContinuity(session.state.position.boundaryFees,feeProof,changes.rows);
      }
      const input: PaperInput = { now, checkpoint: cp, dataReasons,
        entryReasons: [...new Set(entryReasons)], chainHealthy: readiness.chainEligible,
        pathMinTick: Math.min(session.state.last?.tick ?? cp.tick,cp.tick,swaps.minimum ?? cp.tick),
        pathMaxTick: Math.max(session.state.last?.tick ?? cp.tick,cp.tick,swaps.maximum ?? cp.tick), swapCount: swaps.count,
        execution: { available: this.executor !== undefined }, reference, referenceEvidence, boundaryFees:feeProof,boundaryContinuity:feeContinuity };
      let state = advancePaper(session.state, session.policy, input);
      if (this.executor && "executionBasis" in session.policy && session.policy.executionBasis === "nitro_fork_v1") {
        const action = state.reasons.includes("paper_entry_quote_required") ? "quote"
          : state.reasons.includes("paper_entry_simulation_required") ? "entry"
          : state.reasons.includes("paper_exit_simulation_required") ? "exit" : null;
        if (action) {
          // Keep only the session advisory lock while doing network work. A
          // database read transaction here can block scheduled migrations and
          // then deadlock our independent current-risk preflight behind them.
          await client.query("COMMIT");
          let evidence: unknown;
          let status = "succeeded";
          let execution: NonNullable<PaperInput["execution"]> = { available: true };
          try {
            if (action === "quote") {
              evidence = execution.quote = await this.executor.quote(cp, session.policy);
            } else if (action === "entry") {
              const result = await this.executor.enter(cp, session.policy, state.execution!.intent!);
              evidence = result; execution.entry = { runId: "pending", ...result };
            } else {
              const p = state.position!;
              const result = await this.executor.exit(cp, session.policy, { ...p, allowances: state.execution!.allowances,
                nativeBalanceWei: String(10n ** 18n - BigInt(state.execution!.gasSpentWei)) });
              evidence = result; execution.exit = { runId: "pending", ...result };
            }
          } catch (error) {
            status = "failed"; execution = { available: true, error: sanitizeRiskError(error) };
            evidence = { error: execution.error, ...(error instanceof PaperReferenceGateError ? {referenceGate:error.gate} : {}) };
          }
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await client.query("SET LOCAL statement_timeout = '10s'");
          const current = (await client.query<PaperSessionRow>("SELECT * FROM paper_sessions WHERE id=$1 FOR UPDATE",[session.id])).rows[0]!;
          const changed = current.runtime_identity?.buildId !== this.runtimeIdentity?.buildId ||
            current.runtime_identity?.configHash !== this.runtimeIdentity?.configHash ||
            current.runtime_identity?.nodeVersion !== this.runtimeIdentity?.nodeVersion || current.policy_hash !== session.policy_hash || JSON.stringify(current.state) !== JSON.stringify(session.state);
          const renewed = (await client.query<SourceRow>(`${sourceSql} AND c.id=$4`,[session.stream_key,PAPER_NVDA,PAPER_POOL,cp.id])).rows[0];
          const invalidHistory = (await client.query<{invalid:string}>(invalidSql,[session.id])).rows[0]!.invalid !== "0";
          let ancestryInvalid = false;
          if ("reentry" in session.policy && session.policy.reentry?.previousSessionId) {
            try { await readPaperChain(client, session); } catch { ancestryInvalid = true; }
          }
          const sourceChanged = ancestryInvalid || !renewed || renewed.canonical !== true || renewed.coverage_identity_valid !== true ||
            renewed.checkpoint.block !== cp.block || renewed.checkpoint.hash.toLowerCase() !== cp.hash.toLowerCase() || invalidHistory;
          const coverageDeferred = !changed && !sourceChanged && renewed?.covered !== true;
          if (coverageDeferred) {
            status = "failed";
            evidence = { preflight: evidence, error: "paper_event_coverage_deferred" };
          }
          if (changed || sourceChanged) {
            status = "failed";
            evidence = { preflight: evidence, error: changed ? "paper_session_changed_during_preflight" : "paper_source_changed_during_preflight",
              checks: { ancestryInvalid, sourcePresent: !!renewed, canonical: renewed?.canonical, coverageIdentityValid: renewed?.coverage_identity_valid,
                covered: renewed?.covered, blockMatches: renewed?.checkpoint.block === cp.block,
                hashMatches: renewed?.checkpoint.hash.toLowerCase() === cp.hash.toLowerCase(), invalidHistory } };
          }
          const saved = await client.query<{ id: string }>(`INSERT INTO paper_execution_runs
            (session_id,checkpoint_id,source_block,source_hash,policy_hash,action,status,snapshot,runtime_identity)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
            [session.id,cp.id,cp.block,cp.hash,session.policy_hash,action,status,JSON.stringify(evidence),JSON.stringify(this.runtimeIdentity)]);
          if (coverageDeferred) {
            // Overlap rescans temporarily retract event coverage. Discard this
            // unaccepted simulation without changing balances or consuming the
            // source. The next fresh checkpoint accounts for the entire interval.
            await client.query("UPDATE paper_sessions SET heartbeat_at=clock_timestamp(),monitor_reasons=$2 WHERE id=$1",
              [session.id, JSON.stringify(["paper_event_coverage_deferred"])]);
            await client.query("COMMIT");
            return { id: session.id, status: session.state.status, action: "wait", reasons: ["paper_event_coverage_deferred"] };
          }
          if (changed || sourceChanged) {
            const next = changed ? current.state : invalidatePaper(session.state,new Date().toISOString(),["paper_source_changed_during_preflight"]);
            if (!changed) await this.update(client,session.id,next,next.reasons);
            await client.query("COMMIT");
            return {id:session.id,status:next.status,action:next.action,reasons:next.reasons};
          }
          if (execution.entry) execution.entry.runId = saved.rows[0]!.id;
          if (execution.exit) execution.exit.runId = saved.rows[0]!.id;
          state = advancePaper(session.state, session.policy, { ...input, now: new Date().toISOString(), execution });
        }
      }
      await client.query(`INSERT INTO paper_observations(session_id,checkpoint_id,block_number,block_hash,source_at,action,state,entry_reasons,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,[session.id,cp.id,cp.block,cp.hash,cp.blockTimestamp,state.action,JSON.stringify(state),JSON.stringify([...new Set(entryReasons)])]);
      await this.update(client, session.id, state, []);
      await client.query("COMMIT");
      return { id: session.id, status: state.status, action: state.action, reasons: state.reasons };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally {
      try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('conc-liq-paper'),hashtext($1))",[streamKey]); }
      finally { client.release(); }
    }
  }
  private async update(client: PoolClient, id: string, state: PaperState, monitorReasons: readonly string[]) {
    await client.query("UPDATE paper_sessions SET state=$2,status=$3,updated_at=clock_timestamp(),heartbeat_at=clock_timestamp(),monitor_reasons=$4 WHERE id=$1",[id,JSON.stringify(state),state.status,JSON.stringify(monitorReasons)]);
  }
  async close() { await this.pool.end(); }
}
