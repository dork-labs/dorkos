-- ONE DM PER MEMBER SET, ENFORCED BY THE DATABASE (DOR-1616).
--
-- `db:generate` wrote the first and third statements — the column and its
-- partial unique index. The `UPDATE` between them is HAND-WRITTEN and is the
-- whole reason this file was edited after generation: without it, every DM on
-- every existing install would carry a NULL key, the index would guard nothing,
-- and the first time somebody re-opened a conversation they already had they
-- would get a second one beside it.
--
-- `scripts/assert-migrations-current.sh` cannot see the middle statement — it
-- compares the SCHEMA FILES against the snapshot, and the schema says nothing
-- about rows. packages/db/src/__tests__/dm-member-key-migration.test.ts is the
-- only gate on it, the way 0061's and 0057's backfills are gated by theirs.
--
-- WHY THE ORDER IS COLUMN, BACKFILL, INDEX. The index is created LAST on
-- purpose. Created before the backfill it would be satisfied trivially (every
-- key NULL) and then have to be satisfied again by the `UPDATE`, which is the
-- same work in a worse order; created after, the `UPDATE` is what it is checked
-- against, so an install this statement failed to de-duplicate could not take
-- the index at all. It does not fail, and the next paragraph is why.
--
-- WHY IT CANNOT FAIL ON AN INSTALL THAT ALREADY HAS DUPLICATES. Duplicate DMs
-- are reachable today (DOR-793 point 1, and this issue's own race), so an
-- unconditional backfill would write the same key onto two rows and the
-- `CREATE UNIQUE INDEX` below would abort — bricking the upgrade for exactly
-- the people the fix is for. So the `UPDATE` keys ONE room per member set: the
-- room `RoomStore.findDmByMemberSet` would have returned, chosen by that
-- query's own tie-break — a live room before an archived one, oldest first.
-- Every other member of a duplicate group keeps its key NULL. Nothing is
-- deleted, merged, or hidden: those rooms keep their whole history and their
-- place in the sidebar, and are simply not the room a fresh open resolves to,
-- which is the behaviour `findDmByMemberSet`'s ordering already gave them.
--
-- WHO IS SKIPPED, AND WHY EACH IS RIGHT.
--   * Channels — they have no member-set identity.
--   * BRIDGED DMs (`room_bridges`) — a bridged private chat's roster is
--     byte-identical to the operator's own DM with that agent, so a bridged
--     chat inside this dedupe would let a fresh open reuse, and un-archive, a
--     stranger's chat log (ADR 260804-093318, chats-as-channels §3.2 A3.2c).
--     `findDmByMemberSet` already excludes them, so this preserves behaviour
--     rather than changing it.
--   * A DM with an EMPTY roster — `group_concat` over no rows is NULL, so it
--     stays NULL. `findDmByMemberSet([])` already answers `null`.
--
-- WHY `group_concat(... ORDER BY ...)` AND NOT A BARE `group_concat`. The order
-- rows are visited is not part of `group_concat`'s contract, and this key has to
-- match `canonicalDmMemberKey` in `src/schema/rooms.ts` byte for byte or the
-- backfill is worse than useless. The explicit `ORDER BY` inside the aggregate
-- needs SQLite 3.44 (2023); better-sqlite3 links 3.53 here, and a migration
-- always runs against the binary shipped with the code that carries it.
ALTER TABLE `rooms` ADD `dm_member_key` text;--> statement-breakpoint
UPDATE rooms SET dm_member_key = (
  SELECT group_concat(m.author_id, ',' ORDER BY m.author_id)
  FROM room_members m
  WHERE m.room_id = rooms.id
)
WHERE rooms.kind = 'dm'
  AND rooms.id NOT IN (SELECT room_id FROM room_bridges)
  AND rooms.id = (
    SELECT winner.id
    FROM rooms winner
    WHERE winner.kind = 'dm'
      AND winner.id NOT IN (SELECT room_id FROM room_bridges)
      AND (
        SELECT group_concat(wm.author_id, ',' ORDER BY wm.author_id)
        FROM room_members wm
        WHERE wm.room_id = winner.id
      ) = (
        SELECT group_concat(sm.author_id, ',' ORDER BY sm.author_id)
        FROM room_members sm
        WHERE sm.room_id = rooms.id
      )
    ORDER BY winner.archived, winner.created_at
    LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_dm_member_key_unique` ON `rooms` (`dm_member_key`) WHERE "kind" = 'dm' AND "dm_member_key" IS NOT NULL;
