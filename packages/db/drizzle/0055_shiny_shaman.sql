CREATE TABLE `handle_tombstones` (
	`handle` text NOT NULL,
	`author_id` text NOT NULL,
	`released_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handle_tombstones_handle_unique` ON `handle_tombstones` (lower("handle"));--> statement-breakpoint
CREATE INDEX `idx_handle_tombstones_author` ON `handle_tombstones` (`author_id`);--> statement-breakpoint
ALTER TABLE `authors` ADD `handle` text;--> statement-breakpoint
CREATE UNIQUE INDEX `authors_handle_unique` ON `authors` (lower("handle")) WHERE "handle" is not null;