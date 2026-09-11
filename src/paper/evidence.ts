import type { PoolClient } from "pg";
import type { PaperState } from "./engine.js";
export async function paperExecutionEvidenceValid(client: PoolClient, session: { id: string; policy_hash: string; state: PaperState; runtime_identity?: unknown }) {
  const ledger = session.state.execution;
  if (!ledger?.entryRunId) return session.state.position === null;
  let previousId=BigInt(ledger.entryRunId);
  for(const id of ledger.recenterRunIds??[]){
    if(!/^[1-9]\d*$/.test(id)||BigInt(id)<=previousId||(ledger.exitRunId&&BigInt(id)>=BigInt(ledger.exitRunId)))return false;
    previousId=BigInt(id);
  }
  for (const [action, id, recenter] of [["entry", ledger.entryRunId, false], ["exit", ledger.exitRunId, false],
    ...(ledger.recenterRunIds??[]).map(id=>['entry',id,true] as const)] as const) {
    if (!id) continue;
    const row = (await client.query<{ valid: boolean }>(`SELECT (
      ($5::jsonb IS NULL OR r.runtime_identity=$5::jsonb)
      AND r.session_id=$2 AND r.policy_hash=$3 AND r.action=$4 AND r.status='succeeded'
      AND r.snapshot->'result'->>'executionEligible'='false'
      AND (NOT $6::boolean OR r.snapshot->'result'->>'scope'='paper_inventory_recenter')
      AND r.snapshot->'result'->'source'->>'block'=r.source_block::text
      AND LOWER(r.snapshot->'result'->'source'->>'hash')=LOWER(r.source_hash)
      AND r.snapshot->'valuation'->>'sourceBlock'=r.source_block::text
      AND LOWER(r.snapshot->'valuation'->>'sourceHash')=LOWER(r.source_hash)
      AND c.block_number=r.source_block AND LOWER(c.block_hash)=LOWER(r.source_hash)
      AND v.canonical IS TRUE AND v.block_number=r.source_block
      AND LOWER(v.expected_hash)=LOWER(r.source_hash) AND LOWER(v.observed_hash)=LOWER(r.source_hash)
    ) AS valid FROM paper_execution_runs r
    LEFT JOIN v3_strategy_checkpoint_runs c ON c.id=r.checkpoint_id
    LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id WHERE r.id=$1`,
    [id, session.id, session.policy_hash, action, session.runtime_identity ? JSON.stringify(session.runtime_identity) : null, recenter])).rows[0];
    if (row?.valid !== true) return false;
  }
  return session.state.status !== "closed" || ledger.exitRunId !== null;
}
