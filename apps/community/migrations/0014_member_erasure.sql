-- Member erasure (specs/community-member-erasure): a person erases themselves from one
-- community, or deletes their account and is erased from every community on the host.
-- Old code ignores every table and column added here.

-- An erased member row stays as a husk that entries and audit rows still point at, but it no
-- longer leads to an account. The import migration widens the presence check with its
-- historical members; whichever of the two lands second owns the combined check.
ALTER TABLE members
  ADD COLUMN erased_at timestamptz,
  ALTER COLUMN user_id DROP NOT NULL,
  ADD CONSTRAINT members_user_presence CHECK (user_id IS NOT NULL OR erased_at IS NOT NULL),
  ADD CONSTRAINT members_erased_husk CHECK (erased_at IS NULL OR (user_id IS NULL AND NOT active));

ALTER TABLE entries ADD COLUMN erased_at timestamptz;

-- Erasure rewrites idempotency_key in place. PostgreSQL treats a column in a plain unique
-- index as a row key, so that update would take FOR UPDATE on the entry and block (or
-- deadlock with) a reply, which holds FOR KEY SHARE on its parent while it holds the channel.
-- A partial unique index is not a row key; since a NULL author never conflicts, this one
-- enforces exactly what the table constraint did. The agent twin is already partial.
CREATE UNIQUE INDEX entries_author_key_unique
  ON entries(author_member_id, channel_id, idempotency_key) WHERE author_member_id IS NOT NULL;
ALTER TABLE entries DROP CONSTRAINT entries_author_member_id_channel_id_idempotency_key_key;

-- Signed into every redaction feed cursor. A backup restore rewinds entry_redactions, so
-- erasure:reapply replaces this with a new random value and old cursors stop working.
ALTER TABLE communities
  ADD COLUMN redaction_epoch bigint NOT NULL
    DEFAULT (('x' || substr(md5(gen_random_uuid()::text), 1, 16))::bit(64)::bigint);

-- The owner may ask to delete a suspended community, so a cancel must know where to return.
-- deletion_from_prior_state holds the state a suspension (or, later, a hold) started from,
-- because entering deletion_pending clears suspended_from_state.
ALTER TABLE communities
  ADD COLUMN deletion_from_state text,
  ADD COLUMN deletion_from_prior_state text,
  ADD CONSTRAINT communities_deletion_from_state CHECK (
    (deletion_from_state IS NULL OR deletion_from_state IN ('active','archived','suspended','held'))
    AND (deletion_from_prior_state IS NULL OR deletion_from_prior_state IN ('active','archived','held'))
    AND (
      (lifecycle <> 'deletion_pending' AND deletion_from_state IS NULL AND deletion_from_prior_state IS NULL)
      OR (lifecycle = 'deletion_pending'
        AND (deletion_from_state IS NOT NULL AND deletion_from_state IN ('suspended','held'))
          = (deletion_from_prior_state IS NOT NULL))
    )
  );
UPDATE communities SET deletion_from_state='archived' WHERE lifecycle='deletion_pending';

-- Every way out of deletion_pending (a cancel, the deletion worker, or code that predates these
-- columns) must clear them, or the check above refuses the lifecycle change.
CREATE FUNCTION clear_deletion_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle <> 'deletion_pending' THEN
    NEW.deletion_from_state := NULL;
    NEW.deletion_from_prior_state := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER communities_clear_deletion_origin
BEFORE UPDATE OF lifecycle ON communities
FOR EACH ROW EXECUTE FUNCTION clear_deletion_origin();

-- One row per community. Erasure bumps it in the same transaction as every content change,
-- and an export's commit reads it FOR SHARE, so an export snapshotted before an erasure cannot
-- commit after it. A row of its own keeps that contention away from posts.
-- Every new tenant row cascades from its community, so tenant deletion and abandonment (in
-- this code or in code that predates these tables) remove them without naming them.
CREATE TABLE community_content_versions (
  community_id uuid PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);
INSERT INTO community_content_versions(community_id) SELECT id FROM communities;
CREATE FUNCTION create_community_content_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO community_content_versions(community_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER communities_content_version
AFTER INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION create_community_content_version();

ALTER TABLE export_archives ADD COLUMN content_version bigint;

CREATE TABLE erasure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('membership','account')),
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  member_id uuid,
  parent_request_id uuid REFERENCES erasure_requests(id),
  state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled','running','completed','cancelled')),
  execute_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error_class text CHECK (last_error_class IS NULL OR last_error_class ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT erasure_requests_member_tenant_fk
    FOREIGN KEY (community_id, member_id) REFERENCES members(community_id, id) ON DELETE CASCADE,
  -- No row links an account to a community: a membership request names only the member.
  CONSTRAINT erasure_requests_kind_shape CHECK (
    (kind = 'account' AND community_id IS NULL AND member_id IS NULL
      AND (user_id IS NOT NULL OR state IN ('completed','cancelled')))
    OR (kind = 'membership' AND community_id IS NOT NULL AND member_id IS NOT NULL
      AND user_id IS NULL)
  ),
  CONSTRAINT erasure_requests_window CHECK (execute_after >= created_at),
  CONSTRAINT erasure_requests_state_times CHECK (
    (state = 'scheduled' AND started_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND cancelled_at IS NULL)
    OR (state = 'cancelled' AND started_at IS NULL AND completed_at IS NULL
      AND cancelled_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX erasure_requests_open_membership_unique
  ON erasure_requests(community_id, member_id) WHERE state IN ('scheduled','running');
CREATE UNIQUE INDEX erasure_requests_open_account_unique
  ON erasure_requests(user_id) WHERE kind = 'account' AND state IN ('scheduled','running');
CREATE INDEX erasure_requests_due_idx
  ON erasure_requests(next_attempt_at, execute_after) WHERE state IN ('scheduled','running');
CREATE INDEX erasure_requests_community_idx ON erasure_requests(community_id, state);
CREATE INDEX erasure_requests_parent_idx ON erasure_requests(parent_request_id);

-- One row per entry an erasure changed, so DorkOS installations can later replace their
-- cached copies (the redaction feed). It carries ids only, never content.
CREATE TABLE entry_redactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Checked at commit: an immediate check would hold FOR KEY SHARE on the channel for the
  -- whole erasure batch, and every post in that channel waits for its channel FOR UPDATE.
  CONSTRAINT entry_redactions_channel_tenant_fk
    FOREIGN KEY (community_id, channel_id) REFERENCES channels(community_id, id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT entry_redactions_entry_tenant_fk
    FOREIGN KEY (community_id, entry_id) REFERENCES entries(community_id, id) ON DELETE CASCADE
);
CREATE INDEX entry_redactions_channel_idx ON entry_redactions(channel_id, id);
CREATE INDEX entry_redactions_community_idx ON entry_redactions(community_id);
