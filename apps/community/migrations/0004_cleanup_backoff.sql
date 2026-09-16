ALTER TABLE attachments ADD COLUMN cleanup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN cleanup_next_attempt_at timestamptz NOT NULL DEFAULT now();
DROP INDEX attachments_orphan_idx;
CREATE INDEX attachments_orphan_idx ON attachments(cleanup_next_attempt_at,uploaded_at,id) WHERE entry_id IS NULL;

ALTER TABLE pending_blob_deletions ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX pending_blob_deletions_due_idx ON pending_blob_deletions(next_attempt_at,created_at,blob_key);

ALTER TABLE export_archives ADD COLUMN cleanup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE export_archives ADD COLUMN cleanup_next_attempt_at timestamptz NOT NULL DEFAULT now();
DROP INDEX export_archives_expiry_idx;
CREATE INDEX export_archives_expiry_idx ON export_archives(cleanup_next_attempt_at,expires_at,id) WHERE deleted_at IS NULL;
