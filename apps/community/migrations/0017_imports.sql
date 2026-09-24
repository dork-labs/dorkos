-- Import an owner export on another host (host-operator P3). A host creates an import, which
-- makes a new unclaimed community; the export arrives by upload, a background worker checks it
-- and restores it, and nothing of it is visible until one transaction commits every row.
--
-- This is the one migration old code cannot fully tolerate once an import has completed: an
-- imported community holds members with no account. Backing out after that is forward-fix
-- only (see the host-operator spec's backout section).

-- Historical members: the authors an export names, restored without an account. They never
-- sign in; the owner adopts theirs by claiming the community. This widens the presence check
-- member erasure added (an erased husk also has no account).
ALTER TABLE members
  ADD COLUMN origin text NOT NULL DEFAULT 'native',
  ADD CONSTRAINT members_origin CHECK (origin IN ('native','imported')),
  DROP CONSTRAINT members_user_presence,
  ADD CONSTRAINT members_user_presence CHECK (
    user_id IS NOT NULL OR erased_at IS NOT NULL OR (origin = 'imported' AND NOT active)
  );

ALTER TABLE communities ADD COLUMN imported_at timestamptz;

-- The uploaded export itself. Its bytes show in usage as import staging and never count
-- against a storage limit.
ALTER TABLE managed_blobs
  DROP CONSTRAINT managed_blobs_purpose,
  ADD CONSTRAINT managed_blobs_purpose CHECK (
    purpose IN ('attachment','export','icon','legacy_cleanup','import_staging')
  );

CREATE TABLE community_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cleared when a cancelled or failed import's unclaimed community is removed. The import row
  -- stays, so whoever started it can still read how it ended.
  community_id uuid UNIQUE REFERENCES communities(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_upload',
  auto_commit boolean NOT NULL DEFAULT false,
  upload_token_hash text NOT NULL UNIQUE,
  upload_expires_at timestamptz NOT NULL,
  archive_sha256 text,
  archive_bytes bigint,
  staging_blob_key text UNIQUE REFERENCES managed_blobs(blob_key) ON DELETE SET NULL,
  manifest_version integer,
  -- Counts and sizes only, never text or names.
  report jsonb,
  failure_code text,
  attempts integer NOT NULL DEFAULT 0,
  -- Due time for the worker, and the lease a claimed job holds; lease_token fences a worker
  -- whose lease expired from writing over the one that took the job next.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  -- Set when the worker has nothing left to do: the import is ready, or a cancelled or failed
  -- import's leftovers are gone.
  settled_at timestamptz,
  created_by_user_id text REFERENCES "user"(id),
  created_by_api_key_id uuid REFERENCES host_api_keys(id),
  validated_at timestamptz,
  -- The restored owner row the claimant adopts; set when the import is ready.
  adopt_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_imports_idempotency_key CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT community_imports_payload_hash CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT community_imports_token_hash CHECK (upload_token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT community_imports_state CHECK (
    state IN ('awaiting_upload','validating','validated','restoring','ready','failed','cancelled')
  ),
  CONSTRAINT community_imports_archive CHECK (
    (archive_sha256 IS NULL) = (archive_bytes IS NULL)
    AND (archive_sha256 IS NULL OR archive_sha256 ~ '^[a-f0-9]{64}$')
    AND (archive_bytes IS NULL OR archive_bytes > 0)
    AND (state IN ('awaiting_upload','cancelled','failed') OR archive_sha256 IS NOT NULL)
  ),
  CONSTRAINT community_imports_manifest_version CHECK (manifest_version IS NULL OR manifest_version > 0),
  CONSTRAINT community_imports_report CHECK (
    (report IS NULL) = (state IN ('awaiting_upload','validating') OR (state IN ('failed','cancelled') AND validated_at IS NULL))
  ),
  CONSTRAINT community_imports_failure CHECK (
    (state = 'failed') = (failure_code IS NOT NULL)
    AND (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
  ),
  CONSTRAINT community_imports_attempts CHECK (attempts >= 0),
  CONSTRAINT community_imports_creator CHECK (num_nonnulls(created_by_user_id, created_by_api_key_id) = 1),
  -- An unsettled import always has its community. A settled one outlives it: a cancelled or
  -- failed import removes its community, and a ready one's owner may later delete theirs.
  CONSTRAINT community_imports_community CHECK (community_id IS NOT NULL OR settled_at IS NOT NULL),
  CONSTRAINT community_imports_settled CHECK (
    settled_at IS NULL OR state IN ('ready','failed','cancelled')
  )
);
CREATE INDEX community_imports_due_idx ON community_imports(next_attempt_at, id)
  WHERE settled_at IS NULL;
CREATE INDEX community_imports_settled_idx ON community_imports(settled_at) WHERE settled_at IS NOT NULL;

-- Restore progress: one row per file the worker has stored and verified against the export,
-- so a restart skips what is done. The content type is the one storage detected from the bytes.
CREATE TABLE community_import_files (
  import_id uuid NOT NULL REFERENCES community_imports(id) ON DELETE CASCADE,
  source_attachment_id uuid NOT NULL,
  blob_key text NOT NULL UNIQUE REFERENCES managed_blobs(blob_key),
  content_type text NOT NULL,
  PRIMARY KEY (import_id, source_attachment_id)
);

-- The import worker acts on its own: its completions and failures are host audit rows whose
-- actor is the system, not a person or a key.
ALTER TABLE host_audit_events
  DROP CONSTRAINT host_audit_events_actor_kind,
  ADD CONSTRAINT host_audit_events_actor_kind CHECK (
    actor_kind IN ('person','api_key','offline','system')
  );
