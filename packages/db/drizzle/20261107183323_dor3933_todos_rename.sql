-- To-dos step 1 (DOR-3933): the table `commitments` is now `todos`, with no other change. Every
-- column, row, CHECK and index is kept; only the names move from `commitments_*` to `todos_*`.
-- Hand-edited after the shape `drizzle-kit generate` gives a renamed table:
--   * A rebuild rather than `ALTER TABLE … RENAME`, so the stored CHECK constraints carry their new
--     names too, exactly as the snapshot records them. Drizzle runs every pending migration inside
--     ONE transaction, so this file commits or rolls back as one.
--   * Dropping `commitments` drops its two "refuse legacy" triggers with it. They are recreated on
--     `todos` below, unchanged but for their names and the table they guard; Drizzle does not know
--     they exist (see `packages/db/src/schema/todos/todos.ts`).
--   * The last statements run SQLite's foreign-key check on `todos` and fail the migration on any
--     violation, as the DOR-3088 rebuild did. Nothing references the table, so it cannot fire yet.
--   * The down-migration is `packages/db/src/down/20261107183323_dor3933_todos_rename.down.sql`.
CREATE TABLE `__new_todos` (
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
	CONSTRAINT "todos_state" CHECK("__new_todos"."state" IN ('open', 'kept', 'missed', 'dropped')),
	CONSTRAINT "todos_what_length" CHECK(length("__new_todos"."what") <= 300),
	CONSTRAINT "todos_owner" CHECK(("__new_todos"."agent_id" IS NULL) <> ("__new_todos"."owner_account" IS NULL)),
	CONSTRAINT "todos_assigned_by_kind" CHECK("__new_todos"."assigned_by_kind" IN ('agent', 'person', 'outsider')),
	CONSTRAINT "todos_authority" CHECK("__new_todos"."authority" IN ('legacy', 'self', 'person', 'runtime-default') OR (json_valid("__new_todos"."authority") AND json_type("__new_todos"."authority") = 'object')),
	CONSTRAINT "todos_legacy_is_own" CHECK("__new_todos"."authority" <> 'legacy' OR ("__new_todos"."agent_id" IS NOT NULL AND "__new_todos"."assigned_by_kind" = 'agent' AND "__new_todos"."assigned_by" = "__new_todos"."agent_id")),
	CONSTRAINT "todos_authority_marks" CHECK(json_valid("__new_todos"."authority_marks") AND json_type("__new_todos"."authority_marks") = 'object'),
	CONSTRAINT "todos_title_from_source" CHECK("__new_todos"."title_from_source" IN (0, 1)),
	CONSTRAINT "todos_chain_depth" CHECK("__new_todos"."chain_depth" >= 0),
	CONSTRAINT "todos_chain_agents" CHECK(json_valid("__new_todos"."chain_agents") AND json_type("__new_todos"."chain_agents") = 'array'),
	CONSTRAINT "todos_notes_length" CHECK("__new_todos"."notes" IS NULL OR length("__new_todos"."notes") <= 2000),
	CONSTRAINT "todos_rank_length" CHECK("__new_todos"."rank" IS NULL OR length("__new_todos"."rank") <= 64)
);
--> statement-breakpoint
INSERT INTO `__new_todos`("id", "agent_id", "owner_account", "to_account", "what", "due_at", "state", "source_session_id", "source_room_entry_id", "created_at", "due_notified_at", "closed_at", "note", "origin_marks", "assigned_by_kind", "assigned_by", "authority", "authority_marks", "chain_depth", "chain_agents", "title_from_source", "source_author", "room_id", "notes", "rank") SELECT "id", "agent_id", "owner_account", "to_account", "what", "due_at", "state", "source_session_id", "source_room_entry_id", "created_at", "due_notified_at", "closed_at", "note", "origin_marks", "assigned_by_kind", "assigned_by", "authority", "authority_marks", "chain_depth", "chain_agents", "title_from_source", "source_author", "room_id", "notes", "rank" FROM `commitments`;--> statement-breakpoint
DROP TABLE `commitments`;--> statement-breakpoint
ALTER TABLE `__new_todos` RENAME TO `todos`;--> statement-breakpoint
CREATE INDEX `todos_agent_state_idx` ON `todos` (`agent_id`,`state`);--> statement-breakpoint
CREATE INDEX `todos_due_idx` ON `todos` (`due_at`);--> statement-breakpoint
CREATE INDEX `todos_owner_state_idx` ON `todos` (`owner_account`,`state`);--> statement-breakpoint
CREATE INDEX `todos_assigned_by_idx` ON `todos` (`assigned_by`,`state`);--> statement-breakpoint
CREATE TRIGGER `todos_no_new_legacy` BEFORE INSERT ON `todos` WHEN NEW."authority" = 'legacy' BEGIN SELECT RAISE(ABORT, 'todos: legacy authority is only for rows from before to-dos'); END;--> statement-breakpoint
CREATE TRIGGER `todos_no_legacy_update` BEFORE UPDATE OF "authority" ON `todos` WHEN NEW."authority" = 'legacy' AND OLD."authority" <> 'legacy' BEGIN SELECT RAISE(ABORT, 'todos: legacy authority is only for rows from before to-dos'); END;--> statement-breakpoint
CREATE TEMP TABLE `__dor3933_fk_guard` (`violations` integer NOT NULL CHECK (`violations` = 0));--> statement-breakpoint
INSERT INTO `__dor3933_fk_guard` SELECT count(*) FROM pragma_foreign_key_check('todos');--> statement-breakpoint
DROP TABLE `__dor3933_fk_guard`;
