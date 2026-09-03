export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observer_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  chain_id BIGINT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS observer_runs_chain_block_idx
  ON observer_runs (chain_id, block_number DESC);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  run_id BIGINT NOT NULL REFERENCES observer_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  sqrt_price_x96 NUMERIC(78, 0) NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (run_id, pool_address)
);

CREATE INDEX IF NOT EXISTS pool_snapshots_pool_run_idx
  ON pool_snapshots (pool_address, run_id DESC);

CREATE TABLE IF NOT EXISTS indexer_pools (
  stream_key TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  rwa_address TEXT NOT NULL,
  fee INTEGER NOT NULL,
  created_block NUMERIC(78, 0) NOT NULL,
  target_set_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_key, pool_address)
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  stream_key TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL,
  target_set_hash TEXT NOT NULL,
  next_block NUMERIC(78, 0) NOT NULL,
  last_scanned_block NUMERIC(78, 0),
  last_scanned_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((last_scanned_block IS NULL) = (last_scanned_hash IS NULL))
);

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  stream_key TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  parent_hash TEXT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_key, block_number)
);

CREATE INDEX IF NOT EXISTS indexer_checkpoints_recent_idx
  ON indexer_checkpoints (stream_key, block_number DESC);

CREATE TABLE IF NOT EXISTS v3_pool_events (
  stream_key TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  pool_address TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  transaction_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_args JSONB NOT NULL,
  raw_topics JSONB NOT NULL,
  raw_data TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_key, transaction_hash, log_index),
  FOREIGN KEY (stream_key, pool_address)
    REFERENCES indexer_pools(stream_key, pool_address)
);

CREATE INDEX IF NOT EXISTS v3_pool_events_replay_idx
  ON v3_pool_events (stream_key, block_number, transaction_index, log_index);

CREATE INDEX IF NOT EXISTS v3_pool_events_pool_replay_idx
  ON v3_pool_events (stream_key, pool_address, block_number, transaction_index, log_index);

CREATE TABLE IF NOT EXISTS v3_replay_cursors (
  stream_key TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL,
  target_set_hash TEXT NOT NULL,
  last_block_number NUMERIC(78, 0),
  last_block_hash TEXT,
  last_transaction_hash TEXT,
  last_transaction_index INTEGER,
  last_log_index INTEGER,
  events_applied NUMERIC(78, 0) NOT NULL DEFAULT 0,
  complete_through_block NUMERIC(78, 0),
  complete_through_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (last_block_number IS NULL) = (last_block_hash IS NULL) AND
    (last_block_number IS NULL) = (last_transaction_hash IS NULL) AND
    (last_block_number IS NULL) = (last_transaction_index IS NULL) AND
    (last_block_number IS NULL) = (last_log_index IS NULL)
  ),
  CHECK ((complete_through_block IS NULL) = (complete_through_hash IS NULL))
);

CREATE TABLE IF NOT EXISTS v3_replay_pools (
  stream_key TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  sqrt_price_x96 NUMERIC(78, 0),
  tick INTEGER,
  liquidity NUMERIC(78, 0) NOT NULL DEFAULT 0,
  observation_cardinality_next INTEGER,
  fee_protocol0 INTEGER NOT NULL DEFAULT 0,
  fee_protocol1 INTEGER NOT NULL DEFAULT 0,
  event_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
  mint_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
  burn_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
  swap_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
  collect_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
  flash_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
  last_event_block NUMERIC(78, 0),
  last_event_transaction_index INTEGER,
  last_event_log_index INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_key, pool_address),
  FOREIGN KEY (stream_key, pool_address)
    REFERENCES indexer_pools(stream_key, pool_address),
  CHECK (liquidity >= 0),
  CHECK (
    (initialized AND sqrt_price_x96 IS NOT NULL AND tick IS NOT NULL AND
      observation_cardinality_next IS NOT NULL) OR
    (NOT initialized AND sqrt_price_x96 IS NULL AND tick IS NULL AND
      observation_cardinality_next IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS v3_replay_ticks (
  stream_key TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity_gross NUMERIC(78, 0) NOT NULL,
  liquidity_net NUMERIC(78, 0) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_key, pool_address, tick),
  FOREIGN KEY (stream_key, pool_address)
    REFERENCES v3_replay_pools(stream_key, pool_address) ON DELETE CASCADE,
  CHECK (liquidity_gross > 0)
);

CREATE TABLE IF NOT EXISTS v3_replay_positions (
  stream_key TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  minted_liquidity NUMERIC(78, 0) NOT NULL,
  burned_liquidity NUMERIC(78, 0) NOT NULL,
  minted_amount0 NUMERIC(78, 0) NOT NULL,
  minted_amount1 NUMERIC(78, 0) NOT NULL,
  burned_amount0 NUMERIC(78, 0) NOT NULL,
  burned_amount1 NUMERIC(78, 0) NOT NULL,
  collected_amount0 NUMERIC(78, 0) NOT NULL,
  collected_amount1 NUMERIC(78, 0) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_key, pool_address, owner_address, tick_lower, tick_upper),
  FOREIGN KEY (stream_key, pool_address)
    REFERENCES v3_replay_pools(stream_key, pool_address) ON DELETE CASCADE,
  CHECK (tick_lower < tick_upper),
  CHECK (liquidity >= 0),
  CHECK (minted_liquidity >= burned_liquidity)
);

CREATE INDEX IF NOT EXISTS v3_replay_positions_active_idx
  ON v3_replay_positions (stream_key, pool_address, tick_lower, tick_upper)
  WHERE liquidity > 0;

CREATE TABLE IF NOT EXISTS risk_snapshot_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  chain_id BIGINT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  registry_fetched_at TIMESTAMPTZ NOT NULL,
  registry_sha256 TEXT NOT NULL,
  feed_directory_fetched_at TIMESTAMPTZ NOT NULL,
  feed_directory_sha256 TEXT NOT NULL,
  sequencer_status TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL,
  reasons JSONB NOT NULL,
  snapshot JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS risk_snapshot_runs_chain_block_idx
  ON risk_snapshot_runs (chain_id, block_number DESC);

CREATE TABLE IF NOT EXISTS asset_risk_snapshots (
  run_id BIGINT NOT NULL REFERENCES risk_snapshot_runs(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  token_address TEXT NOT NULL,
  oracle_address TEXT,
  execution_eligible BOOLEAN NOT NULL,
  reasons JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (run_id, symbol)
);

CREATE INDEX IF NOT EXISTS asset_risk_snapshots_symbol_run_idx
  ON asset_risk_snapshots (symbol, run_id DESC);

CREATE TABLE IF NOT EXISTS risk_snapshot_attempts (
  id BIGSERIAL PRIMARY KEY,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  error TEXT,
  risk_run_id BIGINT REFERENCES risk_snapshot_runs(id),
  CHECK (
    (status = 'started' AND completed_at IS NULL AND error IS NULL AND risk_run_id IS NULL) OR
    (status = 'succeeded' AND completed_at IS NOT NULL AND error IS NULL AND risk_run_id IS NOT NULL) OR
    (status = 'failed' AND completed_at IS NOT NULL AND error IS NOT NULL AND risk_run_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS risk_snapshot_attempts_latest_idx
  ON risk_snapshot_attempts (attempted_at DESC, id DESC);
`;
