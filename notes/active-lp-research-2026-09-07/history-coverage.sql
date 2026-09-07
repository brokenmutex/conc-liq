BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '25s';

SELECT now() AS captured_at;

WITH coverage AS (
  SELECT p.stream_key, p.pool_address, p.rwa_symbol, p.fee, p.created_block,
         count(e.transaction_hash) AS events,
         count(*) FILTER (WHERE e.event_name = 'Swap') AS swaps,
         count(*) FILTER (WHERE e.event_name = 'Initialize') AS initializes,
         min(e.block_number) AS first_block,
         max(e.block_number) AS last_block
  FROM indexer_pools p
  LEFT JOIN v3_pool_events e
    ON e.stream_key = p.stream_key AND e.pool_address = p.pool_address
  WHERE p.enabled
  GROUP BY p.stream_key, p.pool_address, p.rwa_symbol, p.fee, p.created_block
)
SELECT c.*,
       b.block_number AS first_time_lower_block,
       b.block_timestamp AS first_time_lower_bound,
       a.block_number AS first_time_upper_block,
       a.block_timestamp AS first_time_upper_bound
FROM coverage c
LEFT JOIN LATERAL (
  SELECT block_number, block_timestamp FROM indexer_checkpoints
  WHERE stream_key = c.stream_key AND block_number <= c.first_block
  ORDER BY block_number DESC LIMIT 1
) b ON true
LEFT JOIN LATERAL (
  SELECT block_number, block_timestamp FROM indexer_checkpoints
  WHERE stream_key = c.stream_key AND block_number >= c.first_block
  ORDER BY block_number ASC LIMIT 1
) a ON true
ORDER BY c.rwa_symbol, c.fee;

SELECT stream_key, events_applied, complete_through_block, updated_at
FROM v3_replay_cursors;

SELECT stream_key, min(block_timestamp) AS earliest,
       max(block_timestamp) AS latest, count(*) AS headers
FROM indexer_checkpoints GROUP BY stream_key;

COMMIT;
