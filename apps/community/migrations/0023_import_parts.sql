-- Import any size (community-export-any-size task 2.1): an export arrives in numbered parts
-- beside the single upload, and a version 2 export restores in batches that a restarted worker
-- resumes. Old code ignores every column and table here: it never writes a part, and it reads
-- only single uploads and version 1 archives.

-- How the export arrived, set when it did: one upload, or parts put together by `complete`.
-- Rows that already hold an export came by the single upload, the only kind there was. Code
-- from before this migration records an upload without naming its kind, so an export with no
-- kind is a single upload; only a kind with no export is refused.
ALTER TABLE community_imports ADD COLUMN upload_kind text;
UPDATE community_imports SET upload_kind='single' WHERE archive_sha256 IS NOT NULL;
ALTER TABLE community_imports
  ADD CONSTRAINT community_imports_upload_kind CHECK (
    upload_kind IS NULL OR (upload_kind IN ('single','parts') AND archive_sha256 IS NOT NULL)
  ),
  -- Whether the create request named a description or an admission policy. A version 2 export
  -- carries both; it fills in only what the host left out. Earlier imports never restore them.
  ADD COLUMN description_given boolean NOT NULL DEFAULT true,
  ADD COLUMN admission_policy_given boolean NOT NULL DEFAULT true,
  -- Where a version 2 restore stands: the step, the file within it, and the lines of that file
  -- already committed. Each batch updates it in the transaction that inserts its rows.
  ADD COLUMN restore_progress jsonb,
  ADD CONSTRAINT community_imports_restore_progress CHECK (
    restore_progress IS NULL OR jsonb_typeof(restore_progress) = 'object'
  );

-- One uploaded part. Its bytes are a managed blob (purpose import_staging), checked against the
-- SHA-256 its uploader declared. The parts are put together in part-number order.
CREATE TABLE community_import_parts (
  import_id uuid NOT NULL REFERENCES community_imports(id) ON DELETE CASCADE,
  part_number integer NOT NULL,
  blob_key text NOT NULL UNIQUE REFERENCES managed_blobs(blob_key) ON DELETE CASCADE,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, part_number),
  CONSTRAINT community_import_parts_number CHECK (part_number BETWEEN 1 AND 10000),
  CONSTRAINT community_import_parts_size CHECK (byte_size > 0),
  CONSTRAINT community_import_parts_sha256 CHECK (sha256 ~ '^[a-f0-9]{64}$')
);

-- One part upload in flight, on any replica: at most four per import, one per part number. A
-- short lease the receiving request renews, so a crashed request frees its slot within minutes.
CREATE TABLE community_import_part_uploads (
  lease_token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES community_imports(id) ON DELETE CASCADE,
  part_number integer NOT NULL,
  lease_until timestamptz NOT NULL,
  CONSTRAINT community_import_part_uploads_number CHECK (part_number BETWEEN 1 AND 10000)
);
CREATE INDEX community_import_part_uploads_import_idx
  ON community_import_part_uploads(import_id, part_number);

-- A restored community icon is progress like a restored file, kept apart by its purpose. The
-- icon has no source id of its own, so it takes the nil UUID, which no attachment may use.
ALTER TABLE community_import_files
  ADD COLUMN purpose text NOT NULL DEFAULT 'attachment',
  ADD CONSTRAINT community_import_files_purpose CHECK (
    purpose IN ('attachment','icon')
    AND (purpose = 'icon') = (source_attachment_id = '00000000-0000-0000-0000-000000000000')
  );
