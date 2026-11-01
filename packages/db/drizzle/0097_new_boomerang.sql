-- The canvas table serves two scopes now (spec `canvas-agent-seat` §1.1):
-- `room_id` becomes nullable because a `session:` document belongs to no room,
-- the four indexes move from `room_id` to `scope` because the scope is what
-- every query keys on, and `thread_root_entry_id` is added in the same rebuild
-- rather than in a second one.
--
-- HAND-EDITED, one line: drizzle-kit's copy step emitted
-- `SELECT ... "thread_root_entry_id" ... FROM canvas_documents`, reading a
-- column the OLD table does not have — the generator assumes a rebuild never
-- ADDS a column (the same edit `0069_futuristic_boomerang.sql` needed). The
-- literal `NULL` below is the correct copy: every row written before this
-- migration roots no thread, which is why the column is nullable.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canvas_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`room_id` text,
	`content` text NOT NULL,
	`title` text NOT NULL,
	`content_type` text NOT NULL,
	`author_id` text NOT NULL,
	`source_key` text,
	`source_label` text,
	`resolved_cwd` text,
	`tree_kind` text,
	`ahead_of_main` integer,
	`pinned` integer DEFAULT false NOT NULL,
	`rev` integer NOT NULL,
	`last_touched_by` text NOT NULL,
	`last_touched_at` text NOT NULL,
	`editing_by` text,
	`editing_heartbeat_at` text,
	`opened_at` text NOT NULL,
	`last_active_at` text NOT NULL,
	`thread_root_entry_id` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_canvas_documents`("id", "scope", "room_id", "content", "title", "content_type", "author_id", "source_key", "source_label", "resolved_cwd", "tree_kind", "ahead_of_main", "pinned", "rev", "last_touched_by", "last_touched_at", "editing_by", "editing_heartbeat_at", "opened_at", "last_active_at", "thread_root_entry_id") SELECT "id", "scope", "room_id", "content", "title", "content_type", "author_id", "source_key", "source_label", "resolved_cwd", "tree_kind", "ahead_of_main", "pinned", "rev", "last_touched_by", "last_touched_at", "editing_by", "editing_heartbeat_at", "opened_at", "last_active_at", NULL FROM `canvas_documents`;--> statement-breakpoint
DROP TABLE `canvas_documents`;--> statement-breakpoint
ALTER TABLE `__new_canvas_documents` RENAME TO `canvas_documents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_canvas_documents_scope` ON `canvas_documents` (`scope`,`last_active_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_documents_source_unique` ON `canvas_documents` (`scope`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_canvas_documents_scope_type` ON `canvas_documents` (`scope`,`content_type`);--> statement-breakpoint
CREATE INDEX `idx_canvas_documents_last_touched` ON `canvas_documents` (`scope`,`last_touched_by`,`last_touched_at`);
