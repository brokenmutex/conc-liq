// v12 shared-wallet allocation, frozen-review and serialized execution queue.
// Unqualified names intentionally resolve in the isolated migration target.
export const DEPLOYMENT_LIVE_WALLET_SQL=`
CREATE TABLE deployment_live_wallets (
 chain_id integer NOT NULL CHECK(chain_id=4663),
 wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 status text NOT NULL CHECK(status IN ('uninitialized','available','blocked')),
 source_block numeric(78,0),source_hash text,source_timestamp bigint,
 nonce numeric(78,0),pending_nonce numeric(78,0),native_balance_wei numeric(78,0),
 snapshot_hash text,commitments_hash text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(chain_id,wallet),
 CHECK((source_block IS NULL)=(source_hash IS NULL) AND (source_hash IS NULL)=(source_timestamp IS NULL)),
 CHECK(source_hash IS NULL OR source_hash ~ '^0x[0-9a-fA-F]{64}$'),
 CHECK(snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
 CHECK(commitments_hash IS NULL OR commitments_hash ~ '^[0-9a-f]{64}$'),
 CHECK(nonce IS NULL OR nonce>=0),CHECK(pending_nonce IS NULL OR pending_nonce>=0),
 CHECK(native_balance_wei IS NULL OR native_balance_wei>=0)
);

CREATE TABLE deployment_live_wallet_tokens (
 chain_id integer NOT NULL,wallet text NOT NULL,token_address text NOT NULL
  CHECK(token_address ~ '^0x[0-9a-f]{40}$'),
 generation bigint NOT NULL CHECK(generation>0),balance_raw numeric(78,0) NOT NULL CHECK(balance_raw>=0),
 PRIMARY KEY(chain_id,wallet,token_address),
 FOREIGN KEY(chain_id,wallet) REFERENCES deployment_live_wallets(chain_id,wallet) ON DELETE RESTRICT
);

CREATE TABLE deployment_live_allocations (
 id uuid PRIMARY KEY,
 chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL,
 campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('reserved','active','release_pending','released','blocked')),
 native_spend_wei numeric(78,0) NOT NULL CHECK(native_spend_wei>=0),
 pending_native_spend_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK(pending_native_spend_wei>=0),
 exit_reserve_wei numeric(78,0) NOT NULL CHECK(exit_reserve_wei>=0),
 source_generation bigint NOT NULL CHECK(source_generation>0),source_hash text NOT NULL CHECK(source_hash ~ '^0x[0-9a-fA-F]{64}$'),
 allocation_hash text NOT NULL CHECK(allocation_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 released_at timestamptz,
 UNIQUE(chain_id,wallet,campaign_id,revision),
 UNIQUE(id,chain_id,wallet),
 FOREIGN KEY(chain_id,wallet) REFERENCES deployment_live_wallets(chain_id,wallet) ON DELETE RESTRICT,
 CHECK((state='released')=(released_at IS NOT NULL))
);
CREATE UNIQUE INDEX deployment_live_one_current_campaign_allocation
 ON deployment_live_allocations(chain_id,wallet,campaign_id) WHERE state IN ('reserved','active','release_pending','blocked');
CREATE INDEX deployment_live_allocations_wallet_state_idx
 ON deployment_live_allocations(chain_id,wallet,state,campaign_id);

CREATE TABLE deployment_live_allocation_tokens (
 allocation_id uuid NOT NULL,chain_id integer NOT NULL,wallet text NOT NULL,
 token_address text NOT NULL CHECK(token_address ~ '^0x[0-9a-f]{40}$'),
 allocated_raw numeric(78,0) NOT NULL CHECK(allocated_raw>=0),
 pending_spend_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK(pending_spend_raw>=0),
 PRIMARY KEY(allocation_id,token_address),
 FOREIGN KEY(allocation_id,chain_id,wallet) REFERENCES deployment_live_allocations(id,chain_id,wallet) ON DELETE RESTRICT
);

-- NFT principal is ownership/custody evidence, never wallet spendable token inventory.
CREATE TABLE deployment_live_nft_custody (
 chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL,
 position_manager text NOT NULL CHECK(position_manager ~ '^0x[0-9a-f]{40}$'),
 token_id numeric(78,0) NOT NULL CHECK(token_id>0),
 allocation_id uuid,campaign_id uuid REFERENCES deployment_campaigns(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK(status IN ('active','retired_empty','unmanaged')),
 liquidity numeric(78,0) NOT NULL CHECK(liquidity>=0),
 tokens_owed0 numeric(78,0) NOT NULL CHECK(tokens_owed0>=0),
 tokens_owed1 numeric(78,0) NOT NULL CHECK(tokens_owed1>=0),
 source_block numeric(78,0) NOT NULL CHECK(source_block>=0),
 source_hash text NOT NULL CHECK(source_hash ~ '^0x[0-9a-fA-F]{64}$'),
 source_timestamp bigint NOT NULL CHECK(source_timestamp>0),
 PRIMARY KEY(chain_id,wallet,position_manager,token_id),
 FOREIGN KEY(chain_id,wallet) REFERENCES deployment_live_wallets(chain_id,wallet) ON DELETE RESTRICT,
 FOREIGN KEY(allocation_id,chain_id,wallet) REFERENCES deployment_live_allocations(id,chain_id,wallet) ON DELETE RESTRICT,
 CHECK(status<>'retired_empty' OR (liquidity=0 AND tokens_owed0=0 AND tokens_owed1=0))
);
CREATE INDEX deployment_live_nft_campaign_idx ON deployment_live_nft_custody(chain_id,wallet,campaign_id,status);

CREATE TABLE deployment_live_reviews (
 id uuid PRIMARY KEY,chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL,
 payload jsonb NOT NULL,payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 build_id text NOT NULL CHECK(build_id ~ '^[0-9a-f]{64}$'),
 source_block numeric(78,0) NOT NULL CHECK(source_block>=0),source_hash text NOT NULL CHECK(source_hash ~ '^0x[0-9a-fA-F]{64}$'),
 source_timestamp bigint NOT NULL CHECK(source_timestamp>0),
 wallet_generation bigint NOT NULL CHECK(wallet_generation>0),
 commitments_hash text NOT NULL CHECK(commitments_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,consumed_by_job uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(chain_id,wallet) REFERENCES deployment_live_wallets(chain_id,wallet) ON DELETE RESTRICT,
 CHECK(expires_at>created_at)
);
CREATE INDEX deployment_live_reviews_wallet_recent_idx ON deployment_live_reviews(chain_id,wallet,created_at DESC);

CREATE TABLE deployment_live_jobs (
 id uuid PRIMARY KEY,chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL,
 campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),allocation_id uuid NOT NULL,
 review_id uuid NOT NULL REFERENCES deployment_live_reviews(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('open','pause','resume','change_range','close_retain','close_convert')),
 status text NOT NULL CHECK(status IN ('queued','preflighting','executing','confirming','reconciling','succeeded','rejected','blocked','cancelled')),
 priority smallint NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 100),
 fairness_sequence bigserial NOT NULL,
 payload jsonb NOT NULL,payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 build_id text NOT NULL CHECK(build_id ~ '^[0-9a-f]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 lease_token uuid,lease_until timestamptz,attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 resume_stage text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 UNIQUE(chain_id,wallet,idempotency_key),
 UNIQUE(id,chain_id,wallet),
 FOREIGN KEY(chain_id,wallet) REFERENCES deployment_live_wallets(chain_id,wallet) ON DELETE RESTRICT,
 FOREIGN KEY(allocation_id,chain_id,wallet) REFERENCES deployment_live_allocations(id,chain_id,wallet) ON DELETE RESTRICT,
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((status IN ('succeeded','rejected','blocked','cancelled'))=(completed_at IS NOT NULL))
);
ALTER TABLE deployment_live_reviews ADD CONSTRAINT deployment_live_reviews_consumed_job_fk
 FOREIGN KEY(consumed_by_job) REFERENCES deployment_live_jobs(id) ON DELETE RESTRICT;
CREATE INDEX deployment_live_jobs_queue_idx ON deployment_live_jobs(chain_id,wallet,status,priority DESC,fairness_sequence);
CREATE UNIQUE INDEX deployment_live_one_active_job_per_wallet ON deployment_live_jobs(chain_id,wallet)
 WHERE status IN ('preflighting','executing','confirming','reconciling','blocked');

CREATE TABLE deployment_live_stage_outbox (
 job_id uuid NOT NULL,stage text NOT NULL CHECK(length(stage) BETWEEN 1 AND 64),
 chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL,
 intent_json jsonb NOT NULL,plan_json jsonb NOT NULL,before_json jsonb NOT NULL,
 nonce numeric(78,0) NOT NULL CHECK(nonce>=0),
 signed_raw text,signed_raw_hash text,
 status text NOT NULL CHECK(status IN ('prepared','signed','confirmed','reverted','cancelled','blocked')),
 canonical_receipt_json jsonb,effect_evidence_json jsonb,allowance_cleanup_json jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,stage),
 FOREIGN KEY(job_id,chain_id,wallet) REFERENCES deployment_live_jobs(id,chain_id,wallet) ON DELETE RESTRICT,
 CHECK((signed_raw IS NULL)=(signed_raw_hash IS NULL)),
 CHECK(signed_raw_hash IS NULL OR signed_raw_hash ~ '^0x[0-9a-fA-F]{64}$'),
 CHECK(status NOT IN ('signed','confirmed','reverted') OR signed_raw IS NOT NULL),
 CHECK(status NOT IN ('confirmed','reverted') OR canonical_receipt_json IS NOT NULL)
);
CREATE UNIQUE INDEX deployment_live_wallet_nonce_unique ON deployment_live_stage_outbox(chain_id,wallet,nonce) WHERE status<>'cancelled';
CREATE UNIQUE INDEX deployment_live_one_unresolved_signed_per_wallet ON deployment_live_stage_outbox(chain_id,wallet)
 WHERE status IN ('prepared','signed') OR (status='blocked' AND signed_raw IS NOT NULL);
`;
