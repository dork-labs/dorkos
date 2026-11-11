CREATE TABLE `community_mirror_access` (
	`local_room_id` text NOT NULL,
	`author_id` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`local_room_id`, `author_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_community_mirror_access_author_state` ON `community_mirror_access` (`author_id`,`state`);--> statement-breakpoint
CREATE TABLE `community_mirror_entries` (
	`community_ref` text NOT NULL,
	`remote_room_id` text NOT NULL,
	`remote_entry_id` text NOT NULL,
	`local_room_id` text NOT NULL,
	`local_entry_id` text NOT NULL,
	`remote_seq` integer NOT NULL,
	PRIMARY KEY(`community_ref`, `remote_room_id`, `remote_entry_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_mirror_entries_room_remote_seq_unique` ON `community_mirror_entries` (`local_room_id`,`remote_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `community_mirror_entries_local_entry_unique` ON `community_mirror_entries` (`local_entry_id`);--> statement-breakpoint
CREATE INDEX `idx_community_mirror_entries_room_seq` ON `community_mirror_entries` (`local_room_id`,`remote_seq`);--> statement-breakpoint
CREATE TABLE `community_room_mirrors` (
	`local_room_id` text PRIMARY KEY NOT NULL,
	`community_ref` text NOT NULL,
	`remote_room_id` text NOT NULL,
	`owner_author_id` text NOT NULL,
	`state` text NOT NULL,
	`authorized_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_room_mirrors_ref_remote_room_unique` ON `community_room_mirrors` (`community_ref`,`remote_room_id`);--> statement-breakpoint
CREATE INDEX `idx_community_room_mirrors_owner_state` ON `community_room_mirrors` (`owner_author_id`,`state`);