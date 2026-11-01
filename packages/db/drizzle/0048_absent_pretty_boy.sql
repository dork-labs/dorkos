CREATE TABLE `agent_connector_attachments` (
	`agent_id` text NOT NULL,
	`account_id` text NOT NULL,
	`attached_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `agent_connector_attachments_account_idx` ON `agent_connector_attachments` (`account_id`);--> statement-breakpoint
CREATE TABLE `session_connector_attachments` (
	`session_id` text NOT NULL,
	`account_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `session_connector_attachments_account_idx` ON `session_connector_attachments` (`account_id`);--> statement-breakpoint
CREATE TABLE `unclaimed_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`channel_type` text,
	`chat_kind` text NOT NULL,
	`sender_name` text,
	`sender_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`message_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`decided_at` text,
	`decided_agent_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unclaimed_chats_adapter_chat_unique` ON `unclaimed_chats` (`adapter_id`,`chat_id`);--> statement-breakpoint
CREATE INDEX `unclaimed_chats_status_idx` ON `unclaimed_chats` (`status`);