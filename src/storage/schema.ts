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

CREATE TABLE IF NOT EXISTS v3_fee_accounting_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  events_applied NUMERIC(78, 0) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  pool_count INTEGER NOT NULL,
  tick_count INTEGER NOT NULL,
  position_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS v3_fee_accounting_runs_latest_idx
  ON v3_fee_accounting_runs (stream_key, block_number DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS v3_fee_accounting_runs_source_idx
  ON v3_fee_accounting_runs (
    schema_version, stream_key, block_number, block_hash
  );

CREATE TABLE IF NOT EXISTS v3_pool_fee_accounting (
  run_id BIGINT NOT NULL REFERENCES v3_fee_accounting_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  sqrt_price_x96 NUMERIC(78, 0) NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  fee_growth_global0_x128 NUMERIC(78, 0) NOT NULL,
  fee_growth_global1_x128 NUMERIC(78, 0) NOT NULL,
  positions INTEGER NOT NULL,
  active_positions INTEGER NOT NULL,
  tokens_owed0 NUMERIC(78, 0) NOT NULL,
  tokens_owed1 NUMERIC(78, 0) NOT NULL,
  pending0 NUMERIC(78, 0) NOT NULL,
  pending1 NUMERIC(78, 0) NOT NULL,
  claimable0 NUMERIC(78, 0) NOT NULL,
  claimable1 NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (run_id, pool_address),
  CHECK (liquidity >= 0),
  CHECK (positions >= active_positions AND active_positions >= 0),
  CHECK (tokens_owed0 >= 0 AND tokens_owed1 >= 0),
  CHECK (pending0 >= 0 AND pending1 >= 0),
  CONSTRAINT v3_pool_fee_accounting_claimable0_exact
    CHECK (claimable0 = tokens_owed0 + pending0),
  CONSTRAINT v3_pool_fee_accounting_claimable1_exact
    CHECK (claimable1 = tokens_owed1 + pending1)
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'v3_pool_fee_accounting_claimable0_exact'
      AND conrelid = 'v3_pool_fee_accounting'::regclass
  ) THEN
    ALTER TABLE v3_pool_fee_accounting
      ADD CONSTRAINT v3_pool_fee_accounting_claimable0_exact
      CHECK (claimable0 = tokens_owed0 + pending0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'v3_pool_fee_accounting_claimable1_exact'
      AND conrelid = 'v3_pool_fee_accounting'::regclass
  ) THEN
    ALTER TABLE v3_pool_fee_accounting
      ADD CONSTRAINT v3_pool_fee_accounting_claimable1_exact
      CHECK (claimable1 = tokens_owed1 + pending1);
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS v3_tick_fee_accounting (
  run_id BIGINT NOT NULL REFERENCES v3_fee_accounting_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  tick INTEGER NOT NULL,
  liquidity_gross NUMERIC(78, 0) NOT NULL,
  liquidity_net NUMERIC(78, 0) NOT NULL,
  fee_growth_outside0_x128 NUMERIC(78, 0) NOT NULL,
  fee_growth_outside1_x128 NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (run_id, pool_address, tick),
  CHECK (liquidity_gross > 0)
);

CREATE TABLE IF NOT EXISTS v3_position_fee_accounting (
  run_id BIGINT NOT NULL REFERENCES v3_fee_accounting_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  fee_growth_inside0_last_x128 NUMERIC(78, 0) NOT NULL,
  fee_growth_inside1_last_x128 NUMERIC(78, 0) NOT NULL,
  fee_growth_inside0_x128 NUMERIC(78, 0),
  fee_growth_inside1_x128 NUMERIC(78, 0),
  tokens_owed0 NUMERIC(78, 0) NOT NULL,
  tokens_owed1 NUMERIC(78, 0) NOT NULL,
  pending0 NUMERIC(78, 0) NOT NULL,
  pending1 NUMERIC(78, 0) NOT NULL,
  claimable0 NUMERIC(78, 0) NOT NULL,
  claimable1 NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (
    run_id, pool_address, owner_address, tick_lower, tick_upper
  ),
  CHECK (tick_lower < tick_upper),
  CHECK (liquidity >= 0),
  CHECK (
    (liquidity > 0 AND fee_growth_inside0_x128 IS NOT NULL
      AND fee_growth_inside1_x128 IS NOT NULL) OR
    (liquidity = 0 AND fee_growth_inside0_x128 IS NULL
      AND fee_growth_inside1_x128 IS NULL)
  ),
  CHECK (tokens_owed0 >= 0 AND tokens_owed1 >= 0),
  CHECK (pending0 >= 0 AND pending1 >= 0),
  CHECK (claimable0 = tokens_owed0 + pending0),
  CHECK (claimable1 = tokens_owed1 + pending1)
);

CREATE INDEX IF NOT EXISTS v3_position_fee_accounting_claimable_idx
  ON v3_position_fee_accounting (run_id, pool_address)
  WHERE claimable0 > 0 OR claimable1 > 0;

CREATE TABLE IF NOT EXISTS v3_principal_accounting_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  computed_at TIMESTAMPTZ NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  pool_count INTEGER NOT NULL,
  position_count INTEGER NOT NULL,
  below_range_positions INTEGER NOT NULL,
  in_range_positions INTEGER NOT NULL,
  above_range_positions INTEGER NOT NULL,
  UNIQUE (schema_version, accounting_run_id),
  CHECK (methodology = 'canonical_liquidity_amounts_floor'),
  CHECK (NOT execution_eligible),
  CHECK (pool_count >= 0 AND position_count >= 0),
  CHECK (
    position_count = below_range_positions + in_range_positions +
      above_range_positions
  ),
  CHECK (
    below_range_positions >= 0 AND in_range_positions >= 0 AND
      above_range_positions >= 0
  )
);

