CREATE TABLE `chat_agent_dms` (
	`from_agent_path` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`from_agent_path`, `to_agent_id`)
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`to_session_id` text NOT NULL,
	`from_session_id` text NOT NULL,
	`from_agent_path` text NOT NULL,
	`from_agent_id` text,
	`from_agent_name` text NOT NULL,
	`from_chat_title` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`summary` text,
	`nonce` text,
	`delivery` text NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`queue_message_id` text,
	`ceiling_json` text NOT NULL,
	`reply_to_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "chat_messages_kind" CHECK("chat_messages"."kind" IN ('message', 'report', 'start', 'stop'))
);
--> statement-breakpoint
CREATE INDEX `chat_messages_to_idx` ON `chat_messages` (`to_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_from_idx` ON `chat_messages` (`from_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_queue_idx` ON `chat_messages` (`queue_message_id`);--> statement-breakpoint
CREATE TABLE `chat_read_cursors` (
	`reader_session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`last_message_id` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`reader_session_id`, `target_session_id`)
);
