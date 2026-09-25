-- Host takedowns of one message, one file, or a community's icon (specs/community-host-takedown,
-- phase 1; ADR 260923-214421). A takedown names content by id, hides it at once, and, when the
-- host has an evidence store, copies it there before the bytes leave primary storage. Nothing
-- here holds content except takedown_evidence_staging, whose row is deleted once the copy lands
-- or a host operator releases it.
--
-- Backout: let the worker finish every pending evidence copy, or release held bytes with
-- `takedowns:release-held <id>`, before reverting the code: code that predates this migration
-- does not know the evidence_hold blob state. This migration stays applied.

-- The fifth host scope. A person holds every scope; a key needs this one to take anything down.
ALTER TABLE host_api_keys DROP CONSTRAINT host_api_keys_scopes;
ALTER TABLE host_api_keys ADD CONSTRAINT host_api_keys_scopes CHECK (
  cardinality(scopes) BETWEEN 1 AND 5
  AND scopes <@ ARRAY[
    'communities:read','communities:write','communities:lifecycle','communities:import',
    'communities:takedown'
  ]::text[]
);

-- The evidence worker records that a copy landed, as the server itself rather than as a person
-- or a key. The SHA-256 of record.json is kept beside it, so a later copy can be checked.
ALTER TABLE host_audit_events DROP CONSTRAINT host_audit_events_actor_kind;
ALTER TABLE host_audit_events
  ADD CONSTRAINT host_audit_events_actor_kind
    CHECK (actor_kind IN ('person','api_key','offline','system')),
  ADD COLUMN evidence_record_sha256 text
    CONSTRAINT host_audit_events_evidence_record_sha256 CHECK (evidence_record_sha256 ~ '^[a-f0-9]{64}$');

-- A takedown writes a tenant audit row with no member. `withheld` is set when the host chose not
-- to tell the owner and author (notify false); owner exports and owner-facing reads leave it out.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_kind;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_kind CHECK (actor_kind IN ('member','system','host')),
  ADD COLUMN withheld boolean NOT NULL DEFAULT false;

-- Bytes a takedown holds for its evidence copy: unreachable through every route, counted by no
-- limit, and left alone by the pending-deletion sweep. They were committed before, so they keep
-- their metadata and committed_at.
ALTER TABLE managed_blobs DROP CONSTRAINT managed_blobs_state_check;
ALTER TABLE managed_blobs ADD CONSTRAINT managed_blobs_state CHECK (
  state IN ('reserved','stored','committed','pending_delete','evidence_hold')
);
ALTER TABLE managed_blobs DROP CONSTRAINT managed_blobs_stored_metadata;
ALTER TABLE managed_blobs ADD CONSTRAINT managed_blobs_stored_metadata CHECK (
  (state = 'reserved' AND byte_size IS NULL AND checksum IS NULL AND stored_at IS NULL)
  OR (state IN ('stored','committed','evidence_hold') AND byte_size IS NOT NULL AND byte_size > 0
    AND checksum IS NOT NULL AND stored_at IS NOT NULL)
  OR (
    state = 'pending_delete'
    AND (
      (byte_size IS NULL AND checksum IS NULL AND stored_at IS NULL)
      OR (byte_size IS NOT NULL AND byte_size > 0 AND checksum IS NOT NULL AND stored_at IS NOT NULL)
    )
  )
);
ALTER TABLE managed_blobs DROP CONSTRAINT managed_blobs_commit_timestamp;
ALTER TABLE managed_blobs ADD CONSTRAINT managed_blobs_commit_timestamp CHECK (
  (state <> 'committed' OR committed_at IS NOT NULL)
  AND (committed_at IS NULL OR state IN ('committed','pending_delete','evidence_hold'))
);

