ALTER TABLE `room_members` ADD `joined_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `ambient_max_entries` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
-- BACKFILL `joined_seq`, HAND-WRITTEN AND IN THE SAME MIGRATION AS THE COLUMN
-- (room-participation spec §8.3). `db:generate` writes the two ALTERs above and
-- nothing else; `scripts/assert-migrations-current.sh` compares the SCHEMA FILES
-- against the snapshot, so it cannot see this statement at all.
-- packages/db/src/__tests__/ambient-pending-migration.test.ts is the only gate on
-- it, the way 0038 and 0039 are gated by their own tests.
--
-- WHY IT HAS TO BE HERE. The column's default is 0, and 0 means "joined before
-- the first message ever sent in this room". Left at the default, every
-- membership that already exists would claim to have been present for the whole
-- log, and the first ambient turn after this ships would replay a channel's
-- entire history to an agent that joined it yesterday. A backfill in a later
-- migration would leave that window open in between.
--
-- WHAT IT COMPUTES. The highest `seq` this room held STRICTLY BEFORE the
-- membership was written — which is the last thing said while this member was
-- not yet in the room, and therefore the exclusive floor under everything they
-- may be shown. An entry stamped at the join instant itself is on the inclusive
-- side: a member is in the room from the moment they join it. `COALESCE(…, 0)`
-- covers the two cases with nothing behind them — a room that was empty at join,
-- and a roster seeded by `createRoom` in the same breath as the room itself.
--
-- WHY IT IS IDEMPOTENT, STRUCTURALLY AND NOT BY ARGUMENT. `WHERE joined_seq = 0`
-- is exactly the population that has never been given a real value: every row
-- that predates this migration, and no row written after it except one that
-- genuinely joined an empty room (which recomputes to 0 anyway). A second run
-- cannot walk a live membership's floor backwards.
UPDATE room_members
SET joined_seq = COALESCE(
	(
		SELECT MAX(e.seq)
		FROM room_entries e
		WHERE e.room_id = room_members.room_id
		  AND e.created_at < room_members.joined_at
	),
	0
)
WHERE joined_seq = 0;
