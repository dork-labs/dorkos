-- Exports become background jobs that write one segmented ZIP64 archive
-- (specs/community-export-any-size). A row is now the job and, once ready, the archive.
-- Existing rows are finished version 1 archives: format 1, state 'ready', one blob in blob_key.
-- Old code (the backout) keeps working on those rows; it reads nothing it did not write, and
-- `exports:purge-v2` removes every version 2 row before a revert.
ALTER TABLE export_archives
  ADD COLUMN format_version integer NOT NULL DEFAULT 1,
  ADD COLUMN state text NOT NULL DEFAULT 'ready',
  -- max(seq) per exported channel at the start; later messages are not exported.
  ADD COLUMN watermark jsonb,
  ADD COLUMN start_redaction_id bigint,
  ADD COLUMN last_checked_redaction_id bigint,
  ADD COLUMN verified_content_version bigint,
  ADD COLUMN rebuild_passes integer NOT NULL DEFAULT 0,
  -- Messages plus files written, of the total counted at the start.
  ADD COLUMN progress_done bigint NOT NULL DEFAULT 0,
  ADD COLUMN progress_total bigint,
  -- Every data segment is written; what is left is the check, the collections and the tail.
  ADD COLUMN data_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN failure_code text;

ALTER TABLE export_archives
  ALTER COLUMN blob_key DROP NOT NULL,
  ALTER COLUMN byte_size DROP NOT NULL,
  ALTER COLUMN expires_at DROP NOT NULL,
  ADD CONSTRAINT export_archives_format_version CHECK (format_version IN (1,2)),
  ADD CONSTRAINT export_archives_state
    CHECK (state IN ('queued','building','ready','failed','cancelled')),
  ADD CONSTRAINT export_archives_blob_key_format CHECK ((format_version = 1) = (blob_key IS NOT NULL)),
  ADD CONSTRAINT export_archives_ready_fields
    CHECK ((state = 'ready') = (byte_size IS NOT NULL AND expires_at IS NOT NULL)),
  ADD CONSTRAINT export_archives_version_one_ready CHECK (format_version = 2 OR state = 'ready'),
  ADD CONSTRAINT export_archives_ended CHECK ((state IN ('failed','cancelled')) = (ended_at IS NOT NULL)),
  ADD CONSTRAINT export_archives_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  ADD CONSTRAINT export_archives_failure_code CHECK (failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ADD CONSTRAINT export_archives_rebuild_passes CHECK (rebuild_passes >= 0),
  ADD CONSTRAINT export_archives_progress CHECK (progress_done >= 0 AND (progress_total IS NULL OR progress_total >= 0));

-- One job in progress per community (owner) and per member (personal). A ready archive that has
-- not expired is also "open"; expiry depends on the clock, so the create path checks that part.
CREATE UNIQUE INDEX export_archives_open_owner_unique ON export_archives(community_id)
  WHERE scope = 'owner' AND state IN ('queued','building');
CREATE UNIQUE INDEX export_archives_open_personal_unique ON export_archives(requester_member_id)
  WHERE scope = 'personal' AND state IN ('queued','building');
CREATE INDEX export_archives_due_idx ON export_archives(next_attempt_at, created_at)
  WHERE state IN ('queued','building');
CREATE INDEX export_archives_requester_idx
  ON export_archives(community_id, requester_member_id, created_at DESC);
CREATE INDEX export_archives_ended_idx ON export_archives(ended_at)
  WHERE state IN ('failed','cancelled');

-- The consecutive blobs of one version 2 archive. A segment holds whole zip entries; its
-- central-directory rows are kept structured (entries_index) with offsets relative to the
-- segment, so rewriting one segment only means writing the tail again. A row exists only while
-- its blob is committed: every path that queues a segment's blob deletes the row with it.
CREATE TABLE export_segments (
  export_id uuid NOT NULL,
  segment_no integer NOT NULL CHECK (segment_no > 0),
  community_id uuid NOT NULL REFERENCES communities(id),
  kind text NOT NULL CHECK (kind IN ('data','collection','tail')),
  blob_key text NOT NULL UNIQUE,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  -- A data segment's messages, inclusive, in (channel_id, seq) order.
  first_channel_id uuid,
  first_seq bigint,
  last_channel_id uuid,
  last_seq bigint,
  -- The newest redaction row committed before the segment read its messages: rows up to it are
  -- already reflected in the segment, so only newer ones can make it stale.
  read_redaction_id bigint,
  entries_index bytea NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  file_count integer NOT NULL CHECK (file_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (export_id, segment_no),
  CONSTRAINT export_segments_archive_tenant_fk FOREIGN KEY (community_id, export_id)
    REFERENCES export_archives(community_id, id) ON DELETE CASCADE,
  CONSTRAINT export_segments_data_range CHECK (
    (kind = 'data') = (first_channel_id IS NOT NULL AND first_seq IS NOT NULL
      AND last_channel_id IS NOT NULL AND last_seq IS NOT NULL AND read_redaction_id IS NOT NULL)
  )
);
CREATE INDEX export_segments_community_idx ON export_segments(community_id);