CREATE INDEX IF NOT EXISTS v3_principal_accounting_runs_latest_idx
  ON v3_principal_accounting_runs (accounting_run_id DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_pool_principal_accounting (
  principal_run_id BIGINT NOT NULL
    REFERENCES v3_principal_accounting_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  sqrt_price_x96 NUMERIC(78, 0) NOT NULL,
  position_count INTEGER NOT NULL,
  below_range_positions INTEGER NOT NULL,
  in_range_positions INTEGER NOT NULL,
  above_range_positions INTEGER NOT NULL,
  amount0 NUMERIC(78, 0) NOT NULL,
  amount1 NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (principal_run_id, pool_address),
  CHECK (
    position_count = below_range_positions + in_range_positions +
      above_range_positions
  ),
  CHECK (amount0 >= 0 AND amount1 >= 0)
);

CREATE TABLE IF NOT EXISTS v3_position_principal_accounting (
  principal_run_id BIGINT NOT NULL
    REFERENCES v3_principal_accounting_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  sqrt_ratio_lower_x96 NUMERIC(78, 0) NOT NULL,
  sqrt_ratio_upper_x96 NUMERIC(78, 0) NOT NULL,
  region TEXT NOT NULL,
  amount0 NUMERIC(78, 0) NOT NULL,
  amount1 NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (
    principal_run_id, pool_address, owner_address, tick_lower, tick_upper
  ),
  CONSTRAINT v3_position_principal_accounting_pool_fk
    FOREIGN KEY (principal_run_id, pool_address)
    REFERENCES v3_pool_principal_accounting (principal_run_id, pool_address)
    ON DELETE CASCADE,
  CHECK (tick_lower < tick_upper),
  CHECK (liquidity > 0),
  CHECK (sqrt_ratio_lower_x96 < sqrt_ratio_upper_x96),
  CHECK (region IN ('below_range', 'in_range', 'above_range')),
  CHECK (amount0 >= 0 AND amount1 >= 0),
  CHECK (region <> 'below_range' OR amount1 = 0),
  CHECK (region <> 'above_range' OR amount0 = 0)
);

CREATE INDEX IF NOT EXISTS v3_position_principal_accounting_pool_idx
  ON v3_position_principal_accounting (principal_run_id, pool_address);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'v3_position_principal_accounting_pool_fk'
      AND conrelid = 'v3_position_principal_accounting'::regclass
  ) THEN
    ALTER TABLE v3_position_principal_accounting
      ADD CONSTRAINT v3_position_principal_accounting_pool_fk
      FOREIGN KEY (principal_run_id, pool_address)
      REFERENCES v3_pool_principal_accounting (principal_run_id, pool_address)
      ON DELETE CASCADE;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS v3_stable_fee_baseline_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  from_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  to_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  computed_at TIMESTAMPTZ NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  block_delta NUMERIC(78, 0) NOT NULL,
  elapsed_seconds BIGINT NOT NULL,
  paired_active_positions INTEGER NOT NULL,
  stable_positions INTEGER NOT NULL,
  touched_positions INTEGER NOT NULL,
  entered_positions INTEGER NOT NULL,
  exited_positions INTEGER NOT NULL,
  limitations JSONB NOT NULL,
  UNIQUE (
    schema_version, stream_key,
    from_accounting_run_id, to_accounting_run_id
  ),
  CHECK (from_accounting_run_id <> to_accounting_run_id),
  CHECK (methodology = 'stable_core_position_pending_delta'),
  CHECK (NOT execution_eligible),
  CHECK (block_delta > 0 AND elapsed_seconds >= 0),
  CHECK (paired_active_positions = stable_positions + touched_positions),
  CHECK (
    stable_positions >= 0 AND touched_positions >= 0 AND
    entered_positions >= 0 AND exited_positions >= 0
  )
);

