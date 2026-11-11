-- EVERYTHING ABOVE THE `DROP INDEX` AT THE BOTTOM IS HAND-WRITTEN AND
-- `db:generate` WILL NEVER REPRODUCE IT. The generator writes the three DDL
-- statements at the end and nothing else; it has no idea there is data standing
-- on the columns it is dropping. The precedent for hand-authored content in a
-- generated file is 0037_message_search.sql, and the same consequence applies:
-- `scripts/assert-migrations-current.sh` compares the SCHEMA FILES against the
-- snapshot, so it does not see this half at all. Nothing but
-- packages/db/src/__tests__/thread-retirement-migration.test.ts guards it.
--
-- WHAT THIS DOES. A thread stops being a child room and becomes a relation
-- between entries in one room's log (ADR 260728-022013). PR 1 added
-- `room_entries.parent_entry_id` / `thread_root_entry_id`; PR 2 taught the
-- client to render them. This retires the old shape: every entry still sitting
-- in a `kind='thread'` room moves into that room's parent, and `parent_id`,
-- `root_entry_id` and `idx_rooms_parent_id` go.
--
-- WHY THE ORDER IS WHAT IT IS. Every data statement reads `rooms.parent_id` or
-- `rooms.kind='thread'`, so all of them must run before the DDL that removes
-- them. Within the data half the order is also load-bearing and is called out
-- statement by statement below. The two rules that shape it:
--
--   APPEND, NEVER INTERLEAVE. Moved entries take fresh seqs above the parent's
--   current maximum. Slotting them into the parent's timeline by timestamp
--   would renumber existing entries, and `seq` is not an ordering detail — it
--   is the value stored in every `room_members.last_read_seq` and handed out as
--   the SSE resume cursor (`Last-Event-ID`). Renumbering silently redirects
--   every one of them at a different message.
--
--   NEVER RAISE A CURSOR PAST SOMETHING THE MEMBER HAD NOT READ. Appending puts
--   every moved entry above every existing cursor, so without help each member
--   would open the app to a badge for messages that are not new. The cursor is
--   advanced for exactly the members who had nothing unread anywhere in the
--   conversation — parent and threads alike — and left untouched for everyone
--   else. Raising one past an entry the member genuinely had not seen destroys a
--   "you missed this" signal that cannot be recovered; a badge that is one
--   upgrade too large clears itself the next time the room is opened.
--
--   The one cursor this MOVES DOWN is a cursor that was already above the room's
--   own maximum, which nothing legitimate produces — `setReadCursor` is
--   monotonic but does not clamp, so a client could store one. It is set to the
--   new maximum like any other caught-up member, which is a repair rather than a
--   loss: it pointed at no entry before and points at the newest one after.
--
-- WHAT IS DELIBERATELY NOT TOUCHED. `cascade_root` / `cascade_depth` on a moved
-- entry are left exactly as they are: they name entry ids, and every id a moved
-- entry can point at either moved with it or already lived in the parent, so
-- the `(room_id, cascade_root)` lookup keeps resolving. Renumbering seqs does
-- not reach them.
--
-- TWO FORMATTING RULES, BOTH LOAD-BEARING, BOTH LEARNED BY BREAKING THEM.
--
--   NO CHUNK MAY BE COMMENTS ALONE. drizzle's migrator splits the file on the
--   breakpoint marker and PREPARES each chunk, and better-sqlite3 rejects a
--   string holding no statement with "The supplied SQL string contains no
--   statements" — so a free-standing comment block does not merely look
--   untidy, it makes runMigrations throw on every startup and every test in
--   this package. That is why this header sits attached to the statement below
--   it rather than on its own.
--
--   NO COMMENT MAY SPELL THE BREAKPOINT MARKER OUT. The split is a plain string
--   search with no notion of comments, so a comment quoting the marker cuts
--   itself in half and leaves both halves as syntax errors.
--
-- The test pins both.
--
-- 1. THE PLAN, COMPUTED ONCE BEFORE ANYTHING MOVES.
--
-- A temp table rather than correlated subqueries on `room_entries`, because the
-- alternative is an `UPDATE room_entries SET seq = (SELECT MAX(seq) FROM
-- room_entries ...)`, which reads the table it is halfway through rewriting and
-- gives an answer that depends on visitation order. Computing the whole
-- assignment first makes the migration a plan plus its application, and the
-- plan is inspectable.
--
-- `JOIN rooms p ON p.id = t.parent_id AND p.kind <> 'thread'` is what makes a
-- thread room ELIGIBLE: its parent must exist and must not itself be retiring.
-- Neither failure is reachable through the API — nothing ever deleted a room,
-- and one-level nesting was refused at the service boundary — so a row that
-- misses this join got there by hand. Statement 4 catches those rather than
-- letting them fall through the cracks.
--
-- `attach_to` is what stops the migration dumping old replies into the channel
-- as brand new top-level messages. Under the child-room shape a thread's
-- replies were top-level entries in their own room and the message they
-- answered lived in the parent, named by `rooms.root_entry_id`. Moved into the
-- parent they must point back at it, or the reader gets N messages with no
-- visible connection to anything. It is NULL when that root has gone missing,
-- or when it is itself a reply — attaching to a reply would mint the nested
-- thread the service refuses.
CREATE TEMPORARY TABLE thread_retirement_plan AS
SELECT
	t.id AS thread_room_id,
	t.parent_id AS parent_room_id,
	e.id AS entry_id,
	e.seq AS old_seq,
	CASE
		WHEN EXISTS (
			SELECT 1 FROM room_entries re
			WHERE re.room_id = t.parent_id
			  AND re.id = t.root_entry_id
			  AND re.thread_root_entry_id IS NULL
		) THEN t.root_entry_id
		ELSE NULL
	END AS attach_to,
	(SELECT COALESCE(MAX(pe.seq), 0) FROM room_entries pe WHERE pe.room_id = t.parent_id)
		+ ROW_NUMBER() OVER (
			PARTITION BY t.parent_id
			ORDER BY e.created_at, e.room_id, e.seq
		) AS new_seq
