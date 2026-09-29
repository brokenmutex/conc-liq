// Isolated synthetic planner benchmark for the SetFeeProtocol lookup.
// Only session-local TEMP objects are created; persistent application tables
// are never modified. This demonstrates selectivity and plan shape, not
// production speed.
import pg from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL_required');
const { Client } = pg;
const client = new Client({ connectionString, application_name: 'research-index-synthetic-benchmark' });
const sql = `SELECT DISTINCT ON (lower(pool_address))
       lower(pool_address) AS pool_address,
       (event_args->>'feeProtocol0New')::int AS fee_protocol0,
       (event_args->>'feeProtocol1New')::int AS fee_protocol1
  FROM synthetic_pool_events
 WHERE stream_key = $1 AND event_name = 'SetFeeProtocol'
 ORDER BY lower(pool_address), block_number DESC,
          transaction_index DESC, log_index DESC`;

function summarizeExplain(result) {
  const root = result.rows[0]['QUERY PLAN'][0];
  const visit = (node, items = []) => {
    items.push({
      node: node['Node Type'],
      actualRows: node['Actual Rows'],
      actualMs: node['Actual Total Time'],
      sharedRead: node['Shared Read Blocks'] ?? 0,
      sharedHit: node['Shared Hit Blocks'] ?? 0,
      localRead: node['Local Read Blocks'] ?? 0,
      localHit: node['Local Hit Blocks'] ?? 0,
      tempRead: node['Temp Read Blocks'] ?? 0,
      tempWritten: node['Temp Written Blocks'] ?? 0,
    });
    for (const child of node.Plans ?? []) visit(child, items);
    return items;
  };
  return {
    planningMs: root['Planning Time'],
    executionMs: root['Execution Time'],
    nodes: visit(root.Plan),
  };
}

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE synthetic_pool_events (
    stream_key text NOT NULL, pool_address text NOT NULL, block_number bigint NOT NULL,
    transaction_index integer NOT NULL, log_index integer NOT NULL,
    event_name text NOT NULL, event_args jsonb NOT NULL
  ) ON COMMIT DROP`);
  await client.query(`INSERT INTO synthetic_pool_events
    SELECT 'benchmark', '0x'||lpad(to_hex((i % 15)+1),40,'0'), i,
           0, 0, 'Swap', '{"amount0":"1","amount1":"2"}'::jsonb
      FROM generate_series(1,250000) AS g(i)`);
  await client.query(`INSERT INTO synthetic_pool_events
    SELECT 'benchmark', '0x'||lpad(to_hex((i % 15)+1),40,'0'),
           250000+i, 0, 0, 'SetFeeProtocol',
           '{"feeProtocol0New":4,"feeProtocol1New":4}'::jsonb
      FROM generate_series(1,16) AS g(i)`);
  await client.query('ANALYZE synthetic_pool_events');
  const before = summarizeExplain(await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ['benchmark'],
  ));
  await client.query(`CREATE INDEX synthetic_set_fee_protocol_idx
    ON synthetic_pool_events (stream_key, lower(pool_address), block_number DESC,
      transaction_index DESC, log_index DESC)
    INCLUDE (event_args) WHERE event_name='SetFeeProtocol'`);
  await client.query('ANALYZE synthetic_pool_events');
  const after = summarizeExplain(await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ['benchmark'],
  ));
  process.stdout.write(`${JSON.stringify({
    syntheticRows: 250016,
    targetRows: 16,
    before,
    after,
    limitation: 'Synthetic narrow-row table validates plan/selectivity only; not production timing or I/O projection.',
  }, null, 2)}\n`);
  await client.query('ROLLBACK');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
  throw error;
} finally {
  await client.end();
}
