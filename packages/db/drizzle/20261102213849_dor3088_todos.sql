-- To-dos v1 (DOR-3088): the one rebuild of `commitments`, so a person can own a row and every row
-- says who assigned it and the power it carries. Hand-edited after `drizzle-kit generate`:
--   * Drizzle runs every pending migration inside ONE transaction (BEGIN … COMMIT), so this whole
--     file commits or rolls back as one. That is also why there is no `PRAGMA foreign_keys=OFF`:
--     SQLite ignores it inside a transaction, and nothing references `commitments` anyway.
--   * Existing rows backfill as the agent itself, with authority `legacy`: they hold the agent's
--     own words, so they behave as they always did. Two triggers refuse `legacy` on any later write.
--     Their marks carry over; marks that cannot be read become the outsider mark, never none.
--   * The last statements run SQLite's foreign-key check on `commitments` and fail the migration
--     on any violation. The table has no foreign keys today, so it cannot fire yet; it is there so
--     a foreign key added to this rebuild later is checked too. It is scoped to this table on
--     purpose: an old violation elsewhere in someone's database must not stop DorkOS starting.
--   * Every CHECK and index the table had is kept. The down-migration is
--     `packages/db/src/down/20261102213849_dor3088_todos.down.sql`.
CREATE TABLE `__new_commitments` (
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
	CONSTRAINT "commitments_state" CHECK("__new_commitments"."state" IN ('open', 'kept', 'missed', 'dropped')),
	CONSTRAINT "commitments_what_length" CHECK(length("__new_commitments"."what") <= 300),
	CONSTRAINT "commitments_owner" CHECK(("__new_commitments"."agent_id" IS NULL) <> ("__new_commitments"."owner_account" IS NULL)),
	CONSTRAINT "commitments_assigned_by_kind" CHECK("__new_commitments"."assigned_by_kind" IN ('agent', 'person', 'outsider')),
	CONSTRAINT "commitments_authority" CHECK("__new_commitments"."authority" IN ('legacy', 'self', 'person', 'runtime-default') OR (json_valid("__new_commitments"."authority") AND json_type("__new_commitments"."authority") = 'object')),
	CONSTRAINT "commitments_legacy_is_own" CHECK("__new_commitments"."authority" <> 'legacy' OR ("__new_commitments"."agent_id" IS NOT NULL AND "__new_commitments"."assigned_by_kind" = 'agent' AND "__new_commitments"."assigned_by" = "__new_commitments"."agent_id")),
	CONSTRAINT "commitments_authority_marks" CHECK(json_valid("__new_commitments"."authority_marks") AND json_type("__new_commitments"."authority_marks") = 'object'),
	CONSTRAINT "commitments_title_from_source" CHECK("__new_commitments"."title_from_source" IN (0, 1)),
	CONSTRAINT "commitments_chain_depth" CHECK("__new_commitments"."chain_depth" >= 0),
	CONSTRAINT "commitments_chain_agents" CHECK(json_valid("__new_commitments"."chain_agents") AND json_type("__new_commitments"."chain_agents") = 'array'),
	CONSTRAINT "commitments_notes_length" CHECK("__new_commitments"."notes" IS NULL OR length("__new_commitments"."notes") <= 2000),
	CONSTRAINT "commitments_rank_length" CHECK("__new_commitments"."rank" IS NULL OR length("__new_commitments"."rank") <= 64)
);
--> statement-breakpoint
INSERT INTO `__new_commitments`("id", "agent_id", "owner_account", "to_account", "what", "due_at", "state", "source_session_id", "source_room_entry_id", "created_at", "due_notified_at", "closed_at", "note", "origin_marks", "assigned_by_kind", "assigned_by", "authority", "authority_marks", "chain_depth", "chain_agents", "title_from_source", "source_author", "room_id", "notes", "rank") SELECT "id", "agent_id", NULL, "to_account", "what", "due_at", "state", "source_session_id", "source_room_entry_id", "created_at", "due_notified_at", "closed_at", "note", "origin_marks", 'agent', "agent_id", 'legacy', CASE WHEN "origin_marks" IS NULL THEN '{}' WHEN json_valid("origin_marks") AND json_type("origin_marks") = 'object' THEN "origin_marks" ELSE '{"outsider":true}' END, 0, '[]', 0, NULL, NULL, NULL, NULL FROM `commitments`;--> statement-breakpoint
DROP TABLE `commitments`;--> statement-breakpoint
ALTER TABLE `__new_commitments` RENAME TO `commitments`;--> statement-breakpoint
CREATE INDEX `commitments_agent_state_idx` ON `commitments` (`agent_id`,`state`);--> statement-breakpoint
CREATE INDEX `commitments_due_idx` ON `commitments` (`due_at`);--> statement-breakpoint
CREATE INDEX `commitments_owner_state_idx` ON `commitments` (`owner_account`,`state`);--> statement-breakpoint
CREATE INDEX `commitments_assigned_by_idx` ON `commitments` (`assigned_by`,`state`);--> statement-breakpoint
CREATE TRIGGER `commitments_no_new_legacy` BEFORE INSERT ON `commitments` WHEN NEW."authority" = 'legacy' BEGIN SELECT RAISE(ABORT, 'commitments: legacy authority is only for rows from before to-dos'); END;--> statement-breakpoint
CREATE TRIGGER `commitments_no_legacy_update` BEFORE UPDATE OF "authority" ON `commitments` WHEN NEW."authority" = 'legacy' AND OLD."authority" <> 'legacy' BEGIN SELECT RAISE(ABORT, 'commitments: legacy authority is only for rows from before to-dos'); END;--> statement-breakpoint
CREATE TEMP TABLE `__dor3088_fk_guard` (`violations` integer NOT NULL CHECK (`violations` = 0));--> statement-breakpoint
INSERT INTO `__dor3088_fk_guard` SELECT count(*) FROM pragma_foreign_key_check('commitments');--> statement-breakpoint
DROP TABLE `__dor3088_fk_guard`;