FROM rooms t
JOIN rooms p ON p.id = t.parent_id AND p.kind <> 'thread'
JOIN room_entries e ON e.room_id = t.id
WHERE t.kind = 'thread';
--> statement-breakpoint
-- 2. READ CURSORS — BEFORE THE MOVE, WHILE `MAX(seq)` IS STILL THE OLD MAXIMUM
--    AND THE THREAD ROOMS STILL CARRY THEIR OWN CURSORS.
--
-- Both facts this needs are destroyed by the statements after it, which is the
-- entire reason it runs here.
--
-- The new value is `oldMax + movedCount`, which is the new maximum by
-- construction: statement 1 numbered the moved entries `oldMax + 1 ..
-- oldMax + movedCount`.
--
-- The three conditions read as one sentence — "this member had no unread badge
-- anywhere in this conversation, so it must not gain one":
--   EXISTS       — this room is actually receiving entries; every other room in
--                  the install is left alone, which is what makes this inert on
--                  the overwhelmingly common install that has no threads.
--   >= MAX(seq)  — the member had read the parent room to its end.
--   NOT EXISTS   — and no entry arriving from a thread was above that member's
--                  cursor IN THAT THREAD. The COALESCE fallback treats "never a
--                  member of that thread" as "had no badge for it", because
--                  inventing one now is the phantom badge this guards against.
--
-- A member who fails any of them keeps their cursor exactly where it is. Their
-- badge grows by the replies that moved, which is honest under the one-cursor
-- model ("entries in this room you have not seen") and clears the next time
-- they open the room.
UPDATE room_members
SET last_read_seq =
	(SELECT COALESCE(MAX(e.seq), 0) FROM room_entries e WHERE e.room_id = room_members.room_id)
	+ (SELECT COUNT(*) FROM thread_retirement_plan pl WHERE pl.parent_room_id = room_members.room_id)
WHERE EXISTS (
		SELECT 1 FROM thread_retirement_plan pl WHERE pl.parent_room_id = room_members.room_id
	)
	AND last_read_seq >=
		(SELECT COALESCE(MAX(e.seq), 0) FROM room_entries e WHERE e.room_id = room_members.room_id)
	AND NOT EXISTS (
		SELECT 1 FROM thread_retirement_plan pl
		WHERE pl.parent_room_id = room_members.room_id
		  AND pl.old_seq > COALESCE(
				(SELECT tm.last_read_seq FROM room_members tm
				 WHERE tm.room_id = pl.thread_room_id AND tm.author_id = room_members.author_id),
				pl.old_seq
			)
	);
