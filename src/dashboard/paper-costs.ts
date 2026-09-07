import type { PoolClient } from "pg";
import { PAPER_POOL } from "../paper/engine.js";

export interface PaperReceiptCost {
  actionClass: string;
  transactions: string;
  minFeeWei: string;
  maxFeeWei: string;
  firstBlock: string;
  lastBlock: string;
  collectedAt: string;
}

// Read actual whole-transaction charges, never an inferred paper fill price.
// A matching indexed event is required so a reorg or another pool cannot
// silently become evidence for the NVDA session. No RPC/valuation fallback.
export async function readPaperReceiptCosts(client: PoolClient, streamKey: string): Promise<PaperReceiptCost[]> {
  const present = await client.query<{ present: string | null }>(
    "SELECT to_regclass('v3_action_cost_observations')::text AS present");
  if (!present.rows[0]?.present) return [];
  const result = await client.query<{ cost: PaperReceiptCost }>(`SELECT jsonb_build_object(
    'actionClass', a.action_class, 'transactions', COUNT(*)::text,
    'minFeeWei', MIN(a.total_fee_wei)::text, 'maxFeeWei', MAX(a.total_fee_wei)::text,
    'firstBlock', MIN(a.block_number)::text, 'lastBlock', MAX(a.block_number)::text,
    'collectedAt', MAX(a.observed_at)) AS cost
    FROM v3_action_cost_observations a
    WHERE a.stream_key=$1 AND a.chain_id=4663
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.pool_addresses) p WHERE LOWER(p)=$2)
      AND EXISTS (SELECT 1 FROM v3_pool_events e
        WHERE e.stream_key=a.stream_key AND e.chain_id=a.chain_id AND LOWER(e.pool_address)=$2
          AND e.block_number=a.block_number AND LOWER(e.block_hash)=LOWER(a.block_hash)
          AND LOWER(e.transaction_hash)=LOWER(a.transaction_hash))
    GROUP BY a.action_class ORDER BY a.action_class`, [streamKey, PAPER_POOL]);
  return result.rows.map(row => row.cost);
}
