CREATE TABLE `connector_authentication_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`provider_instance_id` text NOT NULL,
	`execution_config_generation` integer NOT NULL,
	`provider_flow_id` text,
	`toolkit` text NOT NULL,
	`label` text,
	`reconnect_connection_id` text,
	`authorize_url` text,
	`callback_state_hash` text,
	`state` text NOT NULL,
	`result_connection_id` text,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reconnect_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connector_auth_flows_owner_state_idx` ON `connector_authentication_flows` (`owner_kind`,`owner_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `connector_auth_flows_owner_idempotency_unique` ON `connector_authentication_flows` (`owner_kind`,`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `connector_auth_flows_provider_idx` ON `connector_authentication_flows` (`provider_instance_id`,`execution_config_generation`,`state`);--> statement-breakpoint
CREATE TABLE `connector_managed_authority_outbox` (
	`command_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provider_instance_id` text NOT NULL,
	`execution_config_generation` integer NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`managed_connection_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`scope_version` integer NOT NULL,
	`request_hash` text NOT NULL,
	`request_json` text NOT NULL,
	`state` text NOT NULL,
	`safe_reason` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_owner` text,
	`leased_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	`compacted_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_managed_authority_version_unique` ON `connector_managed_authority_outbox` (`managed_connection_id`,`scope_kind`,`subject_id`,`scope_version`);--> statement-breakpoint
CREATE INDEX `connector_managed_authority_claim_idx` ON `connector_managed_authority_outbox` (`state`,`next_attempt_at`,`leased_until`);--> statement-breakpoint
CREATE TABLE `connector_managed_authority_scopes` (
	`managed_connection_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`scope_version` integer NOT NULL,
	`last_command_id` text NOT NULL,
	`last_command_hash` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_managed_authority_scope_unique` ON `connector_managed_authority_scopes` (`managed_connection_id`,`scope_kind`,`subject_id`);--> statement-breakpoint
CREATE TABLE `connector_managed_receipt_recoveries` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `connector_usage_attempts`(`attempt_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connector_managed_receipt_recovery_due_idx` ON `connector_managed_receipt_recoveries` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `connector_managed_usage_mirrors` (
	`hosted_receipt_id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`completed_at` text,
	`recorded_at` text NOT NULL,
	`mirrored_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `connector_usage_attempts`(`attempt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_managed_usage_mirrors_attempt_id_unique` ON `connector_managed_usage_mirrors` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `connector_managed_usage_mirrors_recorded_idx` ON `connector_managed_usage_mirrors` (`recorded_at`);--> statement-breakpoint
DROP INDEX `connector_operation_revision_fingerprint_unique`;--> statement-breakpoint
ALTER TABLE `connector_operation_revisions` ADD `provider_revision_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `connector_operation_revision_fingerprint_unique` ON `connector_operation_revisions` (`provider_instance_id`,`toolkit`,`operation_slug`,`toolkit_version`,`schema_hash`,`capability_classification`,`retry_policy`,`provider_revision_ref`);