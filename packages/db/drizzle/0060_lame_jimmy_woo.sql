CREATE TABLE `read_cursors` (
	`user_id` text NOT NULL,
	`thread_kind` text NOT NULL,
	`thread_id` text NOT NULL,
	`last_read_seq` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `thread_kind`, `thread_id`),
	CONSTRAINT "read_cursors_thread_kind" CHECK("read_cursors"."thread_kind" IN ('room', 'session', 'inbox')),
	CONSTRAINT "read_cursors_last_read_seq" CHECK("read_cursors"."last_read_seq" >= 0)
);
