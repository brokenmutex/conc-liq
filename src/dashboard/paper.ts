import {quoteValue} from '../simulator/math.js';
import {USDG} from '../constants.js';
import {PAPER_NVDA} from '../paper/engine.js';
import type { PoolClient } from "pg";
import type { PaperSessionRow } from "../paper/store.js";
import { invalidatePaper } from "../paper/engine.js";
import { readPaperReceiptCosts } from "./paper-costs.js";
import { readPaperExecutionDashboard } from "./paper-execution.js";
import { paperExecutionEvidenceValid } from "../paper/evidence.js";
import { readPaperChain, paperCampaignSummary } from "../paper/reentry.js";
import {readSessionPerformance} from '../paper/session-performance-store.js';
interface PaperPoint {
  checkpointId: string; block: string; observedAt: string; sourceAt: string;
  action: string; navQuote: string | null; holdQuote: string | null;
  pnlQuote: string | null; alphaQuote: string | null; reasons: readonly string[];
}
export async function readPaperDashboard(client: PoolClient, streamKey: string) {
  if (!(await client.query<{ present: string | null }>("SELECT to_regclass('paper_sessions')::text AS present")).rows[0]?.present) return null;
  const row = (await client.query<PaperSessionRow & { server_time: Date }>("SELECT *,NOW() AS server_time FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1",[streamKey])).rows[0];
  if (!row) return null;
  const points = await client.query<{ point: PaperPoint }>(`SELECT jsonb_build_object(
    'checkpointId',checkpoint_id::text,'block',block_number::text,'observedAt',observed_at,'sourceAt',source_at,
    'action',action,'navQuote',state->>'navQuote','holdQuote',state->>'holdQuote',
    'pnlQuote',state->>'pnlQuote','alphaQuote',state->>'alphaQuote','reasons',state->'reasons') AS point
    FROM paper_observations WHERE session_id=$1 ORDER BY id DESC LIMIT 400`,[row.id]);
  const valid = (await client.query<{ canonical: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM paper_observations o LEFT JOIN v3_strategy_checkpoint_runs c ON c.id=o.checkpoint_id
    LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id
    WHERE o.session_id=$1 AND (c.id IS NULL OR v.canonical IS DISTINCT FROM TRUE
      OR c.block_number IS DISTINCT FROM o.block_number OR LOWER(c.block_hash) IS DISTINCT FROM LOWER(o.block_hash)
      OR v.block_number IS DISTINCT FROM o.block_number OR LOWER(v.expected_hash) IS DISTINCT FROM LOWER(o.block_hash)
      OR LOWER(v.observed_hash) IS DISTINCT FROM LOWER(o.block_hash))) AS canonical`,[row.id])).rows[0]!.canonical;
  const executionValid = !("executionBasis" in row.policy && row.policy.executionBasis === "nitro_fork_v1") || await paperExecutionEvidenceValid(client,row);
  let campaign = null;
  let performance:Awaited<ReturnType<typeof readSessionPerformance>>|{valid:false;reason:string}|null=null;
  if ("reentry" in row.policy && row.policy.reentry) {
    try {
      const chain=await readPaperChain(client,row);
      campaign = { valid: true, ...paperCampaignSummary(chain) };
      try{performance=await readSessionPerformance(client,chain);}catch{performance={valid:false,reason:'Position history cannot be fully reconciled for session attribution'};}
    } catch { campaign = { valid: false }; }
  }
  const fm=row.state.feeModel,mark=row.state.last;
  const feeValue=(a:string,b:string)=>quoteValue({amount0:BigInt(a),amount1:BigInt(b),token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(mark!.sqrtPriceX96)});
  const feeAccounting=fm&&mark?{kind:fm.kind,fromSourceAt:fm.fromSourceAt,fromBlock:fm.fromBlock,
    legacyQuote:String(feeValue(fm.legacyEarned0,fm.legacyEarned1)),undilutedQuote:String(feeValue(fm.undiluted0,fm.undiluted1)),adjustedQuote:String(feeValue(fm.adjusted0,fm.adjusted1)),
    reductionQuote:String(feeValue(fm.undiluted0,fm.undiluted1)-feeValue(fm.adjusted0,fm.adjusted1))}:null;
  const campaignValid = campaign?.valid !== false;
  return { id: row.id, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null, policy: row.policy, policyHash: row.policy_hash,
    state: row.state.status==='invalid' || (valid && executionValid && campaignValid) ? row.state : invalidatePaper(row.state,row.server_time.toISOString(),[!campaignValid ? "paper_continuation_history_invalid" : !valid ? "prior_paper_source_no_longer_canonical" : "paper_execution_evidence_invalid"]),
    feeAccounting:valid&&executionValid&&campaignValid?feeAccounting:null, monitorReasons: row.monitor_reasons, sourceCanonical: valid, campaign,performance,
    points: valid && executionValid && campaignValid ? points.rows.reverse().map(p=>p.point) : [],
    execution: await readPaperExecutionDashboard(client, row.id),
    receiptCosts: await readPaperReceiptCosts(client, streamKey), executionEligible: false as const };
}
export type PaperDashboard = Awaited<ReturnType<typeof readPaperDashboard>>;
