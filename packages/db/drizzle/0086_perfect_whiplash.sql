CREATE TABLE `agent_connection_attachments` (
	`agent_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`attached_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `connection_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_connection_attachments_connection_idx` ON `agent_connection_attachments` (`connection_id`);--> statement-breakpoint
CREATE TABLE `connection_operation_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`agent_id` text,
	`connection_id` text NOT NULL,
	`operation_revision_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_revision_id`) REFERENCES `connector_operation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_operation_grants_subject_revision_unique` ON `connection_operation_grants` (`subject_type`,`subject_id`,`connection_id`,`operation_revision_id`);--> statement-breakpoint
CREATE INDEX `connection_operation_grants_agent_idx` ON `connection_operation_grants` (`agent_id`);--> statement-breakpoint
CREATE INDEX `connection_operation_grants_connection_revision_idx` ON `connection_operation_grants` (`connection_id`,`operation_revision_id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_instance_id` text NOT NULL,
	`external_account_ref` text NOT NULL,
	`toolkit` text NOT NULL,
	`label` text NOT NULL,
	`identity_hint` text,
	`status` text NOT NULL,
	`lifecycle_state` text DEFAULT 'connected' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`auth_config_ref` text,
	`grant_reconciliation_status` text DEFAULT 'migration_needs_reconcile' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_verified_at` text,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_instance_external_ref_unique` ON `connections` (`provider_instance_id`,`external_account_ref`);--> statement-breakpoint
CREATE INDEX `connections_toolkit_idx` ON `connections` (`toolkit`);--> statement-breakpoint
CREATE TABLE `connector_application_migrations` (
	`version` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `connector_legacy_agent_revocations` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`revoked_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connector_operation_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_instance_id` text NOT NULL,
	`toolkit` text NOT NULL,
	`operation_slug` text NOT NULL,
	`toolkit_version` text NOT NULL,
	`schema_hash` text NOT NULL,
	`capability_classification` text NOT NULL,
	`input_schema_json` text NOT NULL,
	`discovered_at` text NOT NULL,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_operation_revision_fingerprint_unique` ON `connector_operation_revisions` (`provider_instance_id`,`toolkit`,`operation_slug`,`toolkit_version`,`schema_hash`,`capability_classification`);--> statement-breakpoint
CREATE TABLE `connector_provider_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`mode` text NOT NULL,
	`display_name` text NOT NULL,
	`custody` text NOT NULL,
	`capability_json` text NOT NULL,
	`credential_ref` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connector_provider_instances_type_idx` ON `connector_provider_instances` (`type`);--> statement-breakpoint
CREATE TABLE `session_connection_overrides` (
	`session_id` text NOT NULL,
	`agent_id` text,
	`connection_id` text NOT NULL,
	`state` text NOT NULL,
	`needs_reconciliation` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `connection_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_connection_overrides_agent_idx` ON `session_connection_overrides` (`agent_id`);--> statement-breakpoint
CREATE INDEX `session_connection_overrides_connection_idx` ON `session_connection_overrides` (`connection_id`);--> statement-breakpoint
CREATE TABLE `connector_event_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_instance_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`payload_schema_version` integer NOT NULL,
	`normalized_payload` text NOT NULL,
	`payload_protection` text NOT NULL,
	`state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`expires_at` text NOT NULL,
	`lease_owner` text,
	`leased_until` text,
	`received_at` text NOT NULL,
	`dispatched_at` text,
	`completed_at` text,
	`failure_code` text,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_id`) REFERENCES `connector_event_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_event_inbox_provider_dedupe_unique` ON `connector_event_inbox` (`provider_instance_id`,`subscription_id`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `connector_event_inbox_claim_idx` ON `connector_event_inbox` (`provider_instance_id`,`state`,`next_attempt_at`,`leased_until`,`expires_at`);--> statement-breakpoint
CREATE TABLE `connector_event_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`state` text NOT NULL,
	`recorded_at` text NOT NULL,
	`destination_receipt_id` text,
	`failure_code` text,
	FOREIGN KEY (`inbox_id`) REFERENCES `connector_event_inbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connector_event_receipts_inbox_idx` ON `connector_event_receipts` (`inbox_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `connector_event_receipts_subscription_event_idx` ON `connector_event_receipts` (`subscription_id`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `connector_event_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`destination_kind` text NOT NULL,
	`destination_id` text NOT NULL,
	`event_type` text NOT NULL,
	`filter_json` text NOT NULL,
	`filter_hash` text NOT NULL,
	`delivery_mode` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_event_subscription_scope_unique` ON `connector_event_subscriptions` (`connection_id`,`event_type`,`agent_id`,`destination_kind`,`destination_id`,`filter_hash`);--> statement-breakpoint
CREATE INDEX `connector_event_subscriptions_agent_idx` ON `connector_event_subscriptions` (`agent_id`);--> statement-breakpoint
CREATE TABLE `connector_agent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`review_request_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`service_slug` text NOT NULL,
	`requested_operations_json` text NOT NULL,
	`requested_events_json` text NOT NULL,
	`reason` text NOT NULL,
	`resume_state` text NOT NULL,
	`resume_token` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_request_id`) REFERENCES `connector_review_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_agent_requests_review_request_id_unique` ON `connector_agent_requests` (`review_request_id`);--> statement-breakpoint
CREATE INDEX `connector_agent_requests_agent_idx` ON `connector_agent_requests` (`agent_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `connector_agent_requests_resume_idx` ON `connector_agent_requests` (`resume_state`,`session_id`,`service_slug`);--> statement-breakpoint
CREATE TABLE `connector_review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`action_kind` text NOT NULL,
	`action_version` integer NOT NULL,
	`requester_kind` text NOT NULL,
	`requester_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`action_payload_json` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`resolution_summary` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_review_request_idempotency_unique` ON `connector_review_requests` (`requester_kind`,`requester_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `connector_review_requests_state_idx` ON `connector_review_requests` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `connector_usage_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`logical_operation_id` text NOT NULL,
	`attempt_index` integer NOT NULL,
	`surface` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`agent_id` text,
	`session_id` text,
	`connection_id` text NOT NULL,
	`provider_instance_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`payer` text NOT NULL,
	`operation_revision_id` text NOT NULL,
	`outcome` text NOT NULL,
	`provider_log_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error_code` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_revision_id`) REFERENCES `connector_operation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_usage_logical_attempt_unique` ON `connector_usage_attempts` (`logical_operation_id`,`attempt_index`);--> statement-breakpoint
CREATE INDEX `connector_usage_connection_started_idx` ON `connector_usage_attempts` (`connection_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `connector_usage_agent_started_idx` ON `connector_usage_attempts` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `connector_usage_revision_started_idx` ON `connector_usage_attempts` (`operation_revision_id`,`started_at`);--> statement-breakpoint
CREATE TRIGGER `connector_operation_revisions_immutable_update`
BEFORE UPDATE ON `connector_operation_revisions`
BEGIN
	SELECT RAISE(ABORT, 'connector operation revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `connector_operation_revisions_immutable_delete`
BEFORE DELETE ON `connector_operation_revisions`
BEGIN
	SELECT RAISE(ABORT, 'connector operation revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `connector_event_receipts_append_only_update`
BEFORE UPDATE ON `connector_event_receipts`
BEGIN
	SELECT RAISE(ABORT, 'connector event receipts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `connector_event_receipts_append_only_delete`
BEFORE DELETE ON `connector_event_receipts`
BEGIN
	SELECT RAISE(ABORT, 'connector event receipts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `connector_usage_attempts_append_only_update`
BEFORE UPDATE ON `connector_usage_attempts`
BEGIN
	SELECT RAISE(ABORT, 'connector usage attempts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `connector_usage_attempts_append_only_delete`
BEFORE DELETE ON `connector_usage_attempts`
BEGIN
	SELECT RAISE(ABORT, 'connector usage attempts are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `connections_tombstone_only_delete`
BEFORE DELETE ON `connections`
BEGIN
	-- Retained foreign keys protect integrity; disconnects tombstone rows and never use their cascades.
	SELECT RAISE(ABORT, 'connections must be tombstoned, not deleted');
END;