--> statement-breakpoint
-- 3. MOVE THE ENTRIES.
--
-- Every moved row takes the parent's `room_id`, its appended `seq`, and a
-- thread pointer back at the message it was always answering. Both pointers get
-- the same value, which keeps the invariant PR 1 pinned by test —
-- `(parent_entry_id IS NULL) = (thread_root_entry_id IS NULL)` — true of every
-- row this writes.
--
-- No uniqueness to fear on the way through: the new seqs all sit above the
-- parent's old maximum and are distinct within a parent, so no `(room_id, seq)`
-- pair collides with an existing row or with another moved one, and entry ids
-- are ULIDs so `(room_id, id)` cannot collide either.
UPDATE room_entries
SET
	room_id = (
		SELECT pl.parent_room_id FROM thread_retirement_plan pl
		WHERE pl.thread_room_id = room_entries.room_id AND pl.entry_id = room_entries.id
	),
	seq = (
		SELECT pl.new_seq FROM thread_retirement_plan pl
		WHERE pl.thread_room_id = room_entries.room_id AND pl.entry_id = room_entries.id
	),
	parent_entry_id = (
		SELECT pl.attach_to FROM thread_retirement_plan pl
		WHERE pl.thread_room_id = room_entries.room_id AND pl.entry_id = room_entries.id
	),
	thread_root_entry_id = (
		SELECT pl.attach_to FROM thread_retirement_plan pl
		WHERE pl.thread_room_id = room_entries.room_id AND pl.entry_id = room_entries.id
	)
WHERE EXISTS (
	SELECT 1 FROM thread_retirement_plan pl
	WHERE pl.thread_room_id = room_entries.room_id AND pl.entry_id = room_entries.id
);
--> statement-breakpoint
-- 4. A THREAD ROOM WITH NOWHERE TO GO BECOMES AN ARCHIVED CHANNEL.
--
-- The complement of statement 1's eligibility join: no parent, a parent that is
-- not there, or a parent that is itself a thread. Unreachable through the API,
-- so this is insurance rather than a case — but the two obvious alternatives
-- are both worse. Deleting the room throws away messages a person wrote to
-- rescue a column; leaving `kind='thread'` behind leaves a value the type
-- system no longer has a name for, in a row nothing can render. Archiving keeps
-- every word, keeps the row legible, and keeps it out of the sidebar, and a
-- person can un-archive it if it turns out to matter.
UPDATE rooms
SET kind = 'channel', archived = 1
WHERE kind = 'thread'
  AND NOT EXISTS (
	SELECT 1 FROM rooms p WHERE p.id = rooms.parent_id AND p.kind <> 'thread'
  );
