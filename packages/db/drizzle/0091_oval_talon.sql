CREATE TABLE `session_message_acceptance_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_generation` text NOT NULL,
	`queue_message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`origin_runtime` text NOT NULL,
	`origin_agent_path` text NOT NULL,
	`origin_authority_digest` text NOT NULL,
	`state` text NOT NULL,
	`accepted_at` text NOT NULL,
	`dispatch_attempt_id` text,
	`dispatch_boot_epoch` text,
	`dispatch_claimed_at` text,
	`turn_start_seq` integer,
	`turn_started_at` text,
	`settled_at` text,
	`settle_outcome` text,
	`cancellation_code` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_message_acceptance_receipts_queue_message_id_unique` ON `session_message_acceptance_receipts` (`queue_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_message_acceptance_source_unique` ON `session_message_acceptance_receipts` (`source_kind`,`source_id`,`source_generation`);--> statement-breakpoint
CREATE INDEX `session_message_acceptance_state_idx` ON `session_message_acceptance_receipts` (`state`,`accepted_at`);--> statement-breakpoint
CREATE INDEX `session_message_acceptance_session_idx` ON `session_message_acceptance_receipts` (`session_id`,`state`,`accepted_at`);--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `source_generation` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `origin_runtime` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `origin_agent_path` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `origin_authority_digest` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `live_hold_boot_epoch` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `live_hold_until` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `resolved_connection_id` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `resolved_operation_revision_ids_json` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `resolved_events_json` text;--> statement-breakpoint
ALTER TABLE `connector_agent_requests` ADD `resolved_at` text;