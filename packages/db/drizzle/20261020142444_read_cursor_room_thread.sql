PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_read_cursors` (
	`user_id` text NOT NULL,
	`thread_kind` text NOT NULL,
	`thread_id` text NOT NULL,
	`last_read_seq` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `thread_kind`, `thread_id`),
	CONSTRAINT "read_cursors_thread_kind" CHECK("__new_read_cursors"."thread_kind" IN ('room', 'session', 'inbox', 'room-thread')),
	CONSTRAINT "read_cursors_last_read_seq" CHECK("__new_read_cursors"."last_read_seq" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_read_cursors`("user_id", "thread_kind", "thread_id", "last_read_seq", "updated_at") SELECT "user_id", "thread_kind", "thread_id", "last_read_seq", "updated_at" FROM `read_cursors`;--> statement-breakpoint
DROP TABLE `read_cursors`;--> statement-breakpoint
ALTER TABLE `__new_read_cursors` RENAME TO `read_cursors`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_read_cursors_thread` ON `read_cursors` (`thread_kind`,`thread_id`);