import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { paperPolicySchema } from "./config.js";
import { paperExecutionEvidenceValid } from "./evidence.js";
import { PAPER_NVDA, policyHash, type TransactionPaperPolicy } from "./engine.js";
import type { PaperSessionRow } from "./store.js";
import { quoteValue } from "../simulator/math.js";
import { USDG } from "../constants.js";

export function closedPaperCash(session: PaperSessionRow): string {
  const s = session.state, p = s.position;
  assert(s.status === "closed" && s.action === "exit" && !s.invalidatedAt && s.execution?.exitRunId && p,
    "Paper continuation requires a completed, valid cash exit");
  assert(p.liquidity === "0" && p.idle1 === "0" && p.fee0 === "0" && p.fee1 === "0" && s.exitReserveQuote === "0",
    "Paper continuation has residual inventory or costs");
  const cash = BigInt(p.idle0) - BigInt(s.costsPaidQuote);
  assert(cash > 0n && s.navQuote === String(cash) && s.pnlQuote === String(cash - BigInt(session.policy.budgetQuote)),
    "Paper continuation cash does not reconcile");
  return String(cash);
}

export async function paperSourcesValid(client: PoolClient, session: PaperSessionRow): Promise<boolean> {
  const policy = paperPolicySchema.parse(session.policy);
  if (policyHash(policy) !== session.policy_hash || session.state.status === "invalid" || session.state.invalidatedAt) return false;
  const row = (await client.query<{ valid: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM paper_observations o LEFT JOIN v3_strategy_checkpoint_runs c ON c.id=o.checkpoint_id
    LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id
    WHERE o.session_id=$1 AND (c.id IS NULL OR v.canonical IS DISTINCT FROM TRUE
      OR c.block_number IS DISTINCT FROM o.block_number OR LOWER(c.block_hash) IS DISTINCT FROM LOWER(o.block_hash)
      OR v.block_number IS DISTINCT FROM o.block_number OR LOWER(v.expected_hash) IS DISTINCT FROM LOWER(o.block_hash)
      OR LOWER(v.observed_hash) IS DISTINCT FROM LOWER(o.block_hash))) AS valid`, [session.id])).rows[0];
  return row?.valid === true && "executionBasis" in policy && policy.executionBasis === "nitro_fork_v1" &&
    await paperExecutionEvidenceValid(client, session);
}

/** Old sessions remain immutable. Every carried dollar depends on the full source chain. */
export async function readPaperChain(client: PoolClient, latest: PaperSessionRow): Promise<PaperSessionRow[]> {
  const chain: PaperSessionRow[] = [];
  let row = latest;
  for (;;) {
    row.policy = paperPolicySchema.parse(row.policy);
    assert(await paperSourcesValid(client, row), "Paper continuation history evidence invalid");
    chain.unshift(row);
    const previous = "reentry" in row.policy ? row.policy.reentry?.previousSessionId : undefined;
    if (!previous) break;
    assert(BigInt(previous) < BigInt(row.id), "Paper continuation ancestry must advance");
    const parent = (await client.query<PaperSessionRow>("SELECT * FROM paper_sessions WHERE id=$1 AND stream_key=$2", [previous, latest.stream_key])).rows[0];
    assert(parent && closedPaperCash(parent) === row.policy.budgetQuote, "Paper continuation funding mismatch");
    row = parent;
  }
  return chain;
}

export function continuationPolicy(parent: PaperSessionRow, policy: TransactionPaperPolicy): TransactionPaperPolicy {
  assert(policy.reentry, "Paper continuation requires an explicit reentry policy");
  return paperPolicySchema.parse({ ...policy, budgetQuote: closedPaperCash(parent),
    reentry: { cooldownSeconds: policy.reentry.cooldownSeconds, previousSessionId: parent.id } }) as TransactionPaperPolicy;
}

export function paperCampaignSummary(chain: readonly PaperSessionRow[]) {
  assert(chain.length > 0);
  const first = chain[0]!, latest = chain.at(-1)!, state = latest.state;
  const mark = [...chain].reverse().find(row => row.state.last)?.state.last;
  const nav = state.navQuote ?? (!state.position ? latest.policy.budgetQuote : null);
  const baseline = first.state.position;
  const hold = baseline && mark ? String(quoteValue({amount0: BigInt(baseline.hold0), amount1: BigInt(baseline.hold1),
    token0: USDG, token1: PAPER_NVDA, quoteToken: USDG, sqrtPriceX96: BigInt(mark.sqrtPriceX96) }) - BigInt(first.state.execution?.holdGasQuote ?? "0")) : null;
  return { rootSessionId: first.id, sessionIds: chain.map(row => row.id), initialBudgetQuote: first.policy.budgetQuote,
    navQuote: nav, pnlQuote: nav === null ? null : String(BigInt(nav) - BigInt(first.policy.budgetQuote)),
    holdQuote: hold, alphaQuote: nav === null || hold === null ? null : String(BigInt(nav) - BigInt(hold)),
    costsPaidQuote: String(chain.reduce((sum, row) => sum + BigInt(row.state.costsPaidQuote), 0n)),
    sourceAt: mark?.blockTimestamp ?? null };
}
