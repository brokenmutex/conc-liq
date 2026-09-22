// A separate, append-only journal for modeled paper balances and flows. It
// never overwrites the source marks or turns estimated gas into paid gas.
export const DEPLOYMENT_PAPER_ACCOUNTING_SQL = `
CREATE TABLE deployment_paper_accounting (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  source_mark_id bigint NOT NULL REFERENCES deployment_marks(id),
  policy_version text NOT NULL,
  fee_evidence_id bigint REFERENCES deployment_paper_fee_evidence(id),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id,source_mark_id,policy_version)
);
CREATE INDEX deployment_paper_accounting_campaign_idx
  ON deployment_paper_accounting(campaign_id,source_mark_id);
CREATE TRIGGER deployment_paper_accounting_append_only
  BEFORE UPDATE OR DELETE ON deployment_paper_accounting
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
`;