--> statement-breakpoint
-- 5/6. DROP THE MESSAGE-SEARCH INDEX'S VIEW OF EVERY ROOM ABOUT TO DISAPPEAR.
--
-- The index (migration 0037) keys a room's messages on `(source_id='rooms',
-- origin_key=roomId, ordinal=seq)` and remembers how far it has read in
-- `search_sources.last_ordinal`. Statement 3 moved rows out from under both
-- halves, so the indexed copies name a room id that is about to stop existing.
--
-- THE ORDERING CONSTRAINT IS NOT BETWEEN THESE TWO. They touch different tables,
-- neither reads the other's, and there is no foreign key or trigger between
-- them — swapping them is byte-identical, and an earlier draft of this comment
-- claimed otherwise. What is load-bearing is that BOTH must precede statement 9:
-- each subqueries `rooms` for `kind = 'thread'`, which statement 9 empties.
--
-- WHAT THESE ARE AND ARE NOT. They are an optimisation, not a repair. DOR-680's
-- reconciler prunes a vanished container by walking `search_sources` rows, so
-- left alone it would notice both retired rooms on its own and clean up
-- completely. Measured in review, three ways: both statements leave the index
-- clean, neither statement ALSO leaves it clean, and deleting only the
-- `search_sources` row leaves a permanent orphan plus a duplicate FTS hit.
--
-- That middle result is the reason these two ship together or not at all: the
-- frontier row is the handle prune finds the container BY, so removing it alone
-- strands the `messages` rows it was the only route to. The half-fix is strictly
-- worse than doing nothing, and doing nothing was the other honest option.
-- Doing both is chosen because a migration that leaves the index consistent at
-- the moment it commits does not depend on when a reconciler next runs.
--
-- Scoped to the retiring rooms rather than to `source_id = 'rooms'` wholesale,
-- which is what statement 4's placement buys: the rooms that are NOT
-- disappearing have already left `kind = 'thread'`, so every other room keeps
-- its watermark, and a parent that received appended entries picks them up on
-- the next sweep because they landed above it.
--
-- The `messages` delete is a plain statement so the `messages_fts_ad` trigger
-- fires and retracts the text from FTS5 — an external-content index keeps no
-- copy of its own and cannot notice otherwise. Both are no-ops when nothing has
-- been indexed yet, which is the state of every install that has not swept.
DELETE FROM messages
WHERE source_id = 'rooms'
  AND origin_key IN (SELECT id FROM rooms WHERE kind = 'thread');
--> statement-breakpoint
DELETE FROM search_sources
WHERE source_id = 'rooms'
  AND origin_key IN (SELECT id FROM rooms WHERE kind = 'thread');
--> statement-breakpoint
-- 7. THE PER-(room, agent) SESSION BINDINGS OF THE RETIRING ROOMS.
--
-- The binding is dropped; THE SESSION IS NOT. `room_sessions` holds a pointer
-- into runtime-owned storage (ADR-0310) — DorkOS did not create that session
-- and must not delete it, so it stays exactly where it is and keeps showing up
-- in the session list under its own runtime.
--
-- The row itself cannot survive: it is keyed `(room_id, author_id)` on a room
-- that is about to stop existing, so nothing could ever resolve it again.
-- Promoting it onto the parent instead was considered and refused twice over —
-- the parent usually already has its own binding for that agent and one row per
-- pair is the invariant, and where it does not, grafting a thread's context
-- onto the channel is precisely the swap ADR 260728-022013 removed: an agent
-- answering in a thread answers in the room's session, with the room's context.
DELETE FROM room_sessions
WHERE room_id IN (SELECT id FROM rooms WHERE kind = 'thread');
--> statement-breakpoint
-- 8. THE ROSTERS OF THE RETIRING ROOMS. Every one of these was a copy of the
-- parent's, minted by the old `createThread`, and the parent's row is the one
-- that survives. Statement 2 has already taken everything it needed from the
-- `last_read_seq` values here.
--
-- One case this DOES drop outright, named for the same reason statement 4 names
-- its own: a member of the thread who is no longer a member of the parent loses
-- their membership entirely rather than being re-added upstairs. It is not
-- reachable through the API — `createThread` copied the parent's roster and no
-- route ever edited a thread's separately — and re-adding is the wrong repair
-- anyway, since somebody removing a person from a channel did not ask for them
-- to be put back. They lose a room they could not open; the log they wrote
-- survives in the channel.
DELETE FROM room_members
WHERE room_id IN (SELECT id FROM rooms WHERE kind = 'thread');
--> statement-breakpoint
-- 9. THE ROOMS. Empty by now — statement 3 moved every entry that could move
-- and statement 4 reclassified every room that could not.
DELETE FROM rooms WHERE kind = 'thread';
--> statement-breakpoint
DROP TABLE thread_retirement_plan;
--> statement-breakpoint
-- 10. AND ONLY NOW THE COLUMNS. Everything below is generator output, unedited.
--
-- The `DROP INDEX` is the first one this repo has ever emitted, and it is not
-- decoration: SQLite refuses `DROP COLUMN` on an indexed column, so without it
-- the next statement fails with "error in index idx_rooms_parent_id after drop
-- column". drizzle-kit 0.31.10 ordered these correctly on its own; it was
-- checked by hand rather than assumed, and the test pins the ordering so a
-- regenerated file that loses it cannot pass.
DROP INDEX `idx_rooms_parent_id`;--> statement-breakpoint
ALTER TABLE `rooms` DROP COLUMN `parent_id`;--> statement-breakpoint
ALTER TABLE `rooms` DROP COLUMN `root_entry_id`;
