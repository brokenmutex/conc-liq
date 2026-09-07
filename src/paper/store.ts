import pg, { type PoolClient } from "pg";
import { evaluateCanaryEntryReadiness } from "../canary-plan/entry-readiness.js";
import type { RpcHealthEvaluation } from "../rpc-health/domain.js";
import { readRiskGate } from "../risk/gate.js";
import { USDG } from "../constants.js";
import { advancePaper, initialPaperState, invalidatePaper, PAPER_NVDA, PAPER_POOL, policyHash, type PaperCheckpoint, type PaperInput, type PaperPolicy, type PaperState } from "./engine.js";
import type { PaperExecutor } from "./executor.js";
import { sanitizeRiskError } from "../risk/evaluate.js";
import { paperExecutionEvidenceValid } from "./evidence.js";

import { PAPER_SCHEMA_SQL } from "./schema.js";
import { paperPolicy, paperPolicySchema } from "./config.js";
export interface PaperSessionRow {
  id: string; stream_key: string; created_at: Date; updated_at: Date; heartbeat_at: Date | null;
  policy: PaperPolicy; policy_hash: string; state: PaperState; monitor_reasons: string[];
}
interface SourceRow {
  checkpoint: PaperCheckpoint; risk_run_id: string; token0: string; token1: string;
  token_decimals: number | null; pool_unlocked: boolean; status: string; reasons: string[];
  canonical: boolean; covered: boolean; asset_reasons: string[] | null;
  asset_eligible: boolean | null; deviation_ppm: string | null;
}
const sourceSql = `SELECT jsonb_build_object('id',c.id::text,'block',c.block_number::text,
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
    AND t.created_block<=c.block_number) AS covered
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
  constructor(connectionString: string, private readonly executor?: PaperExecutor) { this.pool = new pg.Pool({ connectionString, max: 1 }); }
  async migrate() { await this.pool.query(PAPER_SCHEMA_SQL); }
  async start(streamKey: string, policy: PaperPolicy): Promise<string> {
    policy = paperPolicy(policy);
    const state = initialPaperState();
    state.reasons = ["awaiting_first_live_checkpoint"];
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO paper_sessions(stream_key,policy_hash,policy,state,status) VALUES($1,$2,$3,$4,'waiting') RETURNING id::text`,
      [streamKey,policyHash(policy),JSON.stringify(policy),JSON.stringify(state)]);
    return result.rows[0]!.id;
  }
  async stop(streamKey: string): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query<PaperSessionRow>("SELECT * FROM paper_sessions WHERE stream_key=$1 AND status NOT IN ('closed','invalid') ORDER BY id LIMIT 1 FOR UPDATE",[streamKey])).rows[0];
      if (!row) { await client.query("COMMIT"); return null; }
      const now = (await client.query<{ now: Date }>("SELECT NOW() AS now")).rows[0]!.now.toISOString();
      const state = row.state;
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
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const sessions = await client.query<PaperSessionRow>(
        `SELECT * FROM paper_sessions WHERE stream_key=$1 AND status NOT IN ('closed','invalid') ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [streamKey]);
      const session = sessions.rows[0];
      if (!session) { await client.query("COMMIT"); return null; }
      const now = (await client.query<{ now: Date }>("SELECT NOW() AS now")).rows[0]!.now.toISOString();
      session.policy = paperPolicySchema.parse(session.policy);
      if (policyHash(session.policy) !== session.policy_hash) throw new Error("Stored paper policy hash mismatch");
      if ("executionBasis" in session.policy && session.policy.executionBasis === "nitro_fork_v1" &&
        !(await paperExecutionEvidenceValid(client, session))) {
        session.state = invalidatePaper(session.state, now, ["paper_execution_evidence_invalid"]);
        await this.update(client, session.id, session.state, session.state.reasons);
        await client.query("COMMIT");
        return { id: session.id, status: session.state.status, action: session.state.action, reasons: session.state.reasons };
      }
      // Preserve the journal on reorgs; revoke the result rather than rewriting it.
      const invalid = await client.query<{ invalid: string }>(
        `SELECT COUNT(*)::text AS invalid FROM paper_observations o
         LEFT JOIN v3_strategy_checkpoint_runs c ON c.id=o.checkpoint_id
         LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id
         WHERE o.session_id=$1 AND (c.id IS NULL OR v.canonical IS DISTINCT FROM TRUE
           OR c.block_number IS DISTINCT FROM o.block_number OR LOWER(c.block_hash) IS DISTINCT FROM LOWER(o.block_hash)
           OR v.block_number IS DISTINCT FROM o.block_number OR LOWER(v.expected_hash) IS DISTINCT FROM LOWER(o.block_hash)
           OR LOWER(v.observed_hash) IS DISTINCT FROM LOWER(o.block_hash))`, [session.id]);
      if (invalid.rows[0]!.invalid !== "0") {
        session.state = invalidatePaper(session.state, now, ["prior_paper_source_no_longer_canonical"]);
        await this.update(client, session.id, session.state, session.state.reasons);
        await client.query("COMMIT");
        return { id: session.id, status: session.state.status, action: session.state.action, reasons: session.state.reasons };
      }
      const source = (await client.query<SourceRow>(`${sourceSql}
        AND c.captured_at >= $4 AND c.block_timestamp >= $4
        AND NOT EXISTS (SELECT 1 FROM paper_observations o WHERE o.session_id=$5 AND o.checkpoint_id=c.id)
        AND c.block_number > $6 ORDER BY c.block_number,c.id LIMIT 1`,
        [session.stream_key,PAPER_NVDA,PAPER_POOL,session.created_at,session.id,session.state.last?.block ?? "0"])).rows[0];
      if (!source) {
        await client.query("UPDATE paper_sessions SET heartbeat_at=NOW(),monitor_reasons=$2 WHERE id=$1",[session.id,JSON.stringify(["awaiting_next_live_checkpoint"])]);
        await client.query("COMMIT");
        return { id: session.id, status: session.state.status, action: "wait", reasons: ["awaiting_next_live_checkpoint"] };
      }
      const cp = source.checkpoint;
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
      const risk = await readRiskGate(client, session.stream_key, 180, 30, "NVDA");
      const residual = (reasons: readonly string[]) => reasons.filter(r => !(r === "sequencer_feed_unavailable" && readiness.chainEligible));
      const entryReasons = [...readiness.reasons, ...residual(risk.reasons), ...source.reasons,
        ...residual(source.asset_reasons ?? ["asset_risk_missing"])];
      if (source.asset_eligible !== true && source.asset_reasons?.length === 0) entryReasons.push("asset_risk_ineligible");
      if (!source.pool_unlocked) entryReasons.push("pool_locked");
      if (source.status !== "valid") entryReasons.push("pool_reference_excluded");
      if (source.risk_run_id !== risk.snapshotId) entryReasons.push("checkpoint_not_latest_risk_snapshot");
      if (source.deviation_ppm === null || BigInt(source.deviation_ppm) > 5000n || BigInt(source.deviation_ppm) < -5000n) entryReasons.push("oracle_deviation_over_0_5_percent_or_unavailable");
      const path = await client.query<{ minimum: number | null; maximum: number | null; count: string }>(
        `SELECT MIN((event_args->>'tick')::int) AS minimum,MAX((event_args->>'tick')::int) AS maximum,COUNT(*)::text AS count
         FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4 AND event_name='Swap'`,
        [session.stream_key,PAPER_POOL,session.state.last?.block ?? cp.block,cp.block]);
      const swaps = path.rows[0]!;
      const input: PaperInput = { now, checkpoint: cp, dataReasons,
        entryReasons: [...new Set(entryReasons)], chainHealthy: readiness.chainEligible,
        pathMinTick: Math.min(session.state.last?.tick ?? cp.tick,cp.tick,swaps.minimum ?? cp.tick),
        pathMaxTick: Math.max(session.state.last?.tick ?? cp.tick,cp.tick,swaps.maximum ?? cp.tick), swapCount: swaps.count,
        execution: { available: this.executor !== undefined } };
      let state = advancePaper(session.state, session.policy, input);
      if (this.executor && "executionBasis" in session.policy && session.policy.executionBasis === "nitro_fork_v1") {
        const action = state.reasons.includes("paper_entry_quote_required") ? "quote"
          : state.reasons.includes("paper_entry_simulation_required") ? "entry"
          : state.reasons.includes("paper_exit_simulation_required") ? "exit" : null;
        if (action) {
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
            evidence = { error: execution.error };
          }
          const saved = await client.query<{ id: string }>(`INSERT INTO paper_execution_runs
            (session_id,checkpoint_id,source_block,source_hash,policy_hash,action,status,snapshot)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
            [session.id,cp.id,cp.block,cp.hash,session.policy_hash,action,status,JSON.stringify(evidence)]);
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
    finally { client.release(); }
  }
  private async update(client: PoolClient, id: string, state: PaperState, monitorReasons: readonly string[]) {
    await client.query("UPDATE paper_sessions SET state=$2,status=$3,updated_at=clock_timestamp(),heartbeat_at=clock_timestamp(),monitor_reasons=$4 WHERE id=$1",[id,JSON.stringify(state),state.status,JSON.stringify(monitorReasons)]);
  }
  async close() { await this.pool.end(); }
}