-- One row per takedown: ids, reasons, and states only. No foreign key to communities: the record
-- outlives a deleted community. channel_id and subject_member_id (the member the content counts
-- as: its author, or its agent's owner) are kept so the notice list still works once the file
-- row is gone.
CREATE TABLE community_takedowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('entry','attachment','icon','community')),
  entry_id uuid,
  attachment_id uuid,
  channel_id uuid,
  subject_member_id uuid,
  category text NOT NULL
    CHECK (category IN ('child_safety','illegal_content','legal_order','terms_violation')),
  reference text CHECK (reference ~ '^[A-Za-z0-9._:-]{1,64}$'),
  notify boolean NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('person','api_key')),
  actor_user_id text REFERENCES "user"(id),
  actor_api_key_id uuid REFERENCES host_api_keys(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','reversed')),
  evidence_state text NOT NULL CHECK (evidence_state IN (
    'pending','retrying','stored','failed','not_configured','nothing_to_preserve','held_on_primary'
  )),
  evidence_location text,
  evidence_record_sha256 text CHECK (evidence_record_sha256 ~ '^[a-f0-9]{64}$'),
  -- Every attempt ever made; it numbers the attempt folders, so it never goes back.
  evidence_attempts integer NOT NULL DEFAULT 0 CHECK (evidence_attempts >= 0),
  -- Failures since the last success or retry; at 5 the evidence is `failed`.
  evidence_failures integer NOT NULL DEFAULT 0 CHECK (evidence_failures >= 0),
  evidence_alerted_at timestamptz,
  prior_state jsonb,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_error_class text CHECK (last_error_class ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  -- Who gave up an unsaved copy and let its bytes go: a host operator, or the offline command.
  -- Kept here because this row outlives the community, unlike most of its audit trail.
  released_by_kind text CHECK (released_by_kind IN ('person','offline')),
  released_by_user_id text REFERENCES "user"(id),
  released_at timestamptz,
  CONSTRAINT community_takedowns_release CHECK (
    (released_at IS NULL) = (released_by_kind IS NULL)
    AND (released_by_kind = 'person') = (released_by_user_id IS NOT NULL)
  ),
  CONSTRAINT community_takedowns_target CHECK (
    (target_kind = 'entry' AND entry_id IS NOT NULL AND attachment_id IS NULL)
    OR (target_kind = 'attachment' AND attachment_id IS NOT NULL)
    OR (target_kind IN ('icon','community') AND entry_id IS NULL AND attachment_id IS NULL)
  ),
  CONSTRAINT community_takedowns_actor CHECK (
    (actor_kind = 'person') = (actor_user_id IS NOT NULL)
    AND (actor_kind = 'api_key') = (actor_api_key_id IS NOT NULL)
  ),
  CONSTRAINT community_takedowns_reversal CHECK ((state = 'reversed') = (reversed_at IS NOT NULL)),
  CONSTRAINT community_takedowns_evidence_stored CHECK (
    (evidence_state = 'stored') = (evidence_record_sha256 IS NOT NULL)
    AND (evidence_state = 'stored') = (evidence_location IS NOT NULL)
  ),
  CONSTRAINT community_takedowns_evidence_due CHECK (
    evidence_state NOT IN ('pending','retrying') OR next_attempt_at IS NOT NULL
  )
);
-- Idempotency is per actor: two operators or two keys choosing the same key never collide.
CREATE UNIQUE INDEX community_takedowns_idempotency
  ON community_takedowns(actor_kind, COALESCE(actor_user_id, actor_api_key_id::text), idempotency_key);
CREATE INDEX community_takedowns_created_idx ON community_takedowns(created_at DESC, id DESC);
CREATE INDEX community_takedowns_community_idx
  ON community_takedowns(community_id, created_at DESC, id DESC);
CREATE INDEX community_takedowns_due_idx ON community_takedowns(next_attempt_at)
  WHERE evidence_state IN ('pending','retrying');
-- The deletion gate: a community with unsettled evidence is not deleted.
CREATE INDEX community_takedowns_unsettled_idx ON community_takedowns(community_id)
  WHERE evidence_state IN ('pending','retrying','failed','held_on_primary');

-- The evidence record as it was at the takedown (text, author, account, sessions, file
-- metadata) and the held blobs, until the copy lands or a host operator releases them. Kept
-- apart from the member's rows, so a later erasure or sign-out cannot take them from the copy.
CREATE TABLE takedown_evidence_staging (
  takedown_id uuid PRIMARY KEY REFERENCES community_takedowns(id) ON DELETE CASCADE,
  record jsonb NOT NULL,
  blob_keys text[] NOT NULL
);

-- A file an author or admin removed, whose bytes are queued but not yet swept. If the host then
-- takes down the removed message, these rows let the takedown hold the bytes again and describe
-- them in its evidence. The sweep deletes each row with its bytes, and erasure never writes one.
CREATE TABLE removed_file_blobs (
  blob_key text PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id),
  entry_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  display_name text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  uploaded_at timestamptz NOT NULL,
  uploader_member_id uuid,
  uploader_agent_id uuid
);
CREATE INDEX removed_file_blobs_entry_idx ON removed_file_blobs(community_id, entry_id);
