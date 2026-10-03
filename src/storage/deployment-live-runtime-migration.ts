// v13 campaign-addressed RangeKeeper runtime and stage authorization evidence.
// All names remain unqualified for isolated migration schemas.
export const DEPLOYMENT_LIVE_RUNTIME_SQL=`
CREATE TABLE deployment_live_campaign_runtime (
 campaign_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 profile_id uuid NOT NULL REFERENCES deployment_market_profiles(id) ON DELETE RESTRICT,
 profile_hash text NOT NULL CHECK(profile_hash ~ '^[0-9a-f]{64}$'),
 config_hash text NOT NULL CHECK(config_hash ~ '^[0-9a-f]{64}$'),
 allocation_id uuid NOT NULL,
 state_json jsonb NOT NULL,state_hash text NOT NULL CHECK(state_hash ~ '^[0-9a-f]{64}$'),
 state_revision bigint NOT NULL DEFAULT 0 CHECK(state_revision>=0),
 source_block numeric(78,0) NOT NULL CHECK(source_block>=0),source_hash text NOT NULL CHECK(source_hash ~ '^0x[0-9a-fA-F]{64}$'),source_timestamp bigint NOT NULL CHECK(source_timestamp>0),
 status text NOT NULL CHECK(status IN ('starting','active','blocked','closed')),
 initial_token0_raw numeric(78,0) NOT NULL CHECK(initial_token0_raw>=0),initial_token1_raw numeric(78,0) NOT NULL CHECK(initial_token1_raw>=0),
 initial_native_wei numeric(78,0) NOT NULL CHECK(initial_native_wei>=0),
 spent_cost_value numeric(78,0) NOT NULL DEFAULT 0 CHECK(spent_cost_value>=0),spent_gas_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK(spent_gas_wei>=0),
 initial_baseline jsonb NOT NULL,opened_at timestamptz,closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(campaign_id,revision),UNIQUE(campaign_id,revision,allocation_id),
 FOREIGN KEY(campaign_id,revision) REFERENCES deployment_revisions(campaign_id,revision) ON DELETE RESTRICT,
 FOREIGN KEY(allocation_id) REFERENCES deployment_live_allocations(id) ON DELETE RESTRICT,
 CHECK((status='closed')=(closed_at IS NOT NULL))
);
CREATE INDEX deployment_live_campaign_runtime_wallet_idx ON deployment_live_campaign_runtime(chain_id,wallet,status);

CREATE TABLE deployment_live_nft_custody_snapshots (
 id uuid PRIMARY KEY,chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 position_manager text NOT NULL CHECK(position_manager ~ '^0x[0-9a-f]{40}$'),source_block numeric(78,0) NOT NULL CHECK(source_block>=0),
 source_hash text NOT NULL CHECK(source_hash ~ '^0x[0-9a-fA-F]{64}$'),source_timestamp bigint NOT NULL CHECK(source_timestamp>0),
 enumeration_evidence jsonb NOT NULL,evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 owned_token_ids jsonb NOT NULL,positions jsonb NOT NULL,retired_empty_token_ids jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(chain_id,wallet,position_manager,source_block,source_hash),
 FOREIGN KEY(chain_id,wallet) REFERENCES deployment_live_wallets(chain_id,wallet) ON DELETE RESTRICT
);
CREATE INDEX deployment_live_nft_custody_snapshots_latest_idx ON deployment_live_nft_custody_snapshots(chain_id,wallet,position_manager,source_block DESC);

CREATE TABLE deployment_live_runtime_events (
 id uuid PRIMARY KEY,campaign_id uuid NOT NULL,revision integer NOT NULL,effect_id text NOT NULL CHECK(length(effect_id) BETWEEN 1 AND 128),
 sequence bigint NOT NULL CHECK(sequence>0),kind text NOT NULL CHECK(kind IN ('initialized','opened','stage_receipt','mark','closed','blocked')),
 source_block numeric(78,0) NOT NULL CHECK(source_block>=0),source_hash text NOT NULL CHECK(source_hash ~ '^0x[0-9a-fA-F]{64}$'),source_timestamp bigint NOT NULL CHECK(source_timestamp>0),
 before_state_hash text NOT NULL CHECK(before_state_hash ~ '^[0-9a-f]{64}$'),after_state_hash text NOT NULL CHECK(after_state_hash ~ '^[0-9a-f]{64}$'),
 receipt_hash text CHECK(receipt_hash IS NULL OR receipt_hash ~ '^0x[0-9a-fA-F]{64}$'),payload jsonb NOT NULL,payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(campaign_id,revision,effect_id),UNIQUE(campaign_id,revision,sequence),
 FOREIGN KEY(campaign_id,revision) REFERENCES deployment_live_campaign_runtime(campaign_id,revision) ON DELETE RESTRICT
);
CREATE INDEX deployment_live_runtime_events_campaign_idx ON deployment_live_runtime_events(campaign_id,revision,sequence);

CREATE TABLE deployment_live_stage_authorizations (
 job_id uuid NOT NULL,stage text NOT NULL,chain_id integer NOT NULL CHECK(chain_id=4663),wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 campaign_id uuid NOT NULL,revision integer NOT NULL,allocation_id uuid NOT NULL,profile_id uuid NOT NULL REFERENCES deployment_market_profiles(id) ON DELETE RESTRICT,
 profile_hash text NOT NULL CHECK(profile_hash ~ '^[0-9a-f]{64}$'),config_hash text NOT NULL CHECK(config_hash ~ '^[0-9a-f]{64}$'),allocation_hash text NOT NULL CHECK(allocation_hash ~ '^[0-9a-f]{64}$'),
 source_block numeric(78,0) NOT NULL CHECK(source_block>=0),source_hash text NOT NULL CHECK(source_hash ~ '^0x[0-9a-fA-F]{64}$'),source_timestamp bigint NOT NULL CHECK(source_timestamp>0),
 reference_proof_hash text NOT NULL CHECK(reference_proof_hash ~ '^[0-9a-f]{64}$'),plan_hash text NOT NULL CHECK(plan_hash ~ '^[0-9a-f]{64}$'),calldata_hash text NOT NULL CHECK(calldata_hash ~ '^0x[0-9a-fA-F]{64}$'),
 gas_used numeric(78,0) NOT NULL CHECK(gas_used>0),gas_bound numeric(78,0) NOT NULL CHECK(gas_bound>=gas_used),max_fee_per_gas_wei numeric(78,0) NOT NULL CHECK(max_fee_per_gas_wei>0),
 cost_value numeric(78,0) NOT NULL CHECK(cost_value>=0),fork_evidence_hash text NOT NULL CHECK(fork_evidence_hash ~ '^[0-9a-f]{64}$'),
 capability_hash text NOT NULL CHECK(capability_hash ~ '^[0-9a-f]{64}$'),authorization_json jsonb NOT NULL,authorization_hash text NOT NULL CHECK(authorization_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,stage),
 FOREIGN KEY(job_id,stage) REFERENCES deployment_live_stage_outbox(job_id,stage) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,revision,allocation_id) REFERENCES deployment_live_campaign_runtime(campaign_id,revision,allocation_id) ON DELETE RESTRICT
);
CREATE INDEX deployment_live_stage_authorizations_campaign_idx ON deployment_live_stage_authorizations(campaign_id,revision,created_at);
`;
