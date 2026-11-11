CREATE TABLE `authors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`natural_key` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_kind_natural_key_unique` ON `authors` (`kind`,`natural_key`);--> statement-breakpoint
CREATE TABLE `room_entries` (
	`room_id` text NOT NULL,
	`seq` integer NOT NULL,
	`id` text NOT NULL,
	`author_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`session_id` text,
	`cascade_root` text NOT NULL,
	`cascade_depth` integer DEFAULT 0 NOT NULL,
	`signature` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `seq`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_entries_room_id_entry_id_unique` ON `room_entries` (`room_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_room_entries_cascade_root` ON `room_entries` (`room_id`,`cascade_root`);--> statement-breakpoint
CREATE TABLE `room_members` (
	`room_id` text NOT NULL,
	`author_id` text NOT NULL,
	`response_mode` text NOT NULL,
	`joined_at` text NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`room_id`, `author_id`)
);
--> statement-breakpoint
CREATE TABLE `room_sessions` (
	`room_id` text NOT NULL,
	`author_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `author_id`)
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`slug` text,
	`title` text NOT NULL,
	`topic` text,
	`workspace_id` text,
	`root_entry_id` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_channel_slug_unique` ON `rooms` (`slug`) WHERE "kind" = 'channel' AND "archived" = 0;--> statement-breakpoint
CREATE INDEX `idx_rooms_parent_id` ON `rooms` (`parent_id`);