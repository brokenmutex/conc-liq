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

CREATE TABLE IF NOT EXISTS v3_oracle_policy_replay_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  first_checkpoint_run_id BIGINT NOT NULL
    REFERENCES v3_strategy_checkpoint_runs(id),
  last_checkpoint_run_id BIGINT NOT NULL
    REFERENCES v3_strategy_checkpoint_runs(id),
  computed_at TIMESTAMPTZ NOT NULL,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  rwa_address TEXT NOT NULL,
  fee INTEGER NOT NULL,
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  quote_token TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  rwa_decimals INTEGER NOT NULL,
  target_set_hash TEXT NOT NULL,
  indexed_through_block NUMERIC(78, 0) NOT NULL,
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
    schema_version, stream_key, first_checkpoint_run_id,
    last_checkpoint_run_id, pool_address, policy_set_hash
  ),
  CHECK (schema_version = 1),
  CHECK (first_checkpoint_run_id <> last_checkpoint_run_id),
  CHECK (quote_decimals = 6 AND rwa_decimals BETWEEN 0 AND 255),
  CHECK (fee > 0 AND fee <= 1000000),
  CHECK (indexed_through_block >= 0),
  CHECK (
    budget_quote > 0 AND entry_cost_quote >= 0 AND
    entry_cost_quote < budget_quote AND rebalance_cost_quote >= 0
  ),
  CHECK (trigger_percent BETWEEN 1 AND 100 AND tick_spacing > 0),
  CHECK (checkpoint_count >= 2 AND interval_count = checkpoint_count - 1),
  CHECK (completed_candidates >= 0 AND excluded_candidates >= 0),
  CHECK (completed_candidates + excluded_candidates > 0),
  CHECK (methodology = 'oracle_marked_stateful_certified_replay_v1'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_oracle_policy_replay_runs_latest_idx
  ON v3_oracle_policy_replay_runs (stream_key, computed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_oracle_policy_replay_candidates (
  replay_run_id BIGINT NOT NULL
    REFERENCES v3_oracle_policy_replay_runs(id) ON DELETE CASCADE,
  half_width_spacings INTEGER NOT NULL,
  status TEXT NOT NULL,
  failure_reason TEXT,
  failure_checkpoint_run_id BIGINT REFERENCES v3_strategy_checkpoint_runs(id),
  rank INTEGER,
  completed_intervals INTEGER NOT NULL,
  rebalances INTEGER NOT NULL,
  total_cost_quote NUMERIC(78, 0) NOT NULL,
  marked_fee_value_quote NUMERIC(78, 0) NOT NULL,
  max_drawdown_ppm NUMERIC(78, 0) NOT NULL,
  initial_amount0 NUMERIC(78, 0),
  initial_amount1 NUMERIC(78, 0),
  initial_nav_quote NUMERIC(78, 0),
  final_liquidity NUMERIC(78, 0),
  final_tick_lower INTEGER,
  final_tick_upper INTEGER,
  final_amount0 NUMERIC(78, 0),
  final_amount1 NUMERIC(78, 0),
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
    total_cost_quote >= 0 AND marked_fee_value_quote >= 0 AND
    max_drawdown_ppm >= 0 AND max_drawdown_ppm <= 1000000
  ),
  CHECK (
    (initial_amount0 IS NULL AND initial_amount1 IS NULL AND
      initial_nav_quote IS NULL) OR
    (initial_amount0 IS NOT NULL AND initial_amount0 >= 0 AND
      initial_amount1 IS NOT NULL AND initial_amount1 >= 0 AND
      initial_nav_quote IS NOT NULL AND initial_nav_quote >= 0)
  ),
  CHECK (
    (status = 'complete' AND failure_reason IS NULL AND
      failure_checkpoint_run_id IS NULL AND rank IS NOT NULL AND rank > 0 AND
      initial_nav_quote IS NOT NULL AND final_liquidity IS NOT NULL AND
      final_liquidity > 0 AND final_tick_lower IS NOT NULL AND
      final_tick_upper IS NOT NULL AND final_tick_lower < final_tick_upper AND
      final_amount0 IS NOT NULL AND final_amount0 >= 0 AND
      final_amount1 IS NOT NULL AND final_amount1 >= 0 AND
      final_nav_quote IS NOT NULL AND final_nav_quote >= 0 AND
      hodl_end_value_quote IS NOT NULL AND hodl_end_value_quote >= 0 AND
      absolute_pnl_quote IS NOT NULL AND lp_alpha_quote IS NOT NULL) OR
    (status = 'excluded' AND failure_reason IS NOT NULL AND
      failure_checkpoint_run_id IS NOT NULL AND rank IS NULL AND
      final_liquidity IS NULL AND final_tick_lower IS NULL AND
      final_tick_upper IS NULL AND final_amount0 IS NULL AND
      final_amount1 IS NULL AND final_nav_quote IS NULL AND
      hodl_end_value_quote IS NULL AND absolute_pnl_quote IS NULL AND
      lp_alpha_quote IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS v3_oracle_policy_replay_steps (
  replay_run_id BIGINT NOT NULL
    REFERENCES v3_oracle_policy_replay_runs(id) ON DELETE CASCADE,
  half_width_spacings INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  from_checkpoint_run_id BIGINT NOT NULL
    REFERENCES v3_strategy_checkpoint_runs(id),
  to_checkpoint_run_id BIGINT NOT NULL
    REFERENCES v3_strategy_checkpoint_runs(id),
  active_tick_lower INTEGER NOT NULL,
  active_tick_upper INTEGER NOT NULL,
  ending_tick_lower INTEGER NOT NULL,
  ending_tick_upper INTEGER NOT NULL,
  path_min_tick INTEGER NOT NULL,
  path_max_tick INTEGER NOT NULL,
  fee0 NUMERIC(78, 0) NOT NULL,
  fee1 NUMERIC(78, 0) NOT NULL,
  fee_value_quote NUMERIC(78, 0) NOT NULL,
  end_amount0 NUMERIC(78, 0) NOT NULL,
  end_amount1 NUMERIC(78, 0) NOT NULL,
  pool_spot_nav_before_action_quote NUMERIC(78, 0) NOT NULL,
  oracle_price_x18 NUMERIC(78, 0) NOT NULL,
  pool_price_x18 NUMERIC(78, 0) NOT NULL,
  nav_quote NUMERIC(78, 0) NOT NULL,
  hodl_value_quote NUMERIC(78, 0) NOT NULL,
  lp_alpha_quote NUMERIC(78, 0) NOT NULL,
  rebalanced BOOLEAN NOT NULL,
  action_cost_quote NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (replay_run_id, half_width_spacings, step_index),
  FOREIGN KEY (replay_run_id, half_width_spacings)
    REFERENCES v3_oracle_policy_replay_candidates(
      replay_run_id, half_width_spacings
    ) ON DELETE CASCADE,
  CHECK (step_index >= 0),
  CHECK (from_checkpoint_run_id <> to_checkpoint_run_id),
  CHECK (
    active_tick_lower < active_tick_upper AND
    ending_tick_lower < ending_tick_upper AND path_min_tick <= path_max_tick
  ),
  CHECK (
    fee0 >= 0 AND fee1 >= 0 AND fee_value_quote >= 0 AND
    end_amount0 >= 0 AND end_amount1 >= 0 AND
    pool_spot_nav_before_action_quote >= 0 AND oracle_price_x18 > 0 AND
    pool_price_x18 > 0 AND nav_quote >= 0 AND hodl_value_quote >= 0 AND
    action_cost_quote >= 0
  ),
  CHECK (rebalanced OR action_cost_quote = 0)
);

CREATE TABLE IF NOT EXISTS v3_action_cost_observations (
  stream_key TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  chain_id BIGINT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_index INTEGER NOT NULL,
  sender_address TEXT NOT NULL,
  recipient_address TEXT,
  selector TEXT,
  input_bytes INTEGER NOT NULL,
  action_class TEXT NOT NULL,
  action_names JSONB NOT NULL,
  event_counts JSONB NOT NULL,
  pool_addresses JSONB NOT NULL,
  attribution TEXT NOT NULL,
  gas_used NUMERIC(78, 0) NOT NULL,
  gas_used_for_l1 NUMERIC(78, 0),
  l2_execution_gas_used NUMERIC(78, 0),
  effective_gas_price NUMERIC(78, 0) NOT NULL,
  total_fee_wei NUMERIC(78, 0) NOT NULL,
  l1_data_fee_wei NUMERIC(78, 0),
  l2_execution_fee_wei NUMERIC(78, 0),
  fee_components_complete BOOLEAN NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (stream_key, transaction_hash),
  CHECK (schema_version = 1),
  CHECK (chain_id > 0 AND block_number >= 0 AND transaction_index >= 0),
  CHECK (input_bytes >= 0),
  CHECK (action_class IN (
    'collect_bundle', 'exit_bundle', 'mint_bundle', 'mixed',
    'rebalance_bundle', 'swap_only'
  )),
  CHECK (jsonb_typeof(action_names) = 'array'),
  CHECK (jsonb_typeof(event_counts) = 'object'),
  CHECK (jsonb_typeof(pool_addresses) = 'array'),
  CHECK (attribution = 'whole_transaction_action_mix'),
  CHECK (
    gas_used >= 0 AND effective_gas_price >= 0 AND
    total_fee_wei = gas_used * effective_gas_price
  ),
  CHECK (
    (fee_components_complete AND gas_used_for_l1 IS NOT NULL AND
      l2_execution_gas_used IS NOT NULL AND l1_data_fee_wei IS NOT NULL AND
      l2_execution_fee_wei IS NOT NULL AND gas_used_for_l1 <= gas_used AND
      l2_execution_gas_used = gas_used - gas_used_for_l1 AND
      l1_data_fee_wei = gas_used_for_l1 * effective_gas_price AND
      l2_execution_fee_wei = l2_execution_gas_used * effective_gas_price AND
      total_fee_wei = l1_data_fee_wei + l2_execution_fee_wei) OR
    (NOT fee_components_complete AND gas_used_for_l1 IS NULL AND
      l2_execution_gas_used IS NULL AND l1_data_fee_wei IS NULL AND
      l2_execution_fee_wei IS NULL)
  ),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_action_cost_observations_class_idx
  ON v3_action_cost_observations (
    stream_key, action_class, block_number DESC, transaction_index DESC
  );

CREATE TABLE IF NOT EXISTS v3_action_cost_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  from_block NUMERIC(78, 0) NOT NULL,
  to_block NUMERIC(78, 0) NOT NULL,
  to_block_hash TEXT NOT NULL,
  target_set_hash TEXT NOT NULL,
  max_per_class INTEGER NOT NULL,
  eligible_candidates INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  complete_fee_components INTEGER NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at TIMESTAMPTZ NOT NULL,
  summary JSONB NOT NULL,
  UNIQUE (schema_version, stream_key, from_block, to_block, max_per_class),
  CHECK (schema_version = 1),
  CHECK (chain_id > 0 AND from_block >= 0 AND to_block >= from_block),
  CHECK (
    max_per_class > 0 AND eligible_candidates >= observation_count AND
    observation_count >= complete_fee_components AND
    complete_fee_components >= 0
  ),
  CHECK (methodology = 'stratified_canonical_receipt_cost_v1'),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_action_cost_runs_recent_idx
  ON v3_action_cost_runs (stream_key, to_block DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_action_cost_run_observations (
  run_id BIGINT NOT NULL REFERENCES v3_action_cost_runs(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, transaction_hash),
  FOREIGN KEY (stream_key, transaction_hash)
    REFERENCES v3_action_cost_observations(stream_key, transaction_hash)
);

CREATE TABLE IF NOT EXISTS v3_action_cost_valuation_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  action_cost_run_id BIGINT NOT NULL
    REFERENCES v3_action_cost_runs(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  feed_directory_sha256 TEXT NOT NULL,
  feed_directory JSONB NOT NULL,
  eth_feed JSONB NOT NULL,
  quote_feed JSONB NOT NULL,
  max_price_age_seconds INTEGER NOT NULL,
  quote_decimals INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  valid_observations INTEGER NOT NULL,
  excluded_observations INTEGER NOT NULL,
  complete_fee_components INTEGER NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at TIMESTAMPTZ NOT NULL,
  summary JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (
    schema_version, action_cost_run_id, feed_directory_sha256,
    max_price_age_seconds
  ),
  CHECK (schema_version = 1),
  CHECK (chain_id > 0),
  CHECK (feed_directory_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(feed_directory) = 'object'),
  CHECK (jsonb_typeof(eth_feed) = 'object'),
  CHECK (jsonb_typeof(quote_feed) = 'object'),
  CHECK (max_price_age_seconds > 0 AND quote_decimals >= 0),
  CHECK (
    observation_count = valid_observations + excluded_observations AND
    observation_count >= complete_fee_components AND
    complete_fee_components >= 0
  ),
  CHECK (methodology = 'block_pinned_eth_usdg_action_cost_v1'),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_action_cost_valuation_runs_recent_idx
  ON v3_action_cost_valuation_runs (stream_key, computed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_action_cost_valuations (
  valuation_run_id BIGINT NOT NULL
    REFERENCES v3_action_cost_valuation_runs(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78, 0),
  action_class TEXT NOT NULL,
  status TEXT NOT NULL,
  reasons JSONB NOT NULL,
  fee_components_complete BOOLEAN NOT NULL,
  total_fee_wei NUMERIC(78, 0) NOT NULL,
  l1_data_fee_wei NUMERIC(78, 0),
  l2_execution_fee_wei NUMERIC(78, 0),
  total_cost_quote_raw NUMERIC(78, 0),
  l1_data_cost_quote_raw NUMERIC(78, 0),
  l2_execution_cost_quote_raw NUMERIC(78, 0),
  eth_oracle JSONB,
  quote_oracle JSONB,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (valuation_run_id, transaction_hash),
  FOREIGN KEY (stream_key, transaction_hash)
    REFERENCES v3_action_cost_observations(stream_key, transaction_hash),
  CHECK (block_number >= 0),
  CHECK (action_class IN (
    'collect_bundle', 'exit_bundle', 'mint_bundle', 'mixed',
    'rebalance_bundle', 'swap_only'
  )),
  CHECK (status IN ('valid', 'excluded')),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (total_fee_wei >= 0),
  CHECK (
    (fee_components_complete AND l1_data_fee_wei IS NOT NULL AND
      l2_execution_fee_wei IS NOT NULL AND
      total_fee_wei = l1_data_fee_wei + l2_execution_fee_wei) OR
    (NOT fee_components_complete AND l1_data_fee_wei IS NULL AND
      l2_execution_fee_wei IS NULL)
  ),
  CHECK (
    (status = 'valid' AND block_timestamp IS NOT NULL AND
      total_cost_quote_raw IS NOT NULL AND total_cost_quote_raw >= 0 AND
      jsonb_array_length(reasons) = 0 AND eth_oracle IS NOT NULL AND
      quote_oracle IS NOT NULL) OR
    (status = 'excluded' AND total_cost_quote_raw IS NULL AND
      l1_data_cost_quote_raw IS NULL AND
      l2_execution_cost_quote_raw IS NULL AND
      jsonb_array_length(reasons) > 0)
  ),
  CHECK (
    (status = 'valid' AND fee_components_complete AND
      l1_data_cost_quote_raw IS NOT NULL AND
      l2_execution_cost_quote_raw IS NOT NULL AND
      total_cost_quote_raw >=
        l1_data_cost_quote_raw + l2_execution_cost_quote_raw - 1) OR
    (status = 'valid' AND NOT fee_components_complete AND
      l1_data_cost_quote_raw IS NULL AND
      l2_execution_cost_quote_raw IS NULL) OR
    status = 'excluded'
  ),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS v3_action_cost_call_assessment_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  valuation_run_id BIGINT NOT NULL
    REFERENCES v3_action_cost_valuation_runs(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  position_manager_address TEXT NOT NULL,
  observation_count INTEGER NOT NULL,
  comparable_observations INTEGER NOT NULL,
  opaque_observations INTEGER NOT NULL,
  excluded_observations INTEGER NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at TIMESTAMPTZ NOT NULL,
  summary JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (schema_version, valuation_run_id, position_manager_address),
  CHECK (schema_version = 1),
  CHECK (
    observation_count = comparable_observations + opaque_observations +
      excluded_observations
  ),
  CHECK (methodology = 'position_manager_selector_comparability_v1'),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (NOT execution_eligible)
);

CREATE TABLE IF NOT EXISTS v3_action_cost_call_assessments (
  assessment_run_id BIGINT NOT NULL
    REFERENCES v3_action_cost_call_assessment_runs(id) ON DELETE CASCADE,
  valuation_run_id BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  action_class TEXT NOT NULL,
  recipient_address TEXT,
  selector TEXT,
  call_family TEXT NOT NULL,
  intended_action TEXT,
  status TEXT NOT NULL,
  reasons JSONB NOT NULL,
  total_cost_quote_raw NUMERIC(78, 0),
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (assessment_run_id, transaction_hash),
  FOREIGN KEY (valuation_run_id, transaction_hash)
    REFERENCES v3_action_cost_valuations(valuation_run_id, transaction_hash),
  CHECK (call_family IN (
    'position_manager_mint', 'position_manager_increase',
    'position_manager_decrease', 'position_manager_collect',
    'position_manager_multicall', 'position_manager_other', 'external_call'
  )),
  CHECK (intended_action IS NULL OR intended_action IN (
    'initial_mint', 'increase_liquidity', 'decrease_liquidity', 'collect_fees'
  )),
  CHECK (status IN ('comparable', 'opaque', 'excluded')),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (
    (status = 'comparable' AND intended_action IS NOT NULL AND
      total_cost_quote_raw IS NOT NULL AND jsonb_array_length(reasons) = 0) OR
    (status <> 'comparable' AND jsonb_array_length(reasons) > 0)
  ),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS v3_approval_cost_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  from_block NUMERIC(78, 0) NOT NULL,
  to_block NUMERIC(78, 0) NOT NULL,
  to_block_hash TEXT NOT NULL,
  target_set_hash TEXT NOT NULL,
  position_manager_address TEXT NOT NULL,
  max_per_token INTEGER NOT NULL,
  eligible_candidates INTEGER NOT NULL,
  selected_candidates INTEGER NOT NULL,
  comparable_observations INTEGER NOT NULL,
  excluded_observations INTEGER NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at TIMESTAMPTZ NOT NULL,
  summary JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (
    schema_version, stream_key, from_block, to_block, max_per_token,
    position_manager_address
  ),
  CHECK (schema_version = 1),
  CHECK (chain_id > 0 AND from_block >= 0 AND to_block >= from_block),
  CHECK (max_per_token > 0),
  CHECK (
    eligible_candidates >= selected_candidates AND
    selected_candidates = comparable_observations + excluded_observations
  ),
  CHECK (methodology = 'direct_position_manager_approval_cost_v1'),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (NOT execution_eligible)
);

CREATE INDEX IF NOT EXISTS v3_approval_cost_runs_recent_idx
  ON v3_approval_cost_runs (stream_key, to_block DESC, id DESC);

CREATE TABLE IF NOT EXISTS v3_approval_cost_observations (
  run_id BIGINT NOT NULL REFERENCES v3_approval_cost_runs(id) ON DELETE CASCADE,
  transaction_hash TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_index INTEGER NOT NULL,
  token_addresses JSONB NOT NULL,
  approval_events JSONB NOT NULL,
  owner_address TEXT,
  spender_address TEXT,
  approved_value NUMERIC(78, 0),
  allowance_before NUMERIC(78, 0),
  allowance_after NUMERIC(78, 0),
  allowance_transition TEXT,
  recipient_address TEXT,
  selector TEXT,
  status TEXT NOT NULL,
  reasons JSONB NOT NULL,
  gas_used NUMERIC(78, 0) NOT NULL,
  gas_used_for_l1 NUMERIC(78, 0),
  l2_execution_gas_used NUMERIC(78, 0),
  effective_gas_price NUMERIC(78, 0) NOT NULL,
  total_fee_wei NUMERIC(78, 0) NOT NULL,
  l1_data_fee_wei NUMERIC(78, 0),
  l2_execution_fee_wei NUMERIC(78, 0),
  fee_components_complete BOOLEAN NOT NULL,
  attribution TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (run_id, transaction_hash),
  CHECK (block_number >= 0 AND transaction_index >= 0),
  CHECK (jsonb_typeof(token_addresses) = 'array'),
  CHECK (jsonb_typeof(approval_events) = 'array'),
  CHECK (status IN ('comparable', 'excluded')),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (allowance_transition IS NULL OR allowance_transition IN (
    'zero_to_nonzero', 'nonzero_to_nonzero', 'to_zero', 'zero_to_zero'
  )),
  CHECK (
    (status = 'comparable' AND allowance_transition = 'zero_to_nonzero' AND
      allowance_before = 0 AND allowance_after = approved_value AND
      approved_value > 0 AND jsonb_array_length(reasons) = 0) OR
    (status = 'excluded' AND jsonb_array_length(reasons) > 0)
  ),
  CHECK (
    gas_used >= 0 AND effective_gas_price >= 0 AND
    total_fee_wei = gas_used * effective_gas_price
  ),
  CHECK (
    (fee_components_complete AND gas_used_for_l1 IS NOT NULL AND
      l2_execution_gas_used IS NOT NULL AND l1_data_fee_wei IS NOT NULL AND
      l2_execution_fee_wei IS NOT NULL AND gas_used_for_l1 <= gas_used AND
      l2_execution_gas_used = gas_used - gas_used_for_l1 AND
      l1_data_fee_wei = gas_used_for_l1 * effective_gas_price AND
      l2_execution_fee_wei = l2_execution_gas_used * effective_gas_price AND
      total_fee_wei = l1_data_fee_wei + l2_execution_fee_wei) OR
    (NOT fee_components_complete AND gas_used_for_l1 IS NULL AND
      l2_execution_gas_used IS NULL AND l1_data_fee_wei IS NULL AND
      l2_execution_fee_wei IS NULL)
  ),
  CHECK (attribution = 'whole_direct_approval_transaction'),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS v3_approval_cost_valuation_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  approval_cost_run_id BIGINT NOT NULL
    REFERENCES v3_approval_cost_runs(id) ON DELETE CASCADE,
  stream_key TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  feed_directory_sha256 TEXT NOT NULL,
  feed_directory JSONB NOT NULL,
  eth_feed JSONB NOT NULL,
  quote_feed JSONB NOT NULL,
  max_price_age_seconds INTEGER NOT NULL,
  quote_decimals INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  valid_observations INTEGER NOT NULL,
  excluded_observations INTEGER NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at TIMESTAMPTZ NOT NULL,
  summary JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (
    schema_version, approval_cost_run_id, feed_directory_sha256,
    max_price_age_seconds
  ),
  CHECK (schema_version = 1),
  CHECK (chain_id > 0),
  CHECK (feed_directory_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (max_price_age_seconds > 0 AND quote_decimals >= 0),
  CHECK (observation_count = valid_observations + excluded_observations),
  CHECK (methodology = 'block_pinned_eth_usdg_approval_cost_v1'),
  CHECK (jsonb_typeof(feed_directory) = 'object'),
  CHECK (jsonb_typeof(eth_feed) = 'object'),
  CHECK (jsonb_typeof(quote_feed) = 'object'),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (NOT execution_eligible)
);

CREATE TABLE IF NOT EXISTS v3_approval_cost_valuations (
  valuation_run_id BIGINT NOT NULL
    REFERENCES v3_approval_cost_valuation_runs(id) ON DELETE CASCADE,
  approval_cost_run_id BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78, 0),
  token_symbols JSONB NOT NULL,
  source_status TEXT NOT NULL,
  status TEXT NOT NULL,
  reasons JSONB NOT NULL,
  total_fee_wei NUMERIC(78, 0) NOT NULL,
  l1_data_fee_wei NUMERIC(78, 0),
  l2_execution_fee_wei NUMERIC(78, 0),
  total_cost_quote_raw NUMERIC(78, 0),
  l1_data_cost_quote_raw NUMERIC(78, 0),
  l2_execution_cost_quote_raw NUMERIC(78, 0),
  eth_oracle JSONB,
  quote_oracle JSONB,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (valuation_run_id, transaction_hash),
  FOREIGN KEY (approval_cost_run_id, transaction_hash)
    REFERENCES v3_approval_cost_observations(run_id, transaction_hash),
  CHECK (block_number >= 0),
  CHECK (jsonb_typeof(token_symbols) = 'array'),
  CHECK (source_status IN ('comparable', 'excluded')),
  CHECK (status IN ('valid', 'excluded')),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (
    (status = 'valid' AND source_status = 'comparable' AND
      block_timestamp IS NOT NULL AND total_cost_quote_raw IS NOT NULL AND
      total_cost_quote_raw >= 0 AND jsonb_array_length(reasons) = 0 AND
      eth_oracle IS NOT NULL AND quote_oracle IS NOT NULL) OR
    (status = 'excluded' AND total_cost_quote_raw IS NULL AND
      l1_data_cost_quote_raw IS NULL AND
      l2_execution_cost_quote_raw IS NULL AND
      jsonb_array_length(reasons) > 0)
  ),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS v3_guarded_cost_models (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  stream_key TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  action_assessment_run_id BIGINT NOT NULL
    REFERENCES v3_action_cost_call_assessment_runs(id),
  approval_valuation_run_id BIGINT NOT NULL
    REFERENCES v3_approval_cost_valuation_runs(id),
  status TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL,
  entry_cost_quote_raw NUMERIC(78, 0),
  rebalance_cost_quote_raw NUMERIC(78, 0),
  reasons JSONB NOT NULL,
  warnings JSONB NOT NULL,
  components JSONB NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (
    schema_version, stream_key, pool_address, action_assessment_run_id,
    approval_valuation_run_id
  ),
  CHECK (schema_version = 1),
  CHECK (fee > 0 AND fee <= 1000000),
  CHECK (status IN ('entry_measured', 'unavailable')),
  CHECK (quote_decimals = 6),
  CHECK (
    (status = 'entry_measured' AND entry_cost_quote_raw IS NOT NULL AND
      entry_cost_quote_raw >= 0) OR
    (status = 'unavailable' AND entry_cost_quote_raw IS NULL)
  ),
  CHECK (rebalance_cost_quote_raw IS NULL),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (jsonb_typeof(warnings) = 'array'),
  CHECK (jsonb_typeof(components) = 'object'),
  CHECK (methodology = 'pool_specific_direct_call_p90_v1'),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS rpc_health_samples (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  allow_bulk BOOLEAN NOT NULL,
  reasons JSONB NOT NULL,
  warnings JSONB NOT NULL,
  reference_count INTEGER NOT NULL,
  reference_quorum INTEGER NOT NULL,
  private_head NUMERIC(78, 0),
  reference_head NUMERIC(78, 0),
  lag_blocks NUMERIC(78, 0),
  lag_seconds BIGINT,
  private_head_timestamp NUMERIC(78, 0),
  reference_head_timestamp NUMERIC(78, 0),
  private_latency_ms INTEGER,
  private_syncing BOOLEAN,
  anchor_block NUMERIC(78, 0),
  anchor_hash TEXT,
  private_anchor_hash TEXT,
  reference_head_spread_blocks NUMERIC(78, 0),
  consecutive_healthy INTEGER NOT NULL,
  consecutive_unhealthy INTEGER NOT NULL,
  private_head_unchanged_since TIMESTAMPTZ,
  snapshot JSONB NOT NULL,
  CHECK (schema_version = 1),
  CHECK (state IN ('healthy', 'degraded', 'open', 'half_open')),
  CHECK (allow_bulk = (state = 'healthy')),
  CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_typeof(warnings) = 'array'),
  CHECK (
    reference_count >= 0 AND reference_quorum >= 2 AND
    consecutive_healthy >= 0 AND consecutive_unhealthy >= 0
  ),
  CHECK (
    private_head IS NULL OR private_head >= 0
  ),
  CHECK (
    reference_head IS NULL OR reference_head >= 0
  ),
  CHECK (
    lag_blocks IS NULL OR lag_blocks >= 0
  ),
  CHECK (
    lag_seconds IS NULL OR lag_seconds >= 0
  ),
  CHECK (
    private_latency_ms IS NULL OR private_latency_ms >= 0
  ),
  CHECK (
    reference_head_spread_blocks IS NULL OR
    reference_head_spread_blocks >= 0
  ),
  CHECK (
    (anchor_block IS NULL AND anchor_hash IS NULL) OR
    (anchor_block IS NOT NULL AND anchor_block >= 0 AND anchor_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS rpc_health_samples_latest_idx
  ON rpc_health_samples (observed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS perp_reference_snapshot_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  dex TEXT NOT NULL,
  coin TEXT NOT NULL,
  asset_index INTEGER NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expected_pricing_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  quality_pass BOOLEAN NOT NULL,
  reasons JSONB NOT NULL,
  limitations JSONB NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot JSONB NOT NULL,
  CHECK (schema_version = 1),
  CHECK (source = 'hyperliquid_info_api'),
  CHECK (asset_index >= 0),
  CHECK (expected_pricing_mode IN (
    'scheduled_internal_weekend', 'external_session_expected'
  )),
  CHECK (status IN ('observed', 'quality_rejected')),
  CHECK (quality_pass = (status = 'observed')),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (jsonb_typeof(limitations) = 'array'),
  CHECK (evidence_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (methodology = 'xyz_hip3_shadow_quality_v1'),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS perp_reference_snapshot_runs_latest_idx
  ON perp_reference_snapshot_runs (dex, coin, observed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS perp_reference_candles (
  source TEXT NOT NULL,
  dex TEXT NOT NULL,
  coin TEXT NOT NULL,
  candle_interval TEXT NOT NULL,
  open_time_ms BIGINT NOT NULL,
  close_time_ms BIGINT NOT NULL,
  open_price_x18 NUMERIC(78, 0) NOT NULL,
  close_price_x18 NUMERIC(78, 0) NOT NULL,
  high_price_x18 NUMERIC(78, 0) NOT NULL,
  low_price_x18 NUMERIC(78, 0) NOT NULL,
  base_volume_x18 NUMERIC(78, 0) NOT NULL,
  trade_count BIGINT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (source, dex, coin, candle_interval, open_time_ms),
  CHECK (source = 'hyperliquid_info_api'),
  CHECK (candle_interval = '1h'),
  CHECK (open_time_ms >= 0 AND close_time_ms > open_time_ms),
  CHECK (
    open_price_x18 > 0 AND close_price_x18 > 0 AND high_price_x18 > 0 AND
    low_price_x18 > 0 AND high_price_x18 >= low_price_x18
  ),
  CHECK (base_volume_x18 >= 0 AND trade_count >= 0),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS perp_weekend_assessment_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  dex TEXT NOT NULL,
  coin TEXT NOT NULL,
  candle_interval TEXT NOT NULL,
  from_time_ms BIGINT NOT NULL,
  to_time_ms BIGINT NOT NULL,
  candle_count INTEGER NOT NULL,
  session_count INTEGER NOT NULL,
  complete_sessions INTEGER NOT NULL,
  excluded_sessions INTEGER NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  summary JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (
    schema_version, source, dex, coin, candle_interval,
    from_time_ms, to_time_ms, evidence_sha256
  ),
  CHECK (schema_version = 1),
  CHECK (source = 'hyperliquid_info_api'),
  CHECK (candle_interval = '1h'),
  CHECK (from_time_ms >= 0 AND to_time_ms > from_time_ms),
  CHECK (candle_count >= 0),
  CHECK (
    session_count = complete_sessions + excluded_sessions AND
    complete_sessions >= 0 AND excluded_sessions >= 0
  ),
  CHECK (evidence_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (methodology = 'xyz_weekend_reopen_assessment_v1'),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS perp_weekend_assessment_sessions (
  assessment_run_id BIGINT NOT NULL
    REFERENCES perp_weekend_assessment_runs(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL,
  reasons JSONB NOT NULL,
  internal_start_ms BIGINT NOT NULL,
  internal_end_ms BIGINT NOT NULL,
  reopen_time_ms BIGINT,
  candle_count INTEGER NOT NULL,
  external_close_price_x18 NUMERIC(78, 0),
  weekend_close_price_x18 NUMERIC(78, 0),
  reopen_price_x18 NUMERIC(78, 0),
  weekend_move_ppm BIGINT,
  reopen_gap_ppm BIGINT,
  max_up_excursion_ppm BIGINT,
  max_down_excursion_ppm BIGINT,
  direction_correct BOOLEAN,
  base_volume_x18 NUMERIC(78, 0) NOT NULL,
  trade_count BIGINT NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (assessment_run_id, session_key),
  CHECK (status IN ('complete', 'excluded')),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (internal_start_ms >= 0 AND internal_end_ms > internal_start_ms),
  CHECK (reopen_time_ms IS NULL OR reopen_time_ms > internal_end_ms),
  CHECK (candle_count >= 0),
  CHECK (weekend_close_price_x18 > 0),
  CHECK (base_volume_x18 >= 0 AND trade_count >= 0),
  CHECK (
    (status = 'complete' AND jsonb_array_length(reasons) = 0 AND
      external_close_price_x18 IS NOT NULL AND weekend_close_price_x18 IS NOT NULL AND
      reopen_price_x18 IS NOT NULL AND
      reopen_time_ms IS NOT NULL AND weekend_move_ppm IS NOT NULL AND
      reopen_gap_ppm IS NOT NULL AND max_up_excursion_ppm IS NOT NULL AND
      max_down_excursion_ppm IS NOT NULL) OR
    (status = 'excluded' AND jsonb_array_length(reasons) > 0)
  ),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

ALTER TABLE perp_weekend_assessment_sessions
  ALTER COLUMN weekend_close_price_x18 DROP NOT NULL;

ALTER TABLE perp_weekend_assessment_sessions
  DROP CONSTRAINT IF EXISTS perp_weekend_assessment_sessions_candle_count_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'perp_weekend_complete_prices_check'
      AND conrelid = 'perp_weekend_assessment_sessions'::regclass
  ) THEN
    ALTER TABLE perp_weekend_assessment_sessions
      ADD CONSTRAINT perp_weekend_complete_prices_check
      CHECK (status <> 'complete' OR weekend_close_price_x18 IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'perp_weekend_candle_count_check'
      AND conrelid = 'perp_weekend_assessment_sessions'::regclass
  ) THEN
    ALTER TABLE perp_weekend_assessment_sessions
      ADD CONSTRAINT perp_weekend_candle_count_check
      CHECK (candle_count >= 0 AND (status <> 'complete' OR candle_count > 0));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS perp_pool_basis_runs (
  id BIGSERIAL PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  checkpoint_run_id BIGINT NOT NULL
    REFERENCES v3_strategy_checkpoint_runs(id),
  risk_run_id BIGINT NOT NULL REFERENCES risk_snapshot_runs(id),
  perp_snapshot_run_id BIGINT NOT NULL
    REFERENCES perp_reference_snapshot_runs(id),
  evaluated_at TIMESTAMPTZ NOT NULL,
  stream_key TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  rwa_symbol TEXT NOT NULL,
  fee INTEGER NOT NULL,
  dex TEXT NOT NULL,
  coin TEXT NOT NULL,
  reference_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  quality_pass BOOLEAN NOT NULL,
  primary_reference_available BOOLEAN NOT NULL,
  fallback_candidate BOOLEAN NOT NULL,
  source_skew_seconds INTEGER NOT NULL,
  checkpoint_age_seconds INTEGER,
  perp_snapshot_age_seconds INTEGER,
  quote_oracle_age_seconds INTEGER,
  multiplier_x18 NUMERIC(78, 0),
  perp_reference_usd_x18 NUMERIC(78, 0) NOT NULL,
  token_reference_usd_x18 NUMERIC(78, 0),
  usdg_usd_x18 NUMERIC(78, 0),
  token_reference_usdg_x18 NUMERIC(78, 0),
  pool_price_x18 NUMERIC(78, 0) NOT NULL,
  chainlink_price_x18 NUMERIC(78, 0),
  pool_perp_deviation_ppm BIGINT,
  chainlink_perp_deviation_ppm BIGINT,
  methodology TEXT NOT NULL,
  execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  reasons JSONB NOT NULL,
  limitations JSONB NOT NULL,
  thresholds JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (checkpoint_run_id, perp_snapshot_run_id, pool_address),
  CHECK (schema_version = 1),
  CHECK (fee > 0 AND fee <= 1000000),
  CHECK (reference_mode IN (
    'chainlink_primary_comparison',
    'perp_external_session_candidate',
    'perp_internal_weekend_candidate'
  )),
  CHECK (status IN ('observed', 'quality_rejected')),
  CHECK (quality_pass = (status = 'observed')),
  CONSTRAINT perp_pool_basis_mode_check CHECK (
    primary_reference_available =
      (reference_mode = 'chainlink_primary_comparison')
  ),
  CONSTRAINT perp_pool_basis_candidate_check CHECK (
    fallback_candidate = (quality_pass AND NOT primary_reference_available)
  ),
  CONSTRAINT perp_pool_basis_reason_consistency_check CHECK (
    (quality_pass AND jsonb_array_length(reasons) = 0) OR
    (NOT quality_pass AND jsonb_array_length(reasons) > 0)
  ),
  CHECK (source_skew_seconds >= 0),
  CHECK (checkpoint_age_seconds IS NULL OR checkpoint_age_seconds >= 0),
  CHECK (perp_snapshot_age_seconds IS NULL OR perp_snapshot_age_seconds >= 0),
  CHECK (quote_oracle_age_seconds IS NULL OR quote_oracle_age_seconds >= 0),
  CHECK (multiplier_x18 IS NULL OR multiplier_x18 >= 0),
  CHECK (perp_reference_usd_x18 >= 0),
  CHECK (token_reference_usd_x18 IS NULL OR token_reference_usd_x18 > 0),
  CHECK (usdg_usd_x18 IS NULL OR usdg_usd_x18 >= 0),
  CHECK (token_reference_usdg_x18 IS NULL OR token_reference_usdg_x18 > 0),
  CHECK (pool_price_x18 > 0),
  CHECK (chainlink_price_x18 IS NULL OR chainlink_price_x18 > 0),
  CHECK (methodology = 'perp_pool_basis_shadow_v1'),
  CHECK (NOT execution_eligible),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (jsonb_typeof(limitations) = 'array'),
  CHECK (jsonb_typeof(thresholds) = 'object'),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS perp_pool_basis_runs_latest_idx
  ON perp_pool_basis_runs (rwa_symbol, fee, evaluated_at DESC, id DESC);

ALTER TABLE perp_pool_basis_runs ADD COLUMN IF NOT EXISTS stream_key TEXT;
UPDATE perp_pool_basis_runs b
SET stream_key = c.stream_key
FROM v3_strategy_checkpoint_runs c
WHERE b.checkpoint_run_id = c.id AND b.stream_key IS NULL;
ALTER TABLE perp_pool_basis_runs ALTER COLUMN stream_key SET NOT NULL;

ALTER TABLE perp_pool_basis_runs
  DROP CONSTRAINT IF EXISTS perp_pool_basis_runs_multiplier_x18_check;
ALTER TABLE perp_pool_basis_runs
  DROP CONSTRAINT IF EXISTS perp_pool_basis_runs_perp_reference_usd_x18_check;
ALTER TABLE perp_pool_basis_runs
  DROP CONSTRAINT IF EXISTS perp_pool_basis_runs_usdg_usd_x18_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'perp_pool_basis_nonnegative_inputs_check'
      AND conrelid = 'perp_pool_basis_runs'::regclass
  ) THEN
    ALTER TABLE perp_pool_basis_runs
      ADD CONSTRAINT perp_pool_basis_nonnegative_inputs_check CHECK (
        (multiplier_x18 IS NULL OR multiplier_x18 >= 0) AND
        perp_reference_usd_x18 >= 0 AND
        (usdg_usd_x18 IS NULL OR usdg_usd_x18 >= 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'perp_pool_basis_mode_check'
      AND conrelid = 'perp_pool_basis_runs'::regclass
  ) THEN
    ALTER TABLE perp_pool_basis_runs
      ADD CONSTRAINT perp_pool_basis_mode_check CHECK (
        primary_reference_available =
          (reference_mode = 'chainlink_primary_comparison')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'perp_pool_basis_candidate_check'
      AND conrelid = 'perp_pool_basis_runs'::regclass
  ) THEN
    ALTER TABLE perp_pool_basis_runs
      ADD CONSTRAINT perp_pool_basis_candidate_check CHECK (
        fallback_candidate = (quality_pass AND NOT primary_reference_available)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'perp_pool_basis_reason_consistency_check'
      AND conrelid = 'perp_pool_basis_runs'::regclass
  ) THEN
    ALTER TABLE perp_pool_basis_runs
      ADD CONSTRAINT perp_pool_basis_reason_consistency_check CHECK (
        (quality_pass AND jsonb_array_length(reasons) = 0) OR
        (NOT quality_pass AND jsonb_array_length(reasons) > 0)
      );
  END IF;
END
$$;
`;
