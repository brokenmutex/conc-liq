/** Additive owner-history index. Rows are evidence only; readers must prove
 * complete start-to-source coverage and reconcile the resulting set. */
export const POSITION_MANAGER_TRANSFER_SQL = `
CREATE TABLE position_manager_transfer_cursors (
  chain_id BIGINT NOT NULL,
  position_manager TEXT NOT NULL CHECK (position_manager ~ '^0x[0-9a-f]{40}$'),
  start_block NUMERIC(78,0) NOT NULL CHECK (start_block >= 0),
  next_block NUMERIC(78,0) NOT NULL CHECK (next_block >= start_block),
  covered_through_block NUMERIC(78,0),
  covered_through_hash TEXT CHECK (covered_through_hash IS NULL OR covered_through_hash ~ '^0x[0-9a-fA-F]{64}$'),
  last_scanned_block NUMERIC(78,0),
  last_scanned_hash TEXT CHECK (last_scanned_hash IS NULL OR last_scanned_hash ~ '^0x[0-9a-fA-F]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, position_manager, start_block),
  CHECK ((covered_through_block IS NULL) = (covered_through_hash IS NULL)),
  CHECK ((last_scanned_block IS NULL) = (last_scanned_hash IS NULL)),
  CHECK (covered_through_block IS NULL OR covered_through_block < next_block)
);

CREATE TABLE position_manager_transfer_checkpoints (
  chain_id BIGINT NOT NULL,
  position_manager TEXT NOT NULL,
  start_block NUMERIC(78,0) NOT NULL,
  block_number NUMERIC(78,0) NOT NULL,
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  parent_hash TEXT NOT NULL CHECK (parent_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, position_manager, start_block, block_number),
  FOREIGN KEY (chain_id, position_manager, start_block)
    REFERENCES position_manager_transfer_cursors(chain_id, position_manager, start_block)
    ON DELETE CASCADE
);

CREATE TABLE position_manager_transfers (
  chain_id BIGINT NOT NULL,
  position_manager TEXT NOT NULL,
  start_block NUMERIC(78,0) NOT NULL,
  block_number NUMERIC(78,0) NOT NULL,
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  from_address TEXT NOT NULL CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address TEXT NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  token_id NUMERIC(78,0) NOT NULL CHECK (token_id > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, position_manager, start_block, transaction_hash, log_index),
  FOREIGN KEY (chain_id, position_manager, start_block)
    REFERENCES position_manager_transfer_cursors(chain_id, position_manager, start_block)
    ON DELETE CASCADE
);

CREATE INDEX position_manager_transfers_replay_idx
  ON position_manager_transfers(chain_id, position_manager, start_block,
    block_number, transaction_index, log_index);
CREATE INDEX position_manager_transfers_token_idx
  ON position_manager_transfers(chain_id, position_manager, start_block, token_id, block_number DESC);
`;
