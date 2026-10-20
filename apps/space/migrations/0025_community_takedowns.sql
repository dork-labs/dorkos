-- Whole-community takedowns (specs/community-host-takedown, phase 2; ADR 260923-214421). The
-- host takes a whole community down by id: every credential is revoked, it becomes a pending
-- deletion whose requester is the host, and it is deleted once its reversal window (at least a
-- day) ends and its evidence has settled. The evidence is an export job of its own scope,
-- 'evidence', that nobody asked for, nobody can download, and the takedown worker copies into
-- the evidence store before its segments are deleted.
--
-- Backout: reverse or finish every community takedown first (POST
-- /api/v1/host/takedowns/:id/reverse, or let the deletion run). Code that predates this
-- migration then sees ordinary rows: no community carries a takedown_id, and no evidence export
-- is left. This migration stays applied.

-- The takedown a pending deletion belongs to. Only a pending deletion has one, and its
-- requester is always the host.
ALTER TABLE communities
  ADD COLUMN takedown_id uuid,
  ADD CONSTRAINT communities_takedown CHECK (
    takedown_id IS NULL
    OR (lifecycle = 'deletion_pending' AND delete_requested_by_host_actor IS NOT NULL)
  );

-- A takedown waits out its own reversal window instead of the seven-day deletion notice, but
-- never less than a day, so a mistaken or malicious takedown can always be reversed.
ALTER TABLE communities DROP CONSTRAINT communities_deletion_state;
ALTER TABLE communities ADD CONSTRAINT communities_deletion_state CHECK (
  (lifecycle = 'deletion_pending' AND delete_requested_at IS NOT NULL
    AND delete_after IS NOT NULL
    AND num_nonnulls(delete_requested_by, delete_requested_by_host_actor) = 1
    AND (
      delete_after = delete_requested_at + interval '7 days'
      OR (takedown_id IS NOT NULL AND delete_after >= delete_requested_at + interval '24 hours')
    ))
  OR (lifecycle <> 'deletion_pending' AND delete_requested_at IS NULL
    AND delete_after IS NULL AND delete_requested_by IS NULL
    AND delete_requested_by_host_actor IS NULL)
);

ALTER TABLE community_deletion_jobs
  ADD COLUMN takedown_id uuid,
  ADD CONSTRAINT community_deletion_jobs_takedown CHECK (
    takedown_id IS NULL OR requested_by_host_actor IS NOT NULL
  );

-- The evidence export a community takedown is waiting on, and when its reversal window ends
-- (the community's deletion is due). No foreign key: the takedown row outlives the community,
-- and with it every export.
ALTER TABLE community_takedowns
  ADD COLUMN evidence_export_id uuid,
  ADD COLUMN delete_after timestamptz,
  ADD CONSTRAINT community_takedowns_evidence_export CHECK (
    evidence_export_id IS NULL OR target_kind = 'community'
  ),
  ADD CONSTRAINT community_takedowns_delete_after CHECK (
    (target_kind = 'community') = (delete_after IS NOT NULL)
  );
-- Community takedowns per actor in the last day (the rate limit).
CREATE INDEX community_takedowns_actor_community_idx
  ON community_takedowns(actor_kind, COALESCE(actor_user_id, actor_api_key_id::text), created_at)
  WHERE target_kind = 'community';

-- The evidence scope. It has no requester: its authority is the takedown that made it.
ALTER TABLE export_archives DROP CONSTRAINT export_archives_scope_check;
ALTER TABLE export_archives
  ALTER COLUMN requester_member_id DROP NOT NULL,
  ADD COLUMN evidence_takedown_id uuid,
  ADD CONSTRAINT export_archives_scope CHECK (scope IN ('personal','owner','evidence')),
  ADD CONSTRAINT export_archives_evidence CHECK (
    (scope = 'evidence') = (requester_member_id IS NULL)
    AND (scope = 'evidence') = (evidence_takedown_id IS NOT NULL)
  );
-- One evidence export in progress per takedown.
CREATE UNIQUE INDEX export_archives_open_evidence_unique ON export_archives(evidence_takedown_id)
  WHERE scope = 'evidence' AND state IN ('queued','building');

-- A blob reserved for an evidence export names its takedown: it is committed against that
-- takedown, not against the community's lifecycle version, which a reversal moves.
ALTER TABLE managed_blobs
  ADD COLUMN evidence_takedown_id uuid,
  ADD CONSTRAINT managed_blobs_evidence_takedown CHECK (
    evidence_takedown_id IS NULL OR purpose = 'export'
  );
