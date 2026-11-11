CREATE TABLE `room_bridge_messages` (
	`room_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`direction` text NOT NULL,
	`chat_id` text NOT NULL,
	`adapter_id` text NOT NULL,
	`platform_message_id` text,
	`thread_id` text,
	`thread_name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_bridge_messages_inbound_dedup_unique` ON `room_bridge_messages` (`adapter_id`,`chat_id`,`platform_message_id`) WHERE "direction" = 'inbound';--> statement-breakpoint
CREATE UNIQUE INDEX `room_bridge_messages_entry_unique` ON `room_bridge_messages` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_room_bridge_messages_room_direction` ON `room_bridge_messages` (`room_id`,`direction`);--> statement-breakpoint
CREATE TABLE `room_bridges` (
	`room_id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`channel_type` text,
	`platform_chat_type` text NOT NULL,
	`binding_id` text NOT NULL,
	`visibility` text,
	`visibility_checked_at` text,
	`deliver_notices` integer NOT NULL,
	`last_delivered_seq` integer DEFAULT 0 NOT NULL,
	`last_activity_at` text,
	`created_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_bridges_adapter_chat_unique` ON `room_bridges` (`adapter_id`,`chat_id`);