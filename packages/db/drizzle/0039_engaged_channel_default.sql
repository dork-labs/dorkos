-- Migration 0039 — `engaged` becomes the channel default (room-participation
-- spec §9.4). ENTIRELY HAND-WRITTEN: `db:generate` produced this file empty
-- (`--custom`) because no column changes. `scripts/assert-migrations-current.sh`
-- compares the SCHEMA FILES against the snapshot, so it cannot see any of this.
-- packages/db/src/__tests__/engaged-channel-default-migration.test.ts is the only
-- gate on it, the way 0038 is gated by its own test.
--
-- WHAT THIS DOES. A channel membership seeded `mention-only` becomes `engaged`:
-- the agent answers when it is addressed and for a bounded window afterwards,
-- instead of charging an `@` on every single message. `room-roster.ts` changes
-- the seed for NEW joins in the same release; this moves the ones that already
-- exist, because the seed is written explicitly at join time and nothing
-- re-derives it later.
--
-- WHY IT CAN ONLY RUN ONCE, AND ONLY NOW. `response_mode` stores no provenance,
-- so this cannot tell a seeded default from a `mention-only` somebody chose on
-- purpose. It is safe today for one reason and it is a calendar reason: the
-- members panel that first put the field in front of anybody shipped on
-- 2026-07-27, one day before this, so the population of deliberately-chosen
-- values is empty or near-empty. That window closes. A later release must NOT
-- write another migration like this one.
--
-- WHY IT SPEAKS. This widens behaviour nobody asked for, so every room it
-- touches gets one durable notice saying so, in the room's own voice. Absence is
-- never consent, and a person who notices an agent answering unprompted has to
-- be able to find out why. `addressing_changed` is that notice code, and it is
-- the one code `room-notices.ts` does not own — nothing at runtime writes it.
--
-- The rule that falls out of that: **a room that cannot be told is not
-- changed.** Statement 2 computes one set of rooms and statements 4 and 6 both
-- read it, so "was widened" and "was told" are the same set by construction.
-- That is why an archived channel — which refuses its own voice — keeps its old
-- values instead of being quietly widened.
--
-- THREE FORMATTING RULES, ALL INHERITED FROM 0038 AND ALL LOAD-BEARING.
--   * No chunk may be comments alone. The migrator splits this file on the
--     breakpoint marker and PREPARES each chunk; better-sqlite3 rejects a chunk
--     holding no statement with "The supplied SQL string contains no
--     statements", which makes runMigrations throw on every startup.
--   * No comment may spell that marker out, because the split is a plain string
--     search with no notion of comments.
--   * One statement per chunk, for the same reason: each chunk is prepared, and
--     `prepare` takes exactly one.
--
-- 1. ONE INSTANT AND ONE ID PREFIX FOR THE WHOLE MIGRATION.
--
-- Every entry this writes carries the same `created_at`, which is honest: they
-- are one event. Computing it once also stops three statements disagreeing about
-- what "now" was.
--
-- `ulid_prefix` is the 10-character Crockford base32 encoding of that instant,
-- built by the recursive term below (five bits per character, least significant
-- first, prepended). It is the timestamp half of a ULID. Every other entry id in
-- this table is a real ULID minted by `ulidx`, and an id shaped differently
-- would be a permanent puzzle for the next reader of `room_entries` — so these
-- are real ULIDs too, assembled here because SQL has no `ulid()`. The random
-- half is `hex(randomblob(8))`: 16 characters, every hex digit a member of the
-- Crockford alphabet, 64 bits of entropy across the handful of rows this writes.
--
-- BOTH COLUMNS COME OFF THE SAME INTEGER, and that is not tidiness. SQLite
-- guarantees every `'now'` inside ONE statement returns the same value, so the
-- two `julianday('now')` calls below agree exactly — but `strftime(…, 'now')`
-- formats the julian double directly while the prefix encodes it after a
-- truncating CAST, and the two disagreed by a millisecond roughly one run in
-- eight (measured). Rendering `created_at` from the same integer makes an
-- entry's id and its timestamp the same instant by construction.
CREATE TEMPORARY TABLE engaged_default_stamp AS
WITH RECURSIVE encode(place, rest, prefix) AS (
	SELECT 10, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), ''
	UNION ALL
	SELECT
		place - 1,
		rest / 32,
		substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', rest % 32 + 1, 1) || prefix
	FROM encode WHERE place > 0
)
SELECT
	strftime(
		'%Y-%m-%dT%H:%M:%fZ',
		CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) / 1000.0,
		'unixepoch'
	) AS created_at,
	prefix AS ulid_prefix
FROM encode WHERE place = 0;
--> statement-breakpoint
-- 2. THE PLAN — WHICH ROOMS GET A NOTICE, COMPUTED BEFORE ANYTHING MOVES.
--
-- It reads `response_mode = 'mention-only'`, which statement 6 destroys, so it
-- MUST run first. That ordering is the whole reason this is a plan rather than
-- three statements sharing one predicate.
--
-- THREE SCOPES, EACH NARROWER THAN THE SPEC'S LITERAL WORDING, EACH ON PURPOSE:
--
--   `kind = 'channel'` — a direct message seeds from the agent's manifest and is
--   not being changed. Its memberships are left exactly as they are.
--
--   `archived = 0` — an archived room refuses its own voice (`postNotice` throws
--   ROOM_ARCHIVED, and archiving promises a room stops gaining entries). So it
--   cannot be told, and statement 6 therefore does not change it either: a
--   widening nobody could be told about is the exact thing §9.4 forbids, and
--   "silently, in a room that is out of the sidebar" is the worst place to do
--   it. An archived channel keeps the values it had. If it is ever un-archived
--   its members read `mention-only` while a new channel reads `engaged`, and
--   that difference is explainable precisely because nothing ever claimed
--   otherwise — the members panel is one click away and shows the real value.
--
--   `authors.kind = 'agent'` — `response_mode` describes when an AGENT answers
--   unprompted. Humans and the system are never auto-triggered, so their stored
--   value is inert and rewriting it would be noise. It also keeps the notice
--   honest: "agents in this channel now stay in the conversation" must not be
--   written into a room where the only row that changed belonged to a person.
CREATE TEMPORARY TABLE engaged_default_plan AS
SELECT
	r.id AS room_id,
	(SELECT COALESCE(MAX(e.seq), 0) FROM room_entries e WHERE e.room_id = r.id) + 1 AS seq,
	(SELECT ulid_prefix FROM engaged_default_stamp) || hex(randomblob(8)) AS entry_id
