/** Canonical block time for event-bearing blocks plus contiguous scan bounds. */
export const INDEXER_EVENT_TIMESTAMPS_SQL = `
CREATE TABLE IF NOT EXISTS indexer_event_blocks (
  stream_key TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream_key, block_number)
);

CREATE INDEX IF NOT EXISTS indexer_event_blocks_time_idx
  ON indexer_event_blocks (stream_key, block_timestamp, block_number);

CREATE TABLE IF NOT EXISTS indexer_event_timestamp_coverage (
  stream_key TEXT PRIMARY KEY,
  from_block NUMERIC(78, 0) NOT NULL,
  from_hash TEXT NOT NULL,
  from_timestamp TIMESTAMPTZ NOT NULL,
  through_block NUMERIC(78, 0) NOT NULL,
  through_hash TEXT NOT NULL,
  through_timestamp TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (through_block >= from_block),
  CHECK (through_timestamp >= from_timestamp)
);
`;
