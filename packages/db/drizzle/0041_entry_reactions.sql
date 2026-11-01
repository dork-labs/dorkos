CREATE TABLE `room_entry_reactions` (
	`room_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`author_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `entry_id`, `author_id`, `emoji`),
	FOREIGN KEY (`room_id`,`entry_id`) REFERENCES `room_entries`(`room_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_room_entry_reactions_author` ON `room_entry_reactions` (`author_id`,`emoji`);