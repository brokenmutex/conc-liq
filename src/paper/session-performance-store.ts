import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import type {PaperSessionRow} from './store.js';
import {sessionPerformance,type SessionMark,type SessionTrade} from './session-performance.js';

/** Caller validates the whole campaign and holds one repeatable-read snapshot.
 * Read projected marks, not the large reference/holding evidence at every mark. */
export async function readSessionPerformance(db:Pick<PoolClient,'query'>,chain:readonly PaperSessionRow[],full=false) {
 const ids=chain.map(s=>s.id);assert(ids.length);
 const rows=(await db.query<{mark:SessionMark}>(`SELECT jsonb_build_object(
  'id',id::text,'sessionId',session_id::text,'sourceAt',source_at,'observedAt',observed_at,'block',block_number::text,
  'action',action,'status',state->>'status','tick',state->'last'->'tick','sqrtPriceX96',state->'last'->>'sqrtPriceX96',
  'navQuote',state->>'navQuote','holdQuote',state->>'holdQuote','costsPaidQuote',state->>'costsPaidQuote','exitReserveQuote',state->>'exitReserveQuote',
  'feeAccounting',COALESCE(state->'feeModel'->>'kind','observed_growth'),'feeModelFrom',state->'feeModel'->>'fromSourceAt',
  'earnedFee0',COALESCE(state->'execution'->>'earnedFee0','0'),'earnedFee1',COALESCE(state->'execution'->>'earnedFee1','0'),
  'position',CASE WHEN state->'position'='null'::jsonb THEN NULL ELSE (state->'position')-'boundaryFees'-'feeRemainder0'-'feeRemainder1' END
  ) AS mark FROM paper_observations WHERE session_id=ANY($1::bigint[]) ORDER BY block_number,id LIMIT 100001`,[ids])).rows.map(r=>r.mark);
 assert(rows.length<=100000,'Session report exceeds the bounded 100000-mark window; export/archive before continuing');
 const runIds=chain.flatMap(s=>{const e=s.state.execution;return [e?.entryRunId,...(e?.recenterRunIds??[]),e?.exitRunId].filter((x):x is string=>!!x);});
 const runs=runIds.length?(await db.query<{id:string;session_id:string;source_block:string;action:string;scope:string;token:number|null;trade:any}>(`
  SELECT id::text,session_id::text,source_block::text,action,snapshot->'result'->>'scope' AS scope,
   (snapshot->'result'->'intent'->>'token')::int AS token,
   CASE WHEN snapshot->'result'->>'scope'='paper_inventory_recenter' THEN snapshot->'result'->'trade'
     WHEN action='entry' THEN snapshot->'result'->'entrySwap' ELSE snapshot->'result'->'exitSwap' END AS trade
  FROM paper_execution_runs WHERE id=ANY($1::bigint[]) ORDER BY id`,[runIds])).rows:[];
 const trades:SessionTrade[]=runs.filter(r=>r.trade).map(r=>({runId:r.id,sessionId:r.session_id,block:r.source_block,
  token:r.scope==='paper_inventory_recenter'?r.token as 0|1:r.action==='entry'?0:1,amountIn:r.trade.amountIn,amountOut:r.trade.actualOut}));
 for(const t of trades)assert([0,1].includes(t.token)&&/^\d+$/.test(t.amountIn)&&/^\d+$/.test(t.amountOut),'Invalid accepted swap evidence');
 return sessionPerformance(chain.map(s=>({id:s.id,budgetQuote:s.policy.budgetQuote,createdAt:s.created_at.toISOString()})),rows,trades,full?Infinity:1200);
}
