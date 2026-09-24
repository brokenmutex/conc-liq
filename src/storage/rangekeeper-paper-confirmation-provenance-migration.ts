// Append-only receipt for the server-owned confirmation producer path. The
// receipt binds one exact open preview and envelope; simulation remains
// provisional and action/booking flags remain false.
export const RANGEKEEPER_PAPER_CONFIRMATION_PROVENANCE_SQL = `
CREATE TABLE deployment_rangekeeper_paper_confirmation_producers (
  campaign_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  open_preview_id uuid NOT NULL REFERENCES deployment_previews(id),
  envelope_hash text NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  producer_run_id uuid NOT NULL UNIQUE,
  producer_build_id text NOT NULL CHECK (producer_build_id ~ '^[0-9a-f]{64}$'),
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (
    receipt->>'kind'='rangekeeper_paper_server_producer_receipt_v1' AND
    receipt->>'campaignId'=campaign_id::text AND
    receipt->>'revision'=revision::text AND
    receipt->>'openPreviewId'=open_preview_id::text AND
    receipt->>'envelopeHash'=envelope_hash AND
    receipt->>'producerRunId'=producer_run_id::text AND
    receipt->>'producerBuildId'=producer_build_id AND
    receipt->>'receiptHash'=receipt_hash),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(campaign_id,revision),
  FOREIGN KEY(campaign_id,revision)
    REFERENCES deployment_rangekeeper_paper_confirmations(campaign_id,revision),
  UNIQUE(open_preview_id)
);
CREATE INDEX deployment_rangekeeper_paper_confirmation_producers_created_idx
  ON deployment_rangekeeper_paper_confirmation_producers(created_at DESC,campaign_id);
CREATE TRIGGER deployment_rangekeeper_paper_confirmation_producers_append_only
  BEFORE UPDATE OR DELETE ON deployment_rangekeeper_paper_confirmation_producers
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
`;
