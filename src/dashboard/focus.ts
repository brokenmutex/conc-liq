import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { z } from "zod";
import { evaluateCanaryEntryReadiness } from "../canary-plan/entry-readiness.js";
import type { RpcHealthEvaluation } from "../rpc-health/domain.js";
import { readRiskGate } from "../risk/gate.js";
import type { DashboardConfig } from "./config.js";

export const CANARY_POOL = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3";

// A dated project artifact, never a current wallet position or preflight result.
const rehearsalSchema = z.object({
  scope: z.literal("local_anvil_mint_observe_decrease_collect"),
  completedAt: z.iso.datetime(),
  executionEligible: z.literal(false),
  broadcastAuthorized: z.literal(false),
  source: z.object({
    poolAddress: z.string().refine((value) => value.toLowerCase() === CANARY_POOL),
    streamKey: z.string(),
    blockNumber: z.string().regex(/^\d+$/),
  }),
  finalPosition: z.object({ liquidity: z.literal("0"), tokensOwed0: z.literal("0"), tokensOwed1: z.literal("0") }),
  receipts: z.array(z.object({ action: z.string() })).refine((rows) =>
    rows.some((row) => row.action === "mint") && rows.some((row) => row.action === "decrease_and_collect")),
});

export function summarizeRehearsal(value: unknown, streamKey: string) {
  const parsed = rehearsalSchema.safeParse(value);
  if (!parsed.success || parsed.data.source.streamKey !== streamKey) return null;
  return {
    completedAt: parsed.data.completedAt,
    sourceBlock: parsed.data.source.blockNumber,
    scope: parsed.data.scope,
  };
}

export interface FocusCheckpoint {
  readonly id: string;
  readonly riskRunId: string;
  readonly block: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly capturedAt: string;
  readonly status: string;
  readonly reasons: readonly string[];
  readonly poolPriceX18: string;
  readonly oraclePriceX18: string | null;
  readonly deviationPpm: string | null;
}

export async function readDashboardFocus(client: PoolClient, config: DashboardConfig) {
  const result = await client.query<{ checkpoint: FocusCheckpoint; server_time: Date }>(
    `SELECT NOW() AS server_time, jsonb_build_object(
       'id', c.id::text, 'riskRunId', c.risk_run_id::text,
       'block', c.block_number::text, 'blockHash', c.block_hash,
       'blockTimestamp', c.block_timestamp, 'capturedAt', c.captured_at,
       'status', p.status, 'reasons', p.reasons,
       'poolPriceX18', p.pool_price_x18::text,
       'oraclePriceX18', p.oracle_price_x18::text,
       'deviationPpm', p.deviation_ppm::text) AS checkpoint
     FROM v3_strategy_checkpoint_runs c
     JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = c.id
     WHERE c.stream_key = $1 AND c.chain_id = 4663
       AND LOWER(p.pool_address) = $2 AND p.rwa_symbol = 'NVDA' AND p.fee = 500
     ORDER BY c.block_number DESC, c.id DESC LIMIT 1`,
    [config.streamKey, CANARY_POOL],
  );
  const checkpoint = result.rows[0]?.checkpoint ?? null;
  const samples = await client.query<{ id: string; snapshot: RpcHealthEvaluation; server_time: Date }>(
    `SELECT id::text, snapshot, NOW() AS server_time FROM rpc_health_samples
     WHERE observed_at >= NOW() - INTERVAL '6 minutes'
     ORDER BY observed_at DESC, id DESC LIMIT 128`,
  );
  const now = (result.rows[0]?.server_time ?? samples.rows[0]?.server_time ?? new Date()).toISOString();
  const plans = await client.query<{ id: string; created_at: Date; status: string }>(
    `SELECT g.id::text, g.created_at, g.status FROM guarded_canary_plan_runs g
     JOIN v3_strategy_checkpoint_runs c ON c.id = g.checkpoint_run_id
     WHERE g.chain_id = 4663 AND LOWER(g.pool_address) = $1 AND c.stream_key = $2
     ORDER BY g.created_at DESC, g.id DESC LIMIT 1`, [CANARY_POOL, config.streamKey],
  );
  const lastPlan = plans.rows[0];
  let rehearsal = null;
  try {
    rehearsal = summarizeRehearsal(JSON.parse(await readFile(
      "notes/canary-evidence-2026-09-06/local-lifecycle.json", "utf8",
    )), config.streamKey);
  } catch { /* Missing evidence remains unavailable. */ }
  return {
    poolAddress: CANARY_POOL,
    checkpoint,
    checkpointMaxAgeSeconds: config.canaryMaxCheckpointAgeSeconds,
    entryReadiness: evaluateCanaryEntryReadiness({
      now, sourceBlock: BigInt(checkpoint?.block ?? "0"), samples: samples.rows,
    }),
    riskGate: await readRiskGate(client, config.streamKey,
      config.riskGateMaxSnapshotAgeSeconds, config.riskGateMaxCanonicalityAgeSeconds, "NVDA"),
    rehearsal,
    lastPlan: lastPlan ? { id: lastPlan.id, createdAt: lastPlan.created_at.toISOString(), status: lastPlan.status } : null,
    executionEnabled: false as const,
    historySource: config.historySource,
    fullAccountingEnabled: config.fullAccountingEnabled,
  };
}

export type DashboardFocus = Awaited<ReturnType<typeof readDashboardFocus>>;