FROM rooms r
WHERE r.kind = 'channel'
  AND r.archived = 0
  AND EXISTS (
	SELECT 1
	FROM room_members m
	JOIN authors a ON a.id = m.author_id AND a.kind = 'agent'
	WHERE m.room_id = r.id AND m.response_mode = 'mention-only'
  );
--> statement-breakpoint
-- 3. THE SYSTEM AUTHOR, IF THIS INSTALL HAS NEVER HAD ONE.
--
-- A notice is written BY the room, which is the `('system', 'system')` author
-- `AuthorRegistry.system()` mints on first use. An install whose rooms have
-- never produced a notice has no such row yet, and a notice with a dangling
-- `author_id` renders as "Unknown" forever.
--
-- Same shape the registry writes, so the row it resolves after this is this one:
-- display name 'DorkOS', no emoji, no colour. The `NOT EXISTS` makes it a no-op
-- on every install that already has one, and the `EXISTS` on the plan keeps an
-- install with nothing to migrate from gaining an author row it never needed.
INSERT INTO authors (id, kind, natural_key, display_name, emoji, color, created_at)
SELECT
	(SELECT ulid_prefix FROM engaged_default_stamp) || hex(randomblob(8)),
	'system',
	'system',
	'DorkOS',
	NULL,
	NULL,
	(SELECT created_at FROM engaged_default_stamp)
WHERE EXISTS (SELECT 1 FROM engaged_default_plan)
  AND NOT EXISTS (
	SELECT 1 FROM authors WHERE kind = 'system' AND natural_key = 'system'
  );
--> statement-breakpoint
-- 4. ONE NOTICE PER AFFECTED ROOM.
--
-- The copy is the room explaining itself to somebody who did not configure it,
-- so it names no enum value and points at the one screen where the setting can
-- be changed. It is written here rather than in `room-notices.ts` because
-- nothing at runtime ever writes this code; the test pins the exact string, so
-- the copy still has exactly one home.
--
-- `cascade_root` is the entry's own id at depth 0, which is what `postNotice`
-- writes for a notice with no cascade behind it — this one answers no exchange.
-- Both thread pointers are NULL: it belongs at the top level of the channel,
-- where everyone reads.
INSERT INTO room_entries (
	room_id, seq, id, author_id, kind, body, mentions, session_id,
	cascade_root, cascade_depth, parent_entry_id, thread_root_entry_id,
	signature, created_at
)
SELECT
	p.room_id,
	p.seq,
	p.entry_id,
	(SELECT id FROM authors WHERE kind = 'system' AND natural_key = 'system'),
	'notice',
	'{"text":"Agents in this channel now stay in the conversation for a few minutes after you talk to them, instead of needing an @mention every time. You can change this per agent in Members.","notice":"addressing_changed"}',
	'[]',
	NULL,
	p.entry_id,
	0,
	NULL,
	NULL,
	NULL,
	(SELECT created_at FROM engaged_default_stamp)
FROM engaged_default_plan p;
--> statement-breakpoint
-- 5. THE ROOMS THAT JUST GAINED AN ENTRY ARE NOT QUIET.
--
-- `appendEntry` bumps `last_activity_at` inside the same transaction as every
-- write, because a room listed as quiet while holding an entry nobody has seen
-- is the one state the column exists to prevent. A migration that writes entries
-- owes the same invariant. The visible cost is that the sidebar reorders once on
-- upgrade, which is the truth: something did just happen in each of these rooms.
UPDATE rooms
SET last_activity_at = (SELECT created_at FROM engaged_default_stamp)
WHERE id IN (SELECT room_id FROM engaged_default_plan);
--> statement-breakpoint
-- 6. AND NOW THE VALUES THEMSELVES.
--
-- **Scoped to the plan, not re-derived**, and that is the whole shape of the
-- guarantee: the rooms this widens ARE the rooms statement 4 wrote a notice
-- into, by construction rather than by two predicates that happen to agree
-- today. Nothing can widen in silence, because the same temp table decides both.
-- Rewriting this clause as its own `SELECT id FROM rooms WHERE …` re-opens
-- exactly that gap; do not.
--
-- `response_mode = 'mention-only'` is the only value touched: a membership
-- somebody set to `always`, `direct-only` or `silent` is a choice, and the whole
-- reason this migration is narrow is that it cannot recognise one. Idempotent by
-- construction — a second run matches nothing.
UPDATE room_members
SET response_mode = 'engaged'
WHERE response_mode = 'mention-only'
  AND room_id IN (SELECT room_id FROM engaged_default_plan)
  AND author_id IN (SELECT id FROM authors WHERE kind = 'agent');
--> statement-breakpoint
DROP TABLE engaged_default_plan;
--> statement-breakpoint
DROP TABLE engaged_default_stamp;
