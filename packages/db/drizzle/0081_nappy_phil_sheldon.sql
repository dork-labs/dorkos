CREATE TABLE `room_repos` (
	`room_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`created_at` text NOT NULL,
	`last_merge_seq` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `rooms` DROP COLUMN `workspace_id`;