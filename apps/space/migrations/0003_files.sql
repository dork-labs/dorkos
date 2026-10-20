ALTER TABLE attachments ADD COLUMN idempotency_key text;
ALTER TABLE attachments ADD COLUMN request_hash text;
CREATE UNIQUE INDEX attachments_human_retry_idx ON attachments(uploader_member_id,channel_id,idempotency_key) WHERE uploader_member_id IS NOT NULL;
CREATE UNIQUE INDEX attachments_agent_retry_idx ON attachments(uploader_agent_id,channel_id,idempotency_key) WHERE uploader_agent_id IS NOT NULL;
CREATE INDEX attachments_orphan_idx ON attachments(uploaded_at,id) WHERE entry_id IS NULL;

CREATE TABLE pending_blob_deletions (
  blob_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error_at timestamptz
);

CREATE TABLE export_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_member_id uuid NOT NULL REFERENCES members(id),
  scope text NOT NULL CHECK(scope IN ('personal','owner')),
  channel_ids uuid[] NOT NULL DEFAULT '{}',
  blob_key text NOT NULL UNIQUE,
  byte_size bigint NOT NULL CHECK(byte_size > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX export_archives_expiry_idx ON export_archives(expires_at,id) WHERE deleted_at IS NULL;
