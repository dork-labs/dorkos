ALTER TABLE communities
  ADD COLUMN admission_policy text NOT NULL DEFAULT 'invite_only',
  ADD COLUMN settings_version integer NOT NULL DEFAULT 1,
  ADD COLUMN icon_blob_key text,
  ADD COLUMN icon_content_type text,
  ADD COLUMN suspended_from_state text,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN delete_requested_at timestamptz,
  ADD COLUMN delete_after timestamptz,
  ADD COLUMN delete_requested_by uuid;

UPDATE communities
SET activated_at = created_at
WHERE lifecycle IN ('active','suspended') AND activated_at IS NULL;

-- Version nine allowed suspended communities but did not retain the transition
-- provenance.  The former state can only have been active; the suspension
-- instant was not stored, so record this migration's observation rather than
-- inventing a historical timestamp.
UPDATE communities
SET suspended_from_state = 'active',
    suspended_at = now()
WHERE lifecycle = 'suspended';

ALTER TABLE communities DROP CONSTRAINT communities_lifecycle;
ALTER TABLE communities ADD CONSTRAINT communities_lifecycle CHECK (
  lifecycle IN ('pending_owner','active','archived','suspended','deletion_pending')
);
ALTER TABLE communities ADD CONSTRAINT communities_admission_policy CHECK (
  admission_policy IN ('invite_only','closed')
);
ALTER TABLE communities ADD CONSTRAINT communities_settings_version CHECK (settings_version > 0);
ALTER TABLE communities ADD CONSTRAINT communities_name_length CHECK (
  name = btrim(name) AND char_length(name) BETWEEN 1 AND 80
);
ALTER TABLE communities ADD CONSTRAINT communities_description_length CHECK (
  description IS NULL OR char_length(description) <= 1000
);
ALTER TABLE communities ADD CONSTRAINT communities_icon_metadata CHECK (
  (icon_blob_key IS NULL AND icon_content_type IS NULL)
  OR (icon_blob_key IS NOT NULL AND icon_content_type IN ('image/png','image/jpeg','image/gif','image/webp'))
);
ALTER TABLE communities ADD CONSTRAINT communities_suspension_state CHECK (
  (lifecycle = 'suspended' AND suspended_from_state IN ('active','archived') AND suspended_at IS NOT NULL)
  OR (lifecycle <> 'suspended' AND suspended_from_state IS NULL AND suspended_at IS NULL)
);
ALTER TABLE communities ADD CONSTRAINT communities_deletion_state CHECK (
  (lifecycle = 'deletion_pending' AND delete_requested_at IS NOT NULL
    AND delete_after IS NOT NULL AND delete_requested_by IS NOT NULL
    AND delete_after = delete_requested_at + interval '7 days')
  OR (lifecycle <> 'deletion_pending' AND delete_requested_at IS NULL
    AND delete_after IS NULL AND delete_requested_by IS NULL)
);
ALTER TABLE communities ADD CONSTRAINT communities_icon_tenant_fk
  FOREIGN KEY(id,icon_blob_key) REFERENCES managed_blobs(community_id,blob_key);
ALTER TABLE communities ADD CONSTRAINT communities_delete_requester_tenant_fk
  FOREIGN KEY(id,delete_requested_by) REFERENCES members(community_id,id);

ALTER TABLE managed_blobs DROP CONSTRAINT managed_blobs_purpose;
ALTER TABLE managed_blobs ADD CONSTRAINT managed_blobs_purpose CHECK (
  purpose IN ('attachment','export','icon','legacy_cleanup')
);

ALTER TABLE bootstrap_grants
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by text REFERENCES "user"(id),
  ADD CONSTRAINT bootstrap_grants_revocation CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  );

ALTER TABLE connection_grants
  ADD COLUMN history_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT connection_grants_history_only_scope CHECK (
    NOT history_only OR scopes = ARRAY['read']::text[]
  );

CREATE TABLE community_creation_receipts (
  idempotency_key text PRIMARY KEY,
  operator_user_id text NOT NULL REFERENCES host_operators(user_id),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  community_id uuid NOT NULL UNIQUE REFERENCES communities(id),
  owner_claim_grant_id uuid NOT NULL UNIQUE REFERENCES bootstrap_grants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
);

