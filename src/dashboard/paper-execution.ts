import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { z } from "zod";
const raw = z.string().regex(/^\d+$/);
const rehearsalSchema = z.object({
  scope: z.literal("paper_cash_swap_mint_exit_cash"), executionEligible: z.literal(false), broadcastAuthorized: z.literal(false),
  computedAt: z.iso.datetime(), source: z.object({block:raw,hash:z.string()}),
  policy: z.object({budgetQuote:raw}), cashDeltaQuote:z.string().regex(/^-?\d+$/),
  entryGasWei:raw,exitGasWei:raw,totalGasWei:raw,
  transactions:z.array(z.object({action:z.string(),estimate:z.object({totalFeeWei:raw})})),
});
export async function readPaperExecutionDashboard(client: PoolClient, sessionId: string) {
  let rehearsal = null;
  try {
    const p = rehearsalSchema.parse(JSON.parse(await readFile("notes/paper-execution-evidence-2026-09-07/round-trip.json", "utf8")));
    if (["buy_nvda","mint","decrease_and_collect","sell_nvda"].every(action=>p.transactions.some(tx=>tx.action===action)) &&
      p.transactions.reduce((sum,tx)=>sum+BigInt(tx.estimate.totalFeeWei),0n)===BigInt(p.totalGasWei) &&
      BigInt(p.entryGasWei)+BigInt(p.exitGasWei)===BigInt(p.totalGasWei)) {
      rehearsal={computedAt:p.computedAt,block:p.source.block,budgetQuote:p.policy.budgetQuote,
        cashDeltaQuote:p.cashDeltaQuote,totalGasWei:p.totalGasWei,transactions:p.transactions.length};
    }
  } catch { /* A missing or malformed artifact cannot prove simulation readiness. */ }
  const present=(await client.query<{present:string|null}>("SELECT to_regclass('paper_execution_runs')::text AS present")).rows[0]?.present;
  const runs=present ? (await client.query<{run:{id:string;action:string;status:string;observedAt:string;block:string;gasWei:string|null;error:string|null}}>(
    `SELECT jsonb_build_object('id',id::text,'action',action,'status',status,'observedAt',observed_at,'block',source_block::text,
      'gasWei',CASE WHEN action='entry' THEN snapshot->'result'->>'entryGasWei' ELSE snapshot->'result'->>'totalGasWei' END,
      'error',snapshot->>'error') AS run FROM paper_execution_runs WHERE session_id=$1 ORDER BY id DESC LIMIT 12`,[sessionId])).rows.map(r=>r.run) : [];
  return {rehearsal,runs};
}
