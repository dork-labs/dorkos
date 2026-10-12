CREATE TABLE `heartbeat_report_items` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`to_account` text,
	`text` text NOT NULL,
	`key` text,
	`about` text,
	`beat_id` text,
	`report_row_id` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`closed_at` text,
	CONSTRAINT "heartbeat_report_items_kind" CHECK("heartbeat_report_items"."kind" IN ('raise', 'still-open', 'reports-to', 'triage')),
	CONSTRAINT "heartbeat_report_items_state" CHECK("heartbeat_report_items"."state" IN ('queued', 'reported', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX `heartbeat_report_items_agent_state_idx` ON `heartbeat_report_items` (`agent_id`,`state`);--> statement-breakpoint
CREATE INDEX `heartbeat_report_items_to_created_idx` ON `heartbeat_report_items` (`to_account`,`created_at`);--> statement-breakpoint
CREATE INDEX `heartbeat_report_items_report_row_idx` ON `heartbeat_report_items` (`report_row_id`);--> statement-breakpoint
CREATE INDEX `heartbeat_outbox_to_created_idx` ON `heartbeat_outbox` (`to_account`,`created_at`);