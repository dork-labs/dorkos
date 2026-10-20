-- Direct messages with an agent (DOR-2955, specs/everything-is-a-space C6).
--
-- A direct message is a channel of its own kind: private, never joined on arrival, holding
-- exactly one person (`dm_member_id`) and one agent (`dm_agent_id`, the agent's member row since
-- 0042), each in the membership table that already gates reading and posting. So entries,
-- files, read cursors, live streams, reports, removals, erasure, takedowns and exports all work
-- on one unchanged. `GET /channels` leaves them out; `GET /dms` lists them. Nobody else can read
-- one in the space, but like every private channel it is in the space owner's full export and a
-- host's legal-takedown evidence export.
--
-- An agent takes direct messages only when its owner says so: `agents.accepts_dms`, off for
-- every agent today and every agent enrolled from here.
--
-- No foreign keys on the two ids, on purpose: an import writes channels before members, and a
-- space's deletion removes channels before members anyway. Member rows are never deleted while
-- their space exists (an erased person keeps a husk), and the routes that create a direct
-- message check both rows.
--
-- ONE-WAY (D10). An older release would see a direct message as one more private channel and
-- would not refuse the routes that reshape one (joining, adding members, invitations), so this
-- raises the compatibility floor (0041) to 46 and no release that knows less will start. Locks
-- as 0039: catalog-only columns, two checks and an index over `channels`, under lock_timeout.
--
-- Backout: the way back is the host's point-in-time restore from before this migration, never
-- an older image.

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

-- No older release may run on this: see the header.
UPDATE community_compatibility_floor SET min_migration = GREATEST(min_migration, 46);

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
