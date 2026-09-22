// Append-only revocations for modeled paper history whose saved chain anchor
// is no longer canonical. The accounting snapshots remain immutable evidence;
// consumers fail closed from the first revoked snapshot onward.
export const DEPLOYMENT_PAPER_ACCOUNTING_INVALIDATION_SQL = `
CREATE TABLE deployment_paper_accounting_invalidations (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  accounting_id bigint NOT NULL UNIQUE REFERENCES deployment_paper_accounting(id),
  detected_accounting_id bigint NOT NULL REFERENCES deployment_paper_accounting(id),
  reason text NOT NULL CHECK (reason IN ('canonical_anchor_changed')),
  evidence jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deployment_paper_accounting_invalidations_campaign_idx
  ON deployment_paper_accounting_invalidations(campaign_id,accounting_id);
CREATE TRIGGER deployment_paper_accounting_invalidations_append_only
  BEFORE UPDATE OR DELETE ON deployment_paper_accounting_invalidations
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
`;
