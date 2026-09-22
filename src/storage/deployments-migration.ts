// Append-only v4 schema for the two-strategy deployment product. This text is
// checksummed with the other explicit migrations; request/worker startup is
// read-only and must never execute it.
export const DEPLOYMENTS_SQL = `
CREATE TABLE deployment_market_profiles (
  id uuid PRIMARY KEY,
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_address text NOT NULL,
  token0_address text NOT NULL,
  token1_address text NOT NULL,
  token0_decimals integer NOT NULL CHECK (token0_decimals BETWEEN 0 AND 36),
  token1_decimals integer NOT NULL CHECK (token1_decimals BETWEEN 0 AND 36),
  quote_token smallint NOT NULL CHECK (quote_token IN (0,1)),
  fee integer NOT NULL CHECK (fee>0 AND fee<1000000),
  tick_spacing integer NOT NULL CHECK (tick_spacing>0),
  profile jsonb NOT NULL,
  evidence jsonb NOT NULL,
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL,
  retired_at timestamptz,
  UNIQUE (chain_id,pool_address,profile_hash)
);

CREATE TABLE deployment_campaigns (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('paper','live')),
  chain_id integer NOT NULL CHECK (chain_id=4663),
  wallet text NOT NULL,
  market_profile_id uuid NOT NULL REFERENCES deployment_market_profiles(id),
  allocation jsonb NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN
    ('draft','opening','active','paused','changing','closing','closed','blocked')),
  range_state text NOT NULL DEFAULT 'unknown' CHECK (range_state IN
    ('inside','outside','no_liquidity','unknown')),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision>=0),
  runtime_identity jsonb,
  predecessor_schema text,
  predecessor_campaign_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  CHECK ((lifecycle='closed')=(closed_at IS NOT NULL)),
  CHECK ((predecessor_schema IS NULL)=(predecessor_campaign_id IS NULL)),
  UNIQUE (predecessor_schema,predecessor_campaign_id)
);
CREATE INDEX deployment_campaigns_wallet_idx ON deployment_campaigns(chain_id,wallet,created_at DESC);

CREATE TABLE deployment_revisions (
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  revision integer NOT NULL CHECK (revision>=1),
  parent_revision integer,
  strategy_id text NOT NULL CHECK (strategy_id IN ('static_manual_v1','rangekeeper_v1')),
  strategy_version text NOT NULL,
  state_schema_version integer NOT NULL CHECK (state_schema_version>0),
  config jsonb NOT NULL,
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  activated_by_operation uuid,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (campaign_id,revision),
  FOREIGN KEY (campaign_id,parent_revision) REFERENCES deployment_revisions(campaign_id,revision),
  CHECK ((revision=1 AND parent_revision IS NULL) OR
         (revision>1 AND parent_revision=revision-1))
);

CREATE TABLE deployment_previews (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  expected_revision integer NOT NULL CHECK (expected_revision>=0),
  kind text NOT NULL CHECK (kind IN ('open','pause','resume','change_range','change_strategy','close_retain','close_convert')),
  request jsonb NOT NULL,
  proposal jsonb NOT NULL,
  evidence jsonb NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at>created_at)
);
CREATE INDEX deployment_previews_campaign_idx ON deployment_previews(campaign_id,created_at DESC);

CREATE TABLE deployment_operations (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  preview_id uuid NOT NULL UNIQUE REFERENCES deployment_previews(id),
  actor text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('open','pause','resume','change_range','change_strategy','close_retain','close_convert')),
  status text NOT NULL CHECK (status IN
    ('queued','preflighting','executing','confirming','reconciling','succeeded','rejected','blocked','cancelled')),
  stage text NOT NULL,
  reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  claimed_by text,
  claim_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id,idempotency_key),
  CHECK ((claimed_by IS NULL)=(claim_until IS NULL))
);
CREATE INDEX deployment_operations_claim_idx ON deployment_operations(status,claim_until,created_at);
ALTER TABLE deployment_revisions ADD CONSTRAINT deployment_revisions_operation_fk
  FOREIGN KEY (activated_by_operation) REFERENCES deployment_operations(id);

CREATE TABLE deployment_wallet_reservations (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  wallet text NOT NULL,
  campaign_id uuid NOT NULL UNIQUE REFERENCES deployment_campaigns(id),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  release_evidence jsonb,
  PRIMARY KEY (chain_id,wallet,campaign_id),
  CHECK ((released_at IS NULL)=(release_evidence IS NULL))
);
CREATE UNIQUE INDEX deployment_one_active_wallet ON deployment_wallet_reservations(chain_id,wallet)
  WHERE released_at IS NULL;

CREATE TABLE deployment_operation_intents (
  operation_id uuid NOT NULL REFERENCES deployment_operations(id),
  stage text NOT NULL,
  journal_schema text NOT NULL,
  journal_action_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id,stage),
  UNIQUE (journal_schema,journal_action_id)
);

CREATE TABLE deployment_ledger (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  operation_id uuid REFERENCES deployment_operations(id),
  entry_key text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN
    ('capital_in','capital_out','token_delta','fee','gas_paid','swap_cost','reference_value','attribution_boundary')),
  token_address text,
  amount_raw numeric(78,0),
  value_raw numeric(78,0),
  source jsonb NOT NULL,
  UNIQUE (campaign_id,entry_key)
);
CREATE INDEX deployment_ledger_campaign_idx ON deployment_ledger(campaign_id,id);

CREATE TABLE deployment_calibration_profiles (
  id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version>0),
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_address text NOT NULL,
  path_version text NOT NULL,
  stage text NOT NULL,
  allowance_state text NOT NULL,
  size_band text NOT NULL,
  component text NOT NULL,
  status text NOT NULL CHECK (status IN ('validated','provisional','stale','rejected','unavailable')),
  evidence_class text NOT NULL,
  model jsonb NOT NULL,
  validation jsonb NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  observed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (chain_id,pool_address,path_version,stage,allowance_state,size_band,component,version)
);

CREATE TABLE deployment_marks (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  revision integer NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_block numeric(78,0),
  source_hash text,
  inventory jsonb NOT NULL,
  economics jsonb,
  calibration_profile_ids uuid[] NOT NULL DEFAULT '{}',
  provenance jsonb NOT NULL,
  FOREIGN KEY (campaign_id,revision) REFERENCES deployment_revisions(campaign_id,revision)
);
CREATE INDEX deployment_marks_campaign_idx ON deployment_marks(campaign_id,at DESC,id DESC);

CREATE FUNCTION deployment_reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deployment evidence is append-only';
END;
$$;
CREATE TRIGGER deployment_revisions_append_only BEFORE UPDATE OR DELETE ON deployment_revisions
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
CREATE TRIGGER deployment_previews_append_only BEFORE UPDATE OR DELETE ON deployment_previews
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
CREATE TRIGGER deployment_ledger_append_only BEFORE UPDATE OR DELETE ON deployment_ledger
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
CREATE TRIGGER deployment_marks_append_only BEFORE UPDATE OR DELETE ON deployment_marks
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
CREATE TRIGGER deployment_calibration_append_only BEFORE UPDATE OR DELETE ON deployment_calibration_profiles
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
`;
