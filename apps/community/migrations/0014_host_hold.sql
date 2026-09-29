-- Host hold and host-started deletion (specs/community-host-operator-api, "Host hold and
-- host-started deletion"; ADR 260923-121712). A hold makes a community read-only while its
-- owner can still export it; a host may delete a held community only after a published notice
-- date. Member erasure (0013) already added deletion_from_state and deletion_from_prior_state
-- and a check that allows 'held' in both; this migration reuses them rather than redefining.
--
-- Backout: release every hold and cancel every host-started deletion first (both are host
-- routes), then revert the code. With no held row and no host requester, code that predates
-- this migration sees only states it knows. This migration stays applied.

ALTER TABLE communities DROP CONSTRAINT communities_lifecycle;
ALTER TABLE communities ADD CONSTRAINT communities_lifecycle CHECK (
  lifecycle IN ('pending_owner','active','archived','suspended','held','deletion_pending')
);

-- held_from_state names where a release returns. It stays set for as long as the community is
-- under the hold: while held, while suspended from the hold, and while a deletion that started
-- from the hold (directly, or from a suspension of it) is pending, so every way back can restore
-- it. The notice date lives only under a hold.
ALTER TABLE communities
  ADD COLUMN held_from_state text,
  ADD COLUMN held_at timestamptz,
  ADD COLUMN deletion_notice_at timestamptz,
  ADD COLUMN delete_requested_by_host_actor text,
  ADD CONSTRAINT communities_hold_state CHECK (
    (held_from_state IS NULL) = (held_at IS NULL)
    AND (held_from_state IS NULL OR held_from_state IN ('active','archived'))
    AND (deletion_notice_at IS NULL OR held_from_state IS NOT NULL)
    AND (held_from_state IS NOT NULL) = (
      lifecycle = 'held'
      OR (lifecycle = 'suspended' AND suspended_from_state = 'held')
      OR (lifecycle = 'deletion_pending'
        AND (deletion_from_state = 'held' OR deletion_from_prior_state = 'held'))
    )
  ),
  ADD CONSTRAINT communities_host_requester CHECK (
    delete_requested_by_host_actor IS NULL
    OR delete_requested_by_host_actor ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$'
  );

ALTER TABLE communities DROP CONSTRAINT communities_suspension_state;
ALTER TABLE communities ADD CONSTRAINT communities_suspension_state CHECK (
  (lifecycle = 'suspended' AND suspended_from_state IS NOT NULL
    AND suspended_from_state IN ('active','archived','held') AND suspended_at IS NOT NULL)
  OR (lifecycle <> 'suspended' AND suspended_from_state IS NULL AND suspended_at IS NULL)
);

-- A pending deletion names exactly one requester: the owner, or the host.
ALTER TABLE communities DROP CONSTRAINT communities_deletion_state;
ALTER TABLE communities ADD CONSTRAINT communities_deletion_state CHECK (
  (lifecycle = 'deletion_pending' AND delete_requested_at IS NOT NULL
    AND delete_after IS NOT NULL
    AND num_nonnulls(delete_requested_by, delete_requested_by_host_actor) = 1
    AND delete_after = delete_requested_at + interval '7 days')
  OR (lifecycle <> 'deletion_pending' AND delete_requested_at IS NULL
    AND delete_after IS NULL AND delete_requested_by IS NULL
    AND delete_requested_by_host_actor IS NULL)
);

ALTER TABLE community_deletion_jobs
  ALTER COLUMN requested_by_member_id DROP NOT NULL,
  ADD COLUMN requested_by_host_actor text,
  ADD CONSTRAINT community_deletion_jobs_requester CHECK (
    num_nonnulls(requested_by_member_id, requested_by_host_actor) = 1
    AND (requested_by_host_actor IS NULL
      OR requested_by_host_actor ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$')
  );

-- A finished deletion still says who asked for it, for as long as its receipt lasts: the host
-- audit rows go with the tenant, so this is where a host-started deletion stays accountable.
-- Receipts written before this migration name no requester.
ALTER TABLE community_deletion_tombstones
  ADD COLUMN requested_by text,
  ADD COLUMN requested_by_host_actor text,
  ADD CONSTRAINT community_deletion_tombstones_requester CHECK (
    (requested_by IS NULL AND requested_by_host_actor IS NULL)
    OR (requested_by = 'owner' AND requested_by_host_actor IS NULL)
    OR (requested_by = 'host'
      AND requested_by_host_actor ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$')
  );

-- A held community still has exactly one active owner, who keeps export and their own deletion.
CREATE OR REPLACE FUNCTION enforce_community_owner_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF target_lifecycle IN ('active','archived','suspended','held','deletion_pending')
     AND active_owners<>1 THEN
    RAISE EXCEPTION 'claimed community requires exactly one active owner';
  END IF;
  RETURN NULL;
END $$;