CREATE TABLE host_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id text NOT NULL REFERENCES "user"(id),
  community_id uuid,
  action text NOT NULL,
  prior_state text,
  next_state text,
  changed_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (action ~ '^[a-z][a-z0-9_.]{0,79}$'),
  CHECK (cardinality(changed_fields) <= 16)
);
CREATE INDEX host_audit_events_community_created_idx
  ON host_audit_events(community_id,created_at,id);

ALTER TABLE audit_events
  ADD COLUMN actor_kind text NOT NULL DEFAULT 'member',
  ADD COLUMN prior_state text,
  ADD COLUMN next_state text,
  ADD COLUMN changed_fields text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT audit_events_actor_kind CHECK (actor_kind IN ('member','system')),
  ADD CONSTRAINT audit_events_changed_fields CHECK (cardinality(changed_fields) <= 16);

CREATE TABLE community_deletion_jobs (
  community_id uuid PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  requested_by_member_id uuid NOT NULL,
  lifecycle_version integer NOT NULL CHECK (lifecycle_version > 0),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','deleting','retrying')),
  delete_after timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_deletion_jobs_requester_tenant_fk
    FOREIGN KEY(community_id,requested_by_member_id) REFERENCES members(community_id,id),
  CHECK (last_error_class IS NULL OR last_error_class ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
CREATE INDEX community_deletion_jobs_due_idx
  ON community_deletion_jobs(next_attempt_at,community_id);

CREATE TABLE community_deletion_blob_progress (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  blob_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','deleted','retrying')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_class text,
  deleted_at timestamptz,
  PRIMARY KEY(community_id,blob_key),
  CHECK (blob_key ~ '^[a-f0-9]{64}$'),
  CHECK (last_error_class IS NULL OR last_error_class ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX community_deletion_blob_progress_due_idx
  ON community_deletion_blob_progress(community_id,next_attempt_at,blob_key)
  WHERE state <> 'deleted';

CREATE FUNCTION enforce_deletion_blob_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     (OLD.community_id IS DISTINCT FROM NEW.community_id OR OLD.blob_key IS DISTINCT FROM NEW.blob_key) THEN
    RAISE EXCEPTION 'deletion blob ownership is immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM managed_blobs m
    WHERE m.community_id = NEW.community_id AND m.blob_key = NEW.blob_key
  ) THEN
    RAISE EXCEPTION 'deletion blob is not owned by community';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER community_deletion_blob_ownership
BEFORE INSERT OR UPDATE OF community_id,blob_key ON community_deletion_blob_progress
FOR EACH ROW EXECUTE FUNCTION enforce_deletion_blob_ownership();

CREATE TABLE community_deletion_tombstones (
  community_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('deleted')),
  retry_count integer NOT NULL CHECK (retry_count >= 0),
  expires_at timestamptz NOT NULL,
  CHECK (completed_at >= requested_at),
  CHECK (expires_at = completed_at + interval '30 days')
);
CREATE INDEX community_deletion_tombstones_expiry_idx
  ON community_deletion_tombstones(expires_at,community_id);

DROP FUNCTION enforce_community_owner_lifecycle() CASCADE;
CREATE FUNCTION enforce_community_owner_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  target_lifecycle text;
  active_owners bigint;
BEGIN
  IF TG_TABLE_NAME='members' THEN
    IF TG_OP='UPDATE' AND OLD.community_id IS DISTINCT FROM NEW.community_id THEN
      RAISE EXCEPTION 'member community is immutable';
    END IF;
  END IF;
  IF TG_TABLE_NAME='communities' THEN
    target_id := NEW.id;
  ELSIF TG_OP='DELETE' THEN
    target_id := OLD.community_id;
  ELSE
    target_id := NEW.community_id;
  END IF;
  SELECT lifecycle INTO target_lifecycle FROM communities WHERE id=target_id;
  IF target_lifecycle IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO active_owners FROM members
  WHERE community_id=target_id AND role='owner' AND active;
  IF target_lifecycle='pending_owner' AND active_owners<>0 THEN
    RAISE EXCEPTION 'pending_owner community cannot have an active owner';
  END IF;
  IF target_lifecycle IN ('active','archived','suspended','deletion_pending')
     AND active_owners<>1 THEN
    RAISE EXCEPTION 'claimed community requires exactly one active owner';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER communities_owner_lifecycle
AFTER INSERT OR UPDATE OF lifecycle ON communities
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_community_owner_lifecycle();
CREATE CONSTRAINT TRIGGER members_owner_lifecycle
AFTER INSERT OR UPDATE OF community_id,role,active OR DELETE ON members
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_community_owner_lifecycle();
