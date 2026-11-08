.bail on
-- Down-migration for drizzle/20261107183323_dor3933_todos_rename.sql (To-dos step 1, DOR-3933).
--
-- Puts the table back under its old name, `commitments`, exactly as the DOR-3088 rebuild left it:
-- the same columns, rows, CHECKs, indexes and two "refuse legacy" triggers, under their old
-- `commitments_*` names. It also removes the migration's ledger row, so the next boot of a build
-- that has it would apply it again. Nothing is lost either way: the rename moves no data.
--
-- It refuses, changing nothing, when a later migration has run. Drizzle only applies migrations
-- newer than the newest it has recorded, so this one would never be applied again, and the later
-- ones may rely on it.
--
-- Run it by hand, with DorkOS stopped, against a copy first:
--   sqlite3 ~/.dork/dork.db < packages/db/src/down/20261107183323_dor3933_todos_rename.down.sql
-- The `.bail on` above makes the sqlite3 shell stop at the first error, so the open transaction
-- is thrown away rather than committed half done. Any other runner must stop at the first error
-- too. The test that proves it: packages/db/src/__tests__/todos-migration.test.ts.
BEGIN IMMEDIATE;
-- Refuse before anything changes (see above).
CREATE TEMP TABLE `__dor3933_down_guard` (`refusals` integer NOT NULL CHECK (`refusals` = 0));
INSERT INTO `__dor3933_down_guard` SELECT count(*) FROM `__drizzle_migrations` WHERE `created_at` > 1794076403745;
DROP TABLE `__dor3933_down_guard`;
CREATE TABLE `__old_commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`owner_account` text,
	`to_account` text,
	`what` text NOT NULL,
	`due_at` text,
	`state` text NOT NULL,
	`source_session_id` text,
	`source_room_entry_id` text,
	`created_at` text NOT NULL,
	`due_notified_at` text,
	`closed_at` text,
	`note` text,
	`origin_marks` text,
	`assigned_by_kind` text NOT NULL,
	`assigned_by` text NOT NULL,
	`authority` text NOT NULL,
	`authority_marks` text NOT NULL,
	`chain_depth` integer NOT NULL,
	`chain_agents` text NOT NULL,
	`title_from_source` integer NOT NULL,
	`source_author` text,
	`room_id` text,
	`notes` text,
	`rank` text,
	CONSTRAINT "commitments_state" CHECK("__old_commitments"."state" IN ('open', 'kept', 'missed', 'dropped')),
	CONSTRAINT "commitments_what_length" CHECK(length("__old_commitments"."what") <= 300),
	CONSTRAINT "commitments_owner" CHECK(("__old_commitments"."agent_id" IS NULL) <> ("__old_commitments"."owner_account" IS NULL)),
	CONSTRAINT "commitments_assigned_by_kind" CHECK("__old_commitments"."assigned_by_kind" IN ('agent', 'person', 'outsider')),
	CONSTRAINT "commitments_authority" CHECK("__old_commitments"."authority" IN ('legacy', 'self', 'person', 'runtime-default') OR (json_valid("__old_commitments"."authority") AND json_type("__old_commitments"."authority") = 'object')),
	CONSTRAINT "commitments_legacy_is_own" CHECK("__old_commitments"."authority" <> 'legacy' OR ("__old_commitments"."agent_id" IS NOT NULL AND "__old_commitments"."assigned_by_kind" = 'agent' AND "__old_commitments"."assigned_by" = "__old_commitments"."agent_id")),
	CONSTRAINT "commitments_authority_marks" CHECK(json_valid("__old_commitments"."authority_marks") AND json_type("__old_commitments"."authority_marks") = 'object'),
	CONSTRAINT "commitments_title_from_source" CHECK("__old_commitments"."title_from_source" IN (0, 1)),
	CONSTRAINT "commitments_chain_depth" CHECK("__old_commitments"."chain_depth" >= 0),
	CONSTRAINT "commitments_chain_agents" CHECK(json_valid("__old_commitments"."chain_agents") AND json_type("__old_commitments"."chain_agents") = 'array'),
	CONSTRAINT "commitments_notes_length" CHECK("__old_commitments"."notes" IS NULL OR length("__old_commitments"."notes") <= 2000),
	CONSTRAINT "commitments_rank_length" CHECK("__old_commitments"."rank" IS NULL OR length("__old_commitments"."rank") <= 64)
);
INSERT INTO `__old_commitments` SELECT "id", "agent_id", "owner_account", "to_account", "what", "due_at", "state", "source_session_id", "source_room_entry_id", "created_at", "due_notified_at", "closed_at", "note", "origin_marks", "assigned_by_kind", "assigned_by", "authority", "authority_marks", "chain_depth", "chain_agents", "title_from_source", "source_author", "room_id", "notes", "rank" FROM `todos`;
DROP TABLE `todos`;
ALTER TABLE `__old_commitments` RENAME TO `commitments`;
CREATE INDEX `commitments_agent_state_idx` ON `commitments` (`agent_id`,`state`);
CREATE INDEX `commitments_due_idx` ON `commitments` (`due_at`);
CREATE INDEX `commitments_owner_state_idx` ON `commitments` (`owner_account`,`state`);
CREATE INDEX `commitments_assigned_by_idx` ON `commitments` (`assigned_by`,`state`);
CREATE TRIGGER `commitments_no_new_legacy` BEFORE INSERT ON `commitments` WHEN NEW."authority" = 'legacy' BEGIN SELECT RAISE(ABORT, 'commitments: legacy authority is only for rows from before to-dos'); END;
CREATE TRIGGER `commitments_no_legacy_update` BEFORE UPDATE OF "authority" ON `commitments` WHEN NEW."authority" = 'legacy' AND OLD."authority" <> 'legacy' BEGIN SELECT RAISE(ABORT, 'commitments: legacy authority is only for rows from before to-dos'); END;
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1794076403745;
COMMIT;
