.bail on
-- Down-migration for drizzle/20261102213849_dor3088_todos.sql (To-dos v1, DOR-3088).
--
-- Puts `commitments` back exactly as it was before to-dos: the same columns, CHECKs and indexes,
-- every row's old columns unchanged, and the migration's ledger row removed so the next boot of a
-- build that has it would apply it again.
--
-- It refuses, changing nothing, in two cases:
--   * A person owns a to-do. That row has no `agent_id`, and the old table cannot hold it. Never
--     delete those rows to make it pass; they are somebody's to-dos.
--   * A later migration has run. Drizzle only applies migrations newer than the newest it has
--     recorded, so this one would never be applied again, and the later ones may rely on it.
--
-- Run it by hand, with DorkOS stopped, against a copy first:
--   sqlite3 ~/.dork/dork.db < packages/db/src/down/20261102213849_dor3088_todos.down.sql
-- The `.bail on` above makes the sqlite3 shell stop at the first error, so the open transaction
-- is thrown away rather than committed half done. Any other runner must stop at the first error
-- too. The test that proves it: packages/db/src/__tests__/todos-migration.test.ts.
BEGIN IMMEDIATE;
-- Refuse before anything changes (see above).
CREATE TEMP TABLE `__dor3088_down_guard` (`refusals` integer NOT NULL CHECK (`refusals` = 0));
INSERT INTO `__dor3088_down_guard` SELECT count(*) FROM `commitments` WHERE `agent_id` IS NULL;
INSERT INTO `__dor3088_down_guard` SELECT count(*) FROM `__drizzle_migrations` WHERE `created_at` > 1793655529582;
DROP TABLE `__dor3088_down_guard`;
DROP TRIGGER `commitments_no_new_legacy`;
DROP TRIGGER `commitments_no_legacy_update`;
CREATE TABLE `__old_commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
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
	CONSTRAINT "commitments_state" CHECK("__old_commitments"."state" IN ('open', 'kept', 'missed', 'dropped')),
	CONSTRAINT "commitments_what_length" CHECK(length("__old_commitments"."what") <= 300)
);
INSERT INTO `__old_commitments`("id", "agent_id", "to_account", "what", "due_at", "state", "source_session_id", "source_room_entry_id", "created_at", "due_notified_at", "closed_at", "note", "origin_marks") SELECT "id", "agent_id", "to_account", "what", "due_at", "state", "source_session_id", "source_room_entry_id", "created_at", "due_notified_at", "closed_at", "note", "origin_marks" FROM `commitments`;
DROP TABLE `commitments`;
ALTER TABLE `__old_commitments` RENAME TO `commitments`;
CREATE INDEX `commitments_agent_state_idx` ON `commitments` (`agent_id`,`state`);
CREATE INDEX `commitments_due_idx` ON `commitments` (`due_at`);
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1793655529582;
COMMIT;