CREATE INDEX IF NOT EXISTS v3_stable_fee_baseline_runs_latest_idx
  ON v3_stable_fee_baseline_runs (stream_key, to_accounting_run_id DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_stable_fee_pool_baselines (
  baseline_run_id BIGINT NOT NULL
    REFERENCES v3_stable_fee_baseline_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  active_positions_from INTEGER NOT NULL,
  active_positions_to INTEGER NOT NULL,
  paired_active_positions INTEGER NOT NULL,
  stable_positions INTEGER NOT NULL,
  touched_positions INTEGER NOT NULL,
  entered_positions INTEGER NOT NULL,
  exited_positions INTEGER NOT NULL,
  accrued0 NUMERIC(78, 0) NOT NULL,
  accrued1 NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (baseline_run_id, pool_address),
  CHECK (paired_active_positions = stable_positions + touched_positions),
  CHECK (active_positions_from = paired_active_positions + exited_positions),
  CHECK (active_positions_to = paired_active_positions + entered_positions),
  CHECK (accrued0 >= 0 AND accrued1 >= 0)
);

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

ALTER TABLE risk_snapshot_runs
  ADD COLUMN IF NOT EXISTS market_session_fetched_at TIMESTAMPTZ;

ALTER TABLE risk_snapshot_runs
  ADD COLUMN IF NOT EXISTS market_session_sha256 TEXT;

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

CREATE TABLE IF NOT EXISTS risk_snapshot_canonicality (
  risk_run_id BIGINT PRIMARY KEY REFERENCES risk_snapshot_runs(id) ON DELETE CASCADE,
  block_number NUMERIC(78, 0) NOT NULL,
  expected_hash TEXT NOT NULL,
  observed_hash TEXT,
  canonical BOOLEAN NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error TEXT,
  CHECK (
    (canonical AND observed_hash IS NOT NULL AND error IS NULL) OR
    (NOT canonical)
  )
);

CREATE INDEX IF NOT EXISTS risk_snapshot_canonicality_latest_idx
  ON risk_snapshot_canonicality (validated_at DESC, risk_run_id DESC);
`;
