// Append-only v5 evidence. Hypothetical fee bounds are kept apart from earned
// deployment_ledger fees and from valuation marks.
export const DEPLOYMENT_PAPER_FEE_SQL = `
CREATE TABLE deployment_paper_fee_evidence (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  from_mark_id bigint NOT NULL REFERENCES deployment_marks(id),
  to_mark_id bigint NOT NULL REFERENCES deployment_marks(id),
  proof jsonb NOT NULL,
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  carry jsonb NOT NULL,
  carry_hash text NOT NULL CHECK (carry_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (to_mark_id>from_mark_id),
  UNIQUE (campaign_id,from_mark_id),
  UNIQUE (campaign_id,to_mark_id)
);
CREATE INDEX deployment_paper_fee_campaign_idx
  ON deployment_paper_fee_evidence(campaign_id,id);
CREATE TRIGGER deployment_paper_fee_append_only
  BEFORE UPDATE OR DELETE ON deployment_paper_fee_evidence
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
`;
