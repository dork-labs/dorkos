CREATE TABLE `extension_agent_chats` (
	`extension_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`extension_id`, `agent_id`)
);
--> statement-breakpoint
CREATE TABLE `extension_agent_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`agent_id` text,
	`session_id` text,
	`cwd` text,
	`status` text NOT NULL,
	`receipt_status` text NOT NULL,
	`reason` text,
	`content` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "extension_agent_sends_status" CHECK("extension_agent_sends"."status" IN ('held', 'queued', 'started', 'done', 'failed')),
	CONSTRAINT "extension_agent_sends_receipt" CHECK("extension_agent_sends"."receipt_status" IN ('started', 'queued'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extension_agent_sends_key_idx` ON `extension_agent_sends` (`extension_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `extension_agent_sends_status_idx` ON `extension_agent_sends` (`status`);