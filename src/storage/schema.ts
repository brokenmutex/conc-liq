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
`;
