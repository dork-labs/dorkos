CREATE TABLE `canvas_doc_batches` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`scope` text NOT NULL,
	`route_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`grant_revision` integer NOT NULL,
	`generation` text NOT NULL,
	`input_event_ids` text NOT NULL,
	`effective_payload` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_until` text,
	`relay_message_id` text,
	`turn_id` text,
	`admission_receipt_id` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `canvas_doc_channels`(`document_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`admission_receipt_id`) REFERENCES `session_message_acceptance_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`,`grant_id`) REFERENCES `canvas_doc_grants`(`document_id`,`grant_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_batches_document_id_unique` ON `canvas_doc_batches` (`document_id`,`batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_batches_pending_unique` ON `canvas_doc_batches` (`document_id`,`route_id`) WHERE "status" in ('pending', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_batches_active_unique` ON `canvas_doc_batches` (`document_id`,`route_id`) WHERE "status" in ('accepted', 'dispatching', 'turn_started', 'in_doubt');--> statement-breakpoint
CREATE INDEX `canvas_doc_batches_due_idx` ON `canvas_doc_batches` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `canvas_doc_batches_lease_idx` ON `canvas_doc_batches` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `canvas_doc_batches_receipt_idx` ON `canvas_doc_batches` (`admission_receipt_id`);--> statement-breakpoint
CREATE TABLE `canvas_doc_channels` (
	`document_id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`next_doc_seq` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`state_rev` integer DEFAULT 0 NOT NULL,
	`retention_floor` integer DEFAULT 1 NOT NULL,
	`declaration` text,
	`declaration_hash` text,
	`opener_agent_id` text,
	`manifest_hash` text,
	`closed_at` text,
	`closure_evidence` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `canvas_doc_channels_scope_idx` ON `canvas_doc_channels` (`scope`,`closed_at`);--> statement-breakpoint
CREATE TABLE `canvas_doc_deliveries` (
	`document_id` text NOT NULL,
	`event_id` text NOT NULL,
	`route_id` text NOT NULL,
	`batch_id` text,
	`status` text NOT NULL,
	`turn_id` text,
	`reason` text,
	`ack_outcome` text,
	`acknowledged_at` text,
	`acknowledged_by` text,
	`ack_evidence` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`document_id`, `event_id`, `route_id`),
	FOREIGN KEY (`document_id`,`event_id`) REFERENCES `canvas_doc_events`(`document_id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`,`batch_id`) REFERENCES `canvas_doc_batches`(`document_id`,`batch_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `canvas_doc_deliveries_batch_idx` ON `canvas_doc_deliveries` (`document_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `canvas_doc_deliveries_status_idx` ON `canvas_doc_deliveries` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `canvas_doc_events` (
	`document_id` text NOT NULL,
	`event_id` text NOT NULL,
	`doc_seq` integer NOT NULL,
	`direction` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`envelope_hash` text NOT NULL,
	`coalesce_key` text,
	`client_ts` text,
	`received_at` text NOT NULL,
	`provenance` text NOT NULL,
	PRIMARY KEY(`document_id`, `event_id`),
	FOREIGN KEY (`document_id`) REFERENCES `canvas_doc_channels`(`document_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_events_sequence_unique` ON `canvas_doc_events` (`document_id`,`doc_seq`);--> statement-breakpoint
CREATE INDEX `canvas_doc_events_received_idx` ON `canvas_doc_events` (`document_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `canvas_doc_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`route_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`opener_agent_id` text,
	`target_agent_id` text,
	`target_session_id` text,
	`target_runtime` text,
	`normalized_route` text NOT NULL,
	`route_hash` text NOT NULL,
	`declaration_hash` text NOT NULL,
	`manifest_hash` text,
	`approved_by` text NOT NULL,
	`approval_id` text,
	`approval_evidence` text NOT NULL,
	`limits` text NOT NULL,
	`allowed_types` text NOT NULL,
	`write_operation` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `canvas_doc_channels`(`document_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_grants_document_id_unique` ON `canvas_doc_grants` (`document_id`,`grant_id`);--> statement-breakpoint
CREATE INDEX `canvas_doc_grants_route_idx` ON `canvas_doc_grants` (`document_id`,`route_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `canvas_doc_identity_intents` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`from_scope` text NOT NULL,
	`to_scope` text NOT NULL,
	`source_id` text NOT NULL,
	`source_generation` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `canvas_doc_channels`(`document_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `canvas_doc_identity_intents_recovery_idx` ON `canvas_doc_identity_intents` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `canvas_doc_write_intents` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`event_id` text NOT NULL,
	`envelope_hash` text NOT NULL,
	`grant_id` text NOT NULL,
	`source_identity` text NOT NULL,
	`resolved_cwd` text NOT NULL,
	`tree_kind` text NOT NULL,
	`canonical_path` text NOT NULL,
	`operation` text NOT NULL,
	`input` text NOT NULL,
	`before_hash` text NOT NULL,
	`after_hash` text NOT NULL,
	`expected_version` text NOT NULL,
	`evidence` text,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `canvas_doc_channels`(`document_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`,`grant_id`) REFERENCES `canvas_doc_grants`(`document_id`,`grant_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_write_intents_event_unique` ON `canvas_doc_write_intents` (`document_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `canvas_doc_write_intents_recovery_idx` ON `canvas_doc_write_intents` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `canvas_doc_write_intents_path_idx` ON `canvas_doc_write_intents` (`canonical_path`,`status`);