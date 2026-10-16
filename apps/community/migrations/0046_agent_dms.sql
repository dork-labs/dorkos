-- Direct messages with an agent (DOR-2955, specs/everything-is-a-space C6).
--
-- A direct message is a channel of its own kind: private, never joined on arrival, holding
-- exactly one person (`dm_member_id`) and one agent (`dm_agent_id`, the agent's member row since
-- 0042), each in the membership table that already gates reading and posting. So entries,
-- files, read cursors, live streams, reports, removals, erasure, takedowns and exports all work
-- on one unchanged. `GET /channels` leaves them out; `GET /dms` lists them.
--
-- An agent takes direct messages only when its owner says so: `agents.accepts_dms`, off for
-- every agent today and every agent enrolled from here.
--
-- No foreign keys on the two ids, on purpose: an import writes channels before members, and a
-- space's deletion removes channels before members anyway. Member rows are never deleted while
-- their space exists (an erased person keeps a husk), and the routes that create a direct
-- message check both rows.
--
-- Additive (D10): a defaulted kind, two nullable ids, a defaulted switch. An older release runs
-- on it and sees a direct message as one more private channel, which only its two members can
-- read; it would not refuse changes to one, so do not run an older release once spaces hold
-- them. Locks as 0039: catalog-only columns, two checks and an index over `channels`, under
-- lock_timeout.
--
-- Backout: revert the code first. Then, if wanted, delete the direct messages
-- (`DELETE FROM channels WHERE kind='dm'` after their entries, memberships and cursors) and
-- `ALTER TABLE channels DROP COLUMN kind, DROP COLUMN dm_member_id, DROP COLUMN dm_agent_id;
-- ALTER TABLE agents DROP COLUMN accepts_dms;`.

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE channels
  ADD COLUMN kind text NOT NULL DEFAULT 'channel',
  ADD COLUMN dm_member_id uuid,
  ADD COLUMN dm_agent_id uuid,
  ADD CONSTRAINT channels_kind CHECK (kind IN ('channel', 'dm')),
  ADD CONSTRAINT channels_dm_shape CHECK (
    (kind = 'channel' AND dm_member_id IS NULL AND dm_agent_id IS NULL)
    OR (kind = 'dm' AND dm_member_id IS NOT NULL AND dm_agent_id IS NOT NULL
      AND dm_member_id <> dm_agent_id AND visibility = 'private' AND NOT auto_join)
  );

-- One direct message per person and agent in a space; creating it twice finds the first.
CREATE UNIQUE INDEX channels_one_dm ON channels (community_id, dm_member_id, dm_agent_id)
  WHERE kind = 'dm';

ALTER TABLE agents ADD COLUMN accepts_dms boolean NOT NULL DEFAULT false;

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
