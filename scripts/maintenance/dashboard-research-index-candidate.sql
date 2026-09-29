-- Review candidate only. Do not run without separate production DDL approval.
-- Run each statement as a standalone command; CONCURRENTLY is forbidden in a
-- transaction block. This exact partial predicate matches readProtocolFees().
-- PostgreSQL creates the index in the table schema; CREATE index name is unqualified.
CREATE INDEX CONCURRENTLY v3_pool_events_set_fee_protocol_latest_idx
  ON public.v3_pool_events (
    stream_key,
    lower(pool_address),
    block_number DESC,
    transaction_index DESC,
    log_index DESC
  ) INCLUDE (event_args)
  WHERE event_name = 'SetFeeProtocol';

-- If CREATE INDEX CONCURRENTLY is interrupted, inspect pg_index.indisvalid.
-- Remove a same-named invalid remnant before retrying the CREATE statement.
-- DROP INDEX CONCURRENTLY IF EXISTS public.v3_pool_events_set_fee_protocol_latest_idx;

-- Rollback after a valid deployment (also standalone, outside a transaction).
-- DROP INDEX CONCURRENTLY IF EXISTS public.v3_pool_events_set_fee_protocol_latest_idx;

-- Post-create verification, after ANALYZE if needed:
-- EXPLAIN (COSTS, VERBOSE)
-- SELECT DISTINCT ON (lower(pool_address))
--        lower(pool_address) AS pool_address,
--        (event_args->>'feeProtocol0New')::int AS fee_protocol0,
--        (event_args->>'feeProtocol1New')::int AS fee_protocol1
--   FROM public.v3_pool_events
--  WHERE stream_key = '<stream-key>' AND event_name = 'SetFeeProtocol'
--  ORDER BY lower(pool_address), block_number DESC,
--           transaction_index DESC, log_index DESC;
