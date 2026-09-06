export const PAPER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS paper_sessions (
  id BIGSERIAL PRIMARY KEY, stream_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), heartbeat_at TIMESTAMPTZ,
  policy_hash TEXT NOT NULL, policy JSONB NOT NULL, state JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','entry_pending','open','exit_pending','closed','invalid')),
  monitor_reasons JSONB NOT NULL DEFAULT '[]', execution_eligible BOOLEAN NOT NULL DEFAULT FALSE CHECK (NOT execution_eligible)
);
CREATE UNIQUE INDEX IF NOT EXISTS paper_sessions_one_active_idx ON paper_sessions (stream_key)
  WHERE status NOT IN ('closed','invalid');
CREATE TABLE IF NOT EXISTS paper_observations (
  id BIGSERIAL PRIMARY KEY, session_id BIGINT NOT NULL REFERENCES paper_sessions(id),
  checkpoint_id BIGINT NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL, state JSONB NOT NULL, entry_reasons JSONB NOT NULL,
  UNIQUE(session_id, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS paper_observations_latest_idx ON paper_observations (session_id, id DESC);
`;
