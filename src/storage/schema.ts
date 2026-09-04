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

CREATE TABLE IF NOT EXISTS v3_nft_position_snapshots (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  computed_at TIMESTAMPTZ NOT NULL,
  position_manager TEXT NOT NULL,
  token_id NUMERIC(78, 0) NOT NULL,
  owner_address TEXT NOT NULL,
  operator TEXT NOT NULL,
  nonce NUMERIC(78, 0) NOT NULL,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  token0_decimals INTEGER NOT NULL,
  token1_decimals INTEGER NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  current_tick INTEGER NOT NULL,
  sqrt_price_x96 NUMERIC(78, 0) NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  region TEXT NOT NULL,
  principal0 NUMERIC(78, 0) NOT NULL,
  principal1 NUMERIC(78, 0) NOT NULL,
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
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (
    schema_version, accounting_run_id, position_manager, token_id
  ),
  CHECK (token_id > 0 AND nonce >= 0),
  CHECK (token0_decimals BETWEEN 0 AND 255),
  CHECK (token1_decimals BETWEEN 0 AND 255),
  CHECK (tick_lower < tick_upper),
  CHECK (liquidity >= 0),
  CHECK (region IN ('below_range', 'in_range', 'above_range', 'empty')),
  CHECK (
    (liquidity = 0 AND region = 'empty' AND principal0 = 0 AND
      principal1 = 0 AND pending0 = 0 AND pending1 = 0 AND
      fee_growth_inside0_x128 IS NULL AND
      fee_growth_inside1_x128 IS NULL) OR
    (liquidity > 0 AND region <> 'empty' AND
      fee_growth_inside0_x128 IS NOT NULL AND
      fee_growth_inside1_x128 IS NOT NULL)
  ),
  CHECK (
    principal0 >= 0 AND principal1 >= 0 AND
    tokens_owed0 >= 0 AND tokens_owed1 >= 0 AND
    pending0 >= 0 AND pending1 >= 0
  ),
  CHECK (claimable0 = tokens_owed0 + pending0),
  CHECK (claimable1 = tokens_owed1 + pending1),
  CHECK (methodology = 'npm_position_value_exact'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_nft_position_snapshots_latest_idx
  ON v3_nft_position_snapshots (
    position_manager, token_id, accounting_run_id DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS v3_range_simulation_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  from_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  to_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  computed_at TIMESTAMPTZ NOT NULL,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  quote_token TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  budget_quote NUMERIC(78, 0) NOT NULL,
  cost_quote NUMERIC(78, 0) NOT NULL,
  tick_spacing INTEGER NOT NULL,
  path_min_tick INTEGER NOT NULL,
  path_max_tick INTEGER NOT NULL,
  swap_count NUMERIC(78, 0) NOT NULL,
  policy_set_hash TEXT NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  completed_candidates INTEGER NOT NULL,
  excluded_candidates INTEGER NOT NULL,
  assumptions JSONB NOT NULL,
  UNIQUE (
    schema_version, stream_key, from_accounting_run_id,
    to_accounting_run_id, pool_address, policy_set_hash
  ),
  CHECK (from_accounting_run_id <> to_accounting_run_id),
  CHECK (quote_decimals = 6),
  CHECK (budget_quote > 0 AND cost_quote >= 0 AND cost_quote <= budget_quote),
  CHECK (tick_spacing > 0 AND path_min_tick <= path_max_tick),
  CHECK (swap_count >= 0),
  CHECK (completed_candidates >= 0 AND excluded_candidates >= 0),
  CHECK (completed_candidates + excluded_candidates > 0),
  CHECK (methodology = 'static_centered_observed_fee_growth_v1'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_range_simulation_runs_latest_idx
  ON v3_range_simulation_runs (stream_key, computed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_range_simulation_candidates (
  simulation_run_id BIGINT NOT NULL
    REFERENCES v3_range_simulation_runs(id) ON DELETE CASCADE,
  half_width_spacings INTEGER NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  status TEXT NOT NULL,
  exclusion_reason TEXT,
  rank INTEGER,
  liquidity NUMERIC(78, 0) NOT NULL,
  liquidity_share_ppm NUMERIC(78, 0) NOT NULL,
  start_amount0 NUMERIC(78, 0) NOT NULL,
  start_amount1 NUMERIC(78, 0) NOT NULL,
  idle_quote NUMERIC(78, 0) NOT NULL,
  end_amount0 NUMERIC(78, 0),
  end_amount1 NUMERIC(78, 0),
  fee0 NUMERIC(78, 0),
  fee1 NUMERIC(78, 0),
  end_principal_value_quote NUMERIC(78, 0),
  fee_value_quote NUMERIC(78, 0),
  gross_end_value_quote NUMERIC(78, 0),
  net_end_value_quote NUMERIC(78, 0),
  hodl_end_value_quote NUMERIC(78, 0),
  divergence_quote NUMERIC(78, 0),
  absolute_pnl_quote NUMERIC(78, 0),
  lp_alpha_quote NUMERIC(78, 0),
  PRIMARY KEY (simulation_run_id, half_width_spacings),
  CHECK (half_width_spacings > 0 AND tick_lower < tick_upper),
  CHECK (
    liquidity >= 0 AND liquidity_share_ppm >= 0 AND
    start_amount0 >= 0 AND start_amount1 >= 0 AND idle_quote >= 0
  ),
  CHECK (
    (status = 'complete' AND exclusion_reason IS NULL AND
      rank IS NOT NULL AND rank > 0 AND liquidity > 0 AND
      end_amount0 IS NOT NULL AND end_amount0 >= 0 AND
      end_amount1 IS NOT NULL AND end_amount1 >= 0 AND
      fee0 IS NOT NULL AND fee0 >= 0 AND fee1 IS NOT NULL AND fee1 >= 0 AND
      end_principal_value_quote IS NOT NULL AND
      end_principal_value_quote >= 0 AND fee_value_quote IS NOT NULL AND
      fee_value_quote >= 0 AND gross_end_value_quote IS NOT NULL AND
      gross_end_value_quote >= 0 AND net_end_value_quote IS NOT NULL AND
      hodl_end_value_quote IS NOT NULL AND hodl_end_value_quote >= 0 AND
      divergence_quote IS NOT NULL AND absolute_pnl_quote IS NOT NULL AND
      lp_alpha_quote IS NOT NULL) OR
    (status = 'excluded' AND exclusion_reason IS NOT NULL AND rank IS NULL AND
      end_amount0 IS NULL AND end_amount1 IS NULL AND fee0 IS NULL AND
      fee1 IS NULL AND end_principal_value_quote IS NULL AND
      fee_value_quote IS NULL AND gross_end_value_quote IS NULL AND
      net_end_value_quote IS NULL AND hodl_end_value_quote IS NULL AND
      divergence_quote IS NULL AND absolute_pnl_quote IS NULL AND
      lp_alpha_quote IS NULL)
  )
);

ALTER TABLE v3_range_simulation_candidates
  ADD COLUMN IF NOT EXISTS divergence_quote NUMERIC(78, 0);

UPDATE v3_range_simulation_candidates
SET divergence_quote = end_principal_value_quote + idle_quote -
  hodl_end_value_quote
WHERE status = 'complete' AND divergence_quote IS NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'v3_range_simulation_candidates_divergence_status'
      AND conrelid = 'v3_range_simulation_candidates'::regclass
  ) THEN
    ALTER TABLE v3_range_simulation_candidates
      ADD CONSTRAINT v3_range_simulation_candidates_divergence_status
      CHECK (
        (status = 'complete' AND divergence_quote IS NOT NULL) OR
        (status = 'excluded' AND divergence_quote IS NULL)
      );
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS v3_range_policy_replay_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  first_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  last_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  computed_at TIMESTAMPTZ NOT NULL,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  quote_token TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  budget_quote NUMERIC(78, 0) NOT NULL,
  entry_cost_quote NUMERIC(78, 0) NOT NULL,
  rebalance_cost_quote NUMERIC(78, 0) NOT NULL,
  trigger_percent INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  checkpoint_count INTEGER NOT NULL,
  interval_count INTEGER NOT NULL,
  policy_set_hash TEXT NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  completed_candidates INTEGER NOT NULL,
  excluded_candidates INTEGER NOT NULL,
  assumptions JSONB NOT NULL,
  UNIQUE (
    schema_version, stream_key, first_accounting_run_id,
    last_accounting_run_id, pool_address, policy_set_hash
  ),
  CHECK (first_accounting_run_id <> last_accounting_run_id),
  CHECK (quote_decimals = 6),
  CHECK (
    budget_quote > 0 AND entry_cost_quote >= 0 AND
    entry_cost_quote < budget_quote AND rebalance_cost_quote >= 0
  ),
  CHECK (trigger_percent BETWEEN 1 AND 100),
  CHECK (tick_spacing > 0),
  CHECK (checkpoint_count >= 2 AND interval_count = checkpoint_count - 1),
  CHECK (completed_candidates >= 0 AND excluded_candidates >= 0),
  CHECK (completed_candidates + excluded_candidates > 0),
  CHECK (methodology = 'stateful_certified_interval_replay_v1'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_range_policy_replay_runs_latest_idx
  ON v3_range_policy_replay_runs (stream_key, computed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_range_policy_replay_candidates (
  replay_run_id BIGINT NOT NULL
    REFERENCES v3_range_policy_replay_runs(id) ON DELETE CASCADE,
  half_width_spacings INTEGER NOT NULL,
  status TEXT NOT NULL,
  failure_reason TEXT,
  failure_run_id BIGINT REFERENCES v3_fee_accounting_runs(id),
  rank INTEGER,
  completed_intervals INTEGER NOT NULL,
  rebalances INTEGER NOT NULL,
  total_cost_quote NUMERIC(78, 0) NOT NULL,
  fee_value_quote NUMERIC(78, 0) NOT NULL,
  max_drawdown_ppm NUMERIC(78, 0) NOT NULL,
  final_liquidity NUMERIC(78, 0),
  final_tick_lower INTEGER,
  final_tick_upper INTEGER,
  final_nav_quote NUMERIC(78, 0),
  hodl_end_value_quote NUMERIC(78, 0),
  absolute_pnl_quote NUMERIC(78, 0),
  lp_alpha_quote NUMERIC(78, 0),
  PRIMARY KEY (replay_run_id, half_width_spacings),
  CHECK (half_width_spacings > 0),
  CHECK (
    completed_intervals >= 0 AND rebalances >= 0 AND
    rebalances <= completed_intervals
  ),
  CHECK (
    total_cost_quote >= 0 AND fee_value_quote >= 0 AND
    max_drawdown_ppm >= 0 AND max_drawdown_ppm <= 1000000
  ),
  CHECK (
    (status = 'complete' AND failure_reason IS NULL AND
      failure_run_id IS NULL AND rank IS NOT NULL AND rank > 0 AND
      final_liquidity IS NOT NULL AND final_liquidity > 0 AND
      final_tick_lower IS NOT NULL AND final_tick_upper IS NOT NULL AND
      final_tick_lower < final_tick_upper AND final_nav_quote IS NOT NULL AND
      final_nav_quote >= 0 AND hodl_end_value_quote IS NOT NULL AND
      hodl_end_value_quote >= 0 AND absolute_pnl_quote IS NOT NULL AND
      lp_alpha_quote IS NOT NULL) OR
    (status = 'excluded' AND failure_reason IS NOT NULL AND
      failure_run_id IS NOT NULL AND rank IS NULL AND
      final_liquidity IS NULL AND final_tick_lower IS NULL AND
      final_tick_upper IS NULL AND final_nav_quote IS NULL AND
      hodl_end_value_quote IS NULL AND absolute_pnl_quote IS NULL AND
      lp_alpha_quote IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS v3_range_policy_replay_steps (
  replay_run_id BIGINT NOT NULL
    REFERENCES v3_range_policy_replay_runs(id) ON DELETE CASCADE,
  half_width_spacings INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  from_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  to_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  path_min_tick INTEGER NOT NULL,
  path_max_tick INTEGER NOT NULL,
  fee0 NUMERIC(78, 0) NOT NULL,
  fee1 NUMERIC(78, 0) NOT NULL,
  fee_value_quote NUMERIC(78, 0) NOT NULL,
  nav_quote NUMERIC(78, 0) NOT NULL,
  hodl_value_quote NUMERIC(78, 0) NOT NULL,
  lp_alpha_quote NUMERIC(78, 0) NOT NULL,
  rebalanced BOOLEAN NOT NULL,
  action_cost_quote NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (replay_run_id, half_width_spacings, step_index),
  FOREIGN KEY (replay_run_id, half_width_spacings)
    REFERENCES v3_range_policy_replay_candidates(
      replay_run_id, half_width_spacings
    ) ON DELETE CASCADE,
  CHECK (step_index >= 0),
  CHECK (from_accounting_run_id <> to_accounting_run_id),
  CHECK (tick_lower < tick_upper AND path_min_tick <= path_max_tick),
  CHECK (
    fee0 >= 0 AND fee1 >= 0 AND fee_value_quote >= 0 AND
    nav_quote >= 0 AND hodl_value_quote >= 0 AND action_cost_quote >= 0
  ),
  CHECK (
    (rebalanced AND action_cost_quote >= 0) OR
    (NOT rebalanced AND action_cost_quote = 0)
  )
);

CREATE TABLE IF NOT EXISTS v3_range_oracle_calibration_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  first_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  last_accounting_run_id BIGINT NOT NULL
    REFERENCES v3_fee_accounting_runs(id),
  computed_at TIMESTAMPTZ NOT NULL,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  quote_token TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  rwa_decimals INTEGER NOT NULL,
  rwa_feed_address TEXT NOT NULL,
  quote_feed_address TEXT NOT NULL,
  max_price_age_seconds INTEGER NOT NULL,
  registry_fetched_at TIMESTAMPTZ NOT NULL,
  registry_sha256 TEXT NOT NULL,
  registry_url TEXT NOT NULL,
  feed_directory_fetched_at TIMESTAMPTZ NOT NULL,
  feed_directory_sha256 TEXT NOT NULL,
  feed_directory_url TEXT NOT NULL,
  calibration_hash TEXT NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  valid_marks INTEGER NOT NULL,
  excluded_marks INTEGER NOT NULL,
  assumptions JSONB NOT NULL,
  registry_asset JSONB NOT NULL,
  rwa_feed JSONB NOT NULL,
  quote_feed JSONB NOT NULL,
  UNIQUE (
    schema_version, stream_key, first_accounting_run_id,
    last_accounting_run_id, pool_address, calibration_hash
  ),
  CHECK (first_accounting_run_id <> last_accounting_run_id),
  CHECK (quote_decimals = 6),
  CHECK (rwa_decimals BETWEEN 0 AND 255),
  CHECK (max_price_age_seconds > 0),
  CHECK (valid_marks >= 0 AND excluded_marks >= 0),
  CHECK (valid_marks + excluded_marks >= 2),
  CHECK (methodology = 'block_pinned_multiplier_adjusted_oracle_basis_v1'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_range_oracle_calibration_runs_latest_idx
  ON v3_range_oracle_calibration_runs (
    stream_key, computed_at DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS v3_range_oracle_calibration_marks (
  calibration_run_id BIGINT NOT NULL
    REFERENCES v3_range_oracle_calibration_runs(id) ON DELETE CASCADE,
  accounting_run_id BIGINT NOT NULL REFERENCES v3_fee_accounting_runs(id),
  status TEXT NOT NULL,
  reasons JSONB NOT NULL,
  pool_price_x18 NUMERIC(78, 0) NOT NULL,
  oracle_price_x18 NUMERIC(78, 0),
  deviation_ppm NUMERIC(78, 0),
  rwa_oracle_answer NUMERIC(78, 0),
  rwa_oracle_updated_at NUMERIC(78, 0),
  rwa_oracle_age_seconds BIGINT,
  quote_oracle_answer NUMERIC(78, 0),
  quote_oracle_updated_at NUMERIC(78, 0),
  quote_oracle_age_seconds BIGINT,
  token_decimals INTEGER,
  token_ui_multiplier NUMERIC(78, 0),
  token_new_ui_multiplier NUMERIC(78, 0),
  token_multiplier_effective_at NUMERIC(78, 0),
  token_oracle_paused BOOLEAN,
  mark JSONB NOT NULL,
  PRIMARY KEY (calibration_run_id, accounting_run_id),
  CHECK (pool_price_x18 > 0),
  CHECK (oracle_price_x18 IS NULL OR oracle_price_x18 > 0),
  CHECK (
    rwa_oracle_age_seconds IS NULL OR rwa_oracle_age_seconds >= 0
  ),
  CHECK (
    quote_oracle_age_seconds IS NULL OR quote_oracle_age_seconds >= 0
  ),
  CHECK (
    (status = 'valid' AND jsonb_array_length(reasons) = 0 AND
      oracle_price_x18 IS NOT NULL AND deviation_ppm IS NOT NULL AND
      rwa_oracle_answer IS NOT NULL AND rwa_oracle_answer > 0 AND
      quote_oracle_answer IS NOT NULL AND quote_oracle_answer > 0 AND
      token_ui_multiplier IS NOT NULL AND token_ui_multiplier > 0 AND
      token_new_ui_multiplier = token_ui_multiplier AND
      token_oracle_paused = FALSE) OR
    (status = 'excluded' AND jsonb_array_length(reasons) > 0)
  )
);

ALTER TABLE v3_range_oracle_calibration_marks
  ADD COLUMN IF NOT EXISTS token_decimals INTEGER;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'v3_range_oracle_calibration_marks_token_decimals'
      AND conrelid = 'v3_range_oracle_calibration_marks'::regclass
  ) THEN
    ALTER TABLE v3_range_oracle_calibration_marks
      ADD CONSTRAINT v3_range_oracle_calibration_marks_token_decimals
      CHECK (
        (token_decimals IS NULL OR token_decimals BETWEEN 0 AND 255) AND
        (status = 'excluded' OR token_decimals IS NOT NULL)
      );
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

CREATE TABLE IF NOT EXISTS v3_strategy_checkpoint_runs (
  id BIGSERIAL PRIMARY KEY,
  risk_run_id BIGINT NOT NULL UNIQUE
    REFERENCES risk_snapshot_runs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  target_set_hash TEXT NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  valid_pools INTEGER NOT NULL,
  excluded_pools INTEGER NOT NULL,
  assumptions JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  CHECK (schema_version = 1),
  CHECK (methodology = 'synchronized_risk_pool_checkpoint_v1'),
  CHECK (NOT execution_eligible),
  CHECK (valid_pools >= 0 AND excluded_pools >= 0),
  CHECK (valid_pools + excluded_pools > 0)
);

CREATE INDEX IF NOT EXISTS v3_strategy_checkpoint_runs_latest_idx
  ON v3_strategy_checkpoint_runs (stream_key, block_number DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_strategy_pool_checkpoints (
  checkpoint_run_id BIGINT NOT NULL
    REFERENCES v3_strategy_checkpoint_runs(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  rwa_address TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  tick INTEGER NOT NULL,
  sqrt_price_x96 NUMERIC(78, 0) NOT NULL,
  liquidity NUMERIC(78, 0) NOT NULL,
  fee_growth_global0_x128 NUMERIC(78, 0) NOT NULL,
  fee_growth_global1_x128 NUMERIC(78, 0) NOT NULL,
  pool_unlocked BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  reasons JSONB NOT NULL,
  pool_price_x18 NUMERIC(78, 0) NOT NULL,
  oracle_price_x18 NUMERIC(78, 0),
  deviation_ppm NUMERIC(78, 0),
  rwa_oracle_round_id NUMERIC(78, 0),
  quote_oracle_round_id NUMERIC(78, 0),
  token_decimals INTEGER,
  checkpoint JSONB NOT NULL,
  PRIMARY KEY (checkpoint_run_id, pool_address),
  CHECK (fee > 0 AND fee <= 1000000),
  CHECK (sqrt_price_x96 > 0 AND liquidity >= 0),
  CHECK (fee_growth_global0_x128 >= 0 AND fee_growth_global1_x128 >= 0),
  CHECK (pool_price_x18 > 0),
  CHECK (oracle_price_x18 IS NULL OR oracle_price_x18 > 0),
  CHECK (token_decimals IS NULL OR token_decimals BETWEEN 0 AND 255),
  CHECK (
    (status = 'valid' AND jsonb_array_length(reasons) = 0 AND
      pool_unlocked AND liquidity > 0 AND oracle_price_x18 IS NOT NULL AND
      deviation_ppm IS NOT NULL AND token_decimals IS NOT NULL) OR
    (status = 'excluded' AND jsonb_array_length(reasons) > 0)
  )
);
`;
