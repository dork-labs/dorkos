-- Agent grant autonomy, phase 3 (spec `agent-grant-autonomy` §5): the access-change ledger gains
-- the `approve_read` kind and a `request_id` column, for an agent's approval of another agent's
-- read request. Nothing else changes: every existing row, column, CHECK and index is kept.
-- Hand-edited after the shape `drizzle-kit generate` gives a CHECK change:
--   * SQLite can't alter a CHECK, so this is the standard rebuild: create the new table, copy every
--     row, drop the old one, rename, recreate every index. Drizzle runs every pending migration
--     inside ONE transaction, so this file commits or rolls back as one. The generator's
--     `PRAGMA foreign_keys` lines are left out: inside a transaction SQLite ignores them.
--   * The copy writes NULL into `request_id`: the old table has no such column. (The generator
--     selected it from the old table, which fails on any database with the table in it.)
--   * The last statements run SQLite's foreign-key check on the table and fail the migration on any
--     violation. Nothing references it, so it cannot fire yet.
--   * The down-migration is `packages/db/src/down/20261109000421_connection_grant_approvals.down.sql`.
--     It refuses while any `approve_read` row exists, rather than drop one.
CREATE TABLE `__new_connection_grant_changes` (
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
	`request_id` text,
	`undo_of` text,
	`undone_by` text,
	`created_at` text NOT NULL,
	CONSTRAINT "connection_grant_changes_kind" CHECK("__new_connection_grant_changes"."kind" IN ('narrow_own', 'narrow_other', 'exclude_own', 'exclude_other', 'approve_read', 'undo')),
	CONSTRAINT "connection_grant_changes_outcome" CHECK("__new_connection_grant_changes"."outcome" IN ('applied', 'refused')),
	CONSTRAINT "connection_grant_changes_refusal" CHECK(("__new_connection_grant_changes"."outcome" = 'refused') = ("__new_connection_grant_changes"."refusal_code" IS NOT NULL)),
	CONSTRAINT "connection_grant_changes_actor_kind" CHECK("__new_connection_grant_changes"."actor_kind" IN ('person', 'agent'))
);
--> statement-breakpoint
INSERT INTO `__new_connection_grant_changes`("id", "kind", "outcome", "refusal_code", "actor_kind", "actor_id", "actor_session_id", "target_agent_id", "connection_id", "before_json", "after_json", "reason", "request_id", "undo_of", "undone_by", "created_at") SELECT "id", "kind", "outcome", "refusal_code", "actor_kind", "actor_id", "actor_session_id", "target_agent_id", "connection_id", "before_json", "after_json", "reason", NULL, "undo_of", "undone_by", "created_at" FROM `connection_grant_changes`;--> statement-breakpoint
DROP TABLE `connection_grant_changes`;--> statement-breakpoint
ALTER TABLE `__new_connection_grant_changes` RENAME TO `connection_grant_changes`;--> statement-breakpoint
CREATE INDEX `connection_grant_changes_actor_idx` ON `connection_grant_changes` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `connection_grant_changes_connection_idx` ON `connection_grant_changes` (`connection_id`,`created_at`);--> statement-breakpoint
CREATE TEMP TABLE `__grant_approvals_fk_guard` (`violations` integer NOT NULL CHECK (`violations` = 0));--> statement-breakpoint
INSERT INTO `__grant_approvals_fk_guard` SELECT count(*) FROM pragma_foreign_key_check('connection_grant_changes');--> statement-breakpoint
DROP TABLE `__grant_approvals_fk_guard`;
