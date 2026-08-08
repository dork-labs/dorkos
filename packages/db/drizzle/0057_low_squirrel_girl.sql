CREATE TABLE `room_attachments` (
	`room_id` text NOT NULL,
	`id` text NOT NULL,
	`entry_id` text,
	`author_id` text NOT NULL,
	`name` text NOT NULL,
	`extension` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`preview` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `id`),
	FOREIGN KEY (`room_id`,`entry_id`) REFERENCES `room_entries`(`room_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_room_attachments_entry` ON `room_attachments` (`room_id`,`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_room_attachments_unbound` ON `room_attachments` (`room_id`,`created_at`) WHERE "entry_id" IS NULL;