CREATE TABLE `messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`origin_key` text NOT NULL,
	`ordinal` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` text,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_source_id_origin_key_ordinal_unique` ON `messages` (`source_id`,`origin_key`,`ordinal`);--> statement-breakpoint
CREATE TABLE `search_sources` (
	`source_id` text NOT NULL,
	`origin_key` text NOT NULL,
	`byte_offset` integer,
	`size_bytes` integer,
	`mtime_ms` integer,
	`last_ordinal` integer,
	`container_path` text,
	`last_indexed_at` text NOT NULL,
	`last_error` text,
	PRIMARY KEY(`source_id`, `origin_key`)
);
--> statement-breakpoint
-- EVERYTHING BELOW THIS LINE IS HAND-WRITTEN AND `db:generate` WILL NEVER
-- REPRODUCE IT. drizzle-orm@0.45.2/sqlite-core exports no virtual-table
-- builder, so an FTS5 index cannot be declared in packages/db/src/schema/ and
-- cannot be generated from it. The precedent for a hand-authored migration in
-- this folder is 0011_tasks_system_redesign.sql; 0012 and 0013 only LOOK
-- hand-named and are byte-identical to generated output.
--
-- Consequence to know before editing: `scripts/assert-migrations-current.sh`
-- compares the schema files against the snapshot, so it does not see this half
-- at all. Nothing but packages/db/src/__tests__/message-search-migration.test.ts
-- guards it.
--
-- `body` MUST keep this name. With content='messages' FTS5 re-reads the
-- original text out of the content table BY COLUMN NAME. Under a mismatched
-- name MATCH and bm25() go on working and only snippet()/highlight() fail, at
-- runtime, with `SQL logic error` — so a MATCH-only test passes straight
-- through the bug.
--
-- `porter` on top of `unicode61` is what makes the product promise true: it
-- stems, so searching `dogs` finds `dog`, `dogs` and `DOGGED`. Bare unicode61
-- finds only the literal `dogs`.
CREATE VIRTUAL TABLE messages_fts USING fts5(
	body,
	content='messages',
	content_rowid='id',
	tokenize='porter unicode61'
);
--> statement-breakpoint
-- The three triggers that keep the index honest. An external-content FTS5 table
-- stores no copy of the text, so it cannot notice a change on its own — these
-- are the entire synchronisation mechanism.
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
--> statement-breakpoint
-- Deleting from an external-content table is a COMMAND, not a DELETE statement,
-- and it must be handed the OLD body: FTS5 re-derives the terms to retract from
-- the text it is given, and by the time an AFTER DELETE trigger runs the row is
-- already gone from `messages`, so it cannot look them up itself. Omit this
-- trigger and the index keeps returning a row for text that no longer exists
-- anywhere. (There is no `new` to get wrong here — an AFTER DELETE trigger has
-- no `new` row, and SQLite refuses one that references it.)
--
-- THIS TRIGGER DOES NOT FIRE FOR A ROW `INSERT OR REPLACE` REMOVES unless
-- `recursive_triggers` is on, which is OFF by SQLite's default. `createDb`
-- turns it on for exactly this reason, and packages/db/src/index.ts carries the
-- measurement. Anything writing `messages` on a connection opened elsewhere
-- must use `ON CONFLICT ... DO UPDATE` or `INSERT OR IGNORE` — both measured
-- clean with the pragma off — never bare `REPLACE`.
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
--> statement-breakpoint
-- An update is a retract-then-insert. Order matters: retract with the old text
-- first, then index the new one.
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
	INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
