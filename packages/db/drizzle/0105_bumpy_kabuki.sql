CREATE TABLE `community_entry_origins` (
	`community_ref` text NOT NULL,
	`remote_room_id` text NOT NULL,
	`owner_author_id` text NOT NULL,
	`remote_entry_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`community_ref`, `remote_room_id`, `owner_author_id`, `remote_entry_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_entry_origins_qualified_key_unique` ON `community_entry_origins` (`community_ref`,`remote_room_id`,`owner_author_id`,`idempotency_key`);--> statement-breakpoint
ALTER TABLE `community_outbox` ADD `local_parent_entry_id` text;--> statement-breakpoint
ALTER TABLE `community_outbox` ADD `attachment_ids` text NOT NULL;