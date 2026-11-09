.bail on
-- Down-migration for drizzle/20261109000421_connection_grant_approvals.sql (agent grant autonomy,
-- phase 3).
--
-- Puts `connection_grant_changes` back exactly as `20261108180940_connection_grant_changes` made it:
-- the same columns but `request_id`, the old kind CHECK without `approve_read`, the same indexes.
-- It also removes the migration's ledger row, so the next boot of a build that has it would apply
-- it again.
--
-- It refuses, changing nothing:
--   * while any `approve_read` row exists. Those are the record of an agent giving another agent
--     access; this file never drops one. A person undoes the access first, and the rows stay.
--   * once a later migration has run. Drizzle only applies migrations newer than the newest it
--     has recorded, so this one would never be applied again, and the later ones may rely on it.
--
-- Run it by hand, with DorkOS stopped, against a copy first:
--   sqlite3 ~/.dork/dork.db < packages/db/src/down/20261109000421_connection_grant_approvals.down.sql
-- The `.bail on` above makes the sqlite3 shell stop at the first error, so the open transaction
-- is thrown away rather than committed half done. Any other runner must stop at the first error
-- too. The test that proves it: packages/db/src/__tests__/connection-grant-approvals-migration.test.ts.
BEGIN IMMEDIATE;
-- Refuse before anything changes (see above).
CREATE TEMP TABLE `__grant_approvals_down_guard` (`refusals` integer NOT NULL CHECK (`refusals` = 0));
INSERT INTO `__grant_approvals_down_guard` SELECT count(*) FROM `__drizzle_migrations` WHERE `created_at` > 1794182661601;
INSERT INTO `__grant_approvals_down_guard` SELECT count(*) FROM `connection_grant_changes` WHERE `kind` = 'approve_read' OR `request_id` IS NOT NULL;
DROP TABLE `__grant_approvals_down_guard`;
CREATE TABLE `__old_connection_grant_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`refusal_code` text,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`target_agent_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`reason` text,
	`undo_of` text,
	`undone_by` text,
	`created_at` text NOT NULL,
	CONSTRAINT "connection_grant_changes_kind" CHECK("__old_connection_grant_changes"."kind" IN ('narrow_own', 'narrow_other', 'exclude_own', 'exclude_other', 'undo')),
	CONSTRAINT "connection_grant_changes_outcome" CHECK("__old_connection_grant_changes"."outcome" IN ('applied', 'refused')),
	CONSTRAINT "connection_grant_changes_refusal" CHECK(("__old_connection_grant_changes"."outcome" = 'refused') = ("__old_connection_grant_changes"."refusal_code" IS NOT NULL)),
	CONSTRAINT "connection_grant_changes_actor_kind" CHECK("__old_connection_grant_changes"."actor_kind" IN ('person', 'agent'))
);
INSERT INTO `__old_connection_grant_changes` SELECT "id", "kind", "outcome", "refusal_code", "actor_kind", "actor_id", "actor_session_id", "target_agent_id", "connection_id", "before_json", "after_json", "reason", "undo_of", "undone_by", "created_at" FROM `connection_grant_changes`;
DROP TABLE `connection_grant_changes`;
ALTER TABLE `__old_connection_grant_changes` RENAME TO `connection_grant_changes`;
CREATE INDEX `connection_grant_changes_actor_idx` ON `connection_grant_changes` (`actor_id`,`created_at`);
CREATE INDEX `connection_grant_changes_connection_idx` ON `connection_grant_changes` (`connection_id`,`created_at`);
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1794182661601;
COMMIT;
