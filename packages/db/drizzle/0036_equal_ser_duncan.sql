ALTER TABLE `room_entries` ADD `parent_entry_id` text;--> statement-breakpoint
ALTER TABLE `room_entries` ADD `thread_root_entry_id` text;--> statement-breakpoint
CREATE INDEX `idx_room_entries_thread_root` ON `room_entries` (`room_id`,`thread_root_entry_id`) WHERE "thread_root_entry_id" IS NOT NULL;