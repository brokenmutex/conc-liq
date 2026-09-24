// Durable, append-only record of the independently observed RangeKeeper
// confirmation envelope. It remains provisional and action-unavailable.
export const RANGEKEEPER_PAPER_CONFIRMATION_SQL = `
CREATE TABLE deployment_rangekeeper_paper_confirmations (
  campaign_id uuid NOT NULL REFERENCES deployment_campaigns(id),
  revision integer NOT NULL CHECK (revision>0),
  open_preview_id uuid NOT NULL REFERENCES deployment_previews(id),
  first_source_block numeric(78,0) NOT NULL,
  first_source_hash text NOT NULL CHECK (first_source_hash ~ '^0x[0-9a-fA-F]{64}$'),
  confirmation_source_block numeric(78,0) NOT NULL,
  confirmation_source_hash text NOT NULL CHECK (confirmation_source_hash ~ '^0x[0-9a-fA-F]{64}$'),
  envelope_hash text NOT NULL CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  envelope jsonb NOT NULL CHECK (
    envelope->>'kind'='rangekeeper_paper_open_confirmation_v1' AND
    envelope->>'status'='confirmed' AND envelope->>'actionAvailable'='false' AND
    envelope->>'openingBooked'='false'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(campaign_id,revision),
  CHECK (confirmation_source_block>first_source_block),
  UNIQUE(open_preview_id)
);
CREATE INDEX deployment_rangekeeper_paper_confirmations_created_idx
  ON deployment_rangekeeper_paper_confirmations(created_at DESC,campaign_id);
CREATE TRIGGER deployment_rangekeeper_paper_confirmations_append_only
  BEFORE UPDATE OR DELETE ON deployment_rangekeeper_paper_confirmations
  FOR EACH ROW EXECUTE FUNCTION deployment_reject_evidence_mutation();
`;
