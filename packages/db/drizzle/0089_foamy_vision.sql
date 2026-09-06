CREATE TABLE `connector_usage_terminal_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`outcome` text NOT NULL,
	`provider_log_id` text,
	`error_code` text,
	`source_outcome` text,
	`completed_at` text,
	`recorded_at` text NOT NULL,
	`provenance` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `connector_usage_attempts`(`attempt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_usage_terminal_receipts_attempt_id_unique` ON `connector_usage_terminal_receipts` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `connector_usage_receipts_recorded_idx` ON `connector_usage_terminal_receipts` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `connector_reconciliation_agents` (
	`preview_id` text NOT NULL,
	`agent_id` text NOT NULL,
	PRIMARY KEY(`preview_id`, `agent_id`),
	FOREIGN KEY (`preview_id`) REFERENCES `connector_reconciliation_previews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connector_reconciliation_agents_agent_idx` ON `connector_reconciliation_agents` (`agent_id`,`preview_id`);--> statement-breakpoint
CREATE TABLE `connector_reconciliation_candidates` (
	`preview_id` text NOT NULL,
	`operation_revision_id` text NOT NULL,
	`supported` integer NOT NULL,
	PRIMARY KEY(`preview_id`, `operation_revision_id`),
	FOREIGN KEY (`preview_id`) REFERENCES `connector_reconciliation_previews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_revision_id`) REFERENCES `connector_operation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connector_reconciliation_defaults` (
	`preview_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`operation_revision_id` text NOT NULL,
	PRIMARY KEY(`preview_id`, `agent_id`, `operation_revision_id`),
	FOREIGN KEY (`preview_id`) REFERENCES `connector_reconciliation_previews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_revision_id`) REFERENCES `connector_operation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connector_reconciliation_defaults_agent_idx` ON `connector_reconciliation_defaults` (`agent_id`,`preview_id`);--> statement-breakpoint
CREATE TABLE `connector_reconciliation_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider_instance_id` text NOT NULL,
	`boot_epoch` text NOT NULL,
	`execution_config_generation` integer NOT NULL,
	`complete_revision_set_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connector_reconciliation_previews_owner_state_idx` ON `connector_reconciliation_previews` (`owner_kind`,`owner_id`,`consumed_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `connector_reconciliation_previews_connection_idx` ON `connector_reconciliation_previews` (`connection_id`);--> statement-breakpoint
CREATE TABLE `connector_runtime_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`boot_epoch` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`runtime` text NOT NULL,
	`canonical_session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_path` text NOT NULL,
	`canonical_cwd` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`revoke_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_runtime_bindings_token_hash_unique` ON `connector_runtime_bindings` (`token_hash`);--> statement-breakpoint
CREATE INDEX `connector_runtime_bindings_agent_idx` ON `connector_runtime_bindings` (`agent_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `connector_runtime_bindings_session_idx` ON `connector_runtime_bindings` (`canonical_session_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `connector_runtime_bindings_expiry_idx` ON `connector_runtime_bindings` (`boot_epoch`,`revoked_at`,`expires_at`);--> statement-breakpoint
DROP INDEX `connector_operation_revision_fingerprint_unique`;--> statement-breakpoint
ALTER TABLE `connector_operation_revisions` ADD `retry_policy` text DEFAULT 'never' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `connector_operation_revision_fingerprint_unique` ON `connector_operation_revisions` (`provider_instance_id`,`toolkit`,`operation_slug`,`toolkit_version`,`schema_hash`,`capability_classification`,`retry_policy`);--> statement-breakpoint
ALTER TABLE `approvals` ADD `authority_binding_digest` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connector_owner_kind` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connector_owner_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connector_agent_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connector_session_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connector_connection_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connector_operation_revision_id` text;--> statement-breakpoint
CREATE INDEX `approvals_connector_agent_connection_idx` ON `approvals` (`connector_agent_id`,`connector_connection_id`,`consumed_at`);--> statement-breakpoint
ALTER TABLE `connector_provider_instances` ADD `execution_config_digest` text;--> statement-breakpoint
ALTER TABLE `connector_provider_instances` ADD `execution_config_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_provider_instances` ADD `owner_kind` text;--> statement-breakpoint
ALTER TABLE `connector_provider_instances` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `owner_kind` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `provider_instance_id` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `execution_config_generation` integer;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `authority_binding_digest` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `action_hash` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `review_context_json` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `resolution_json` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `authority_revoked_at` text;--> statement-breakpoint
ALTER TABLE `connector_review_requests` ADD `authority_revoke_reason` text;--> statement-breakpoint
CREATE INDEX `connector_review_requests_owner_state_idx` ON `connector_review_requests` (`owner_kind`,`owner_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `connector_review_requests_agent_connection_idx` ON `connector_review_requests` (`agent_id`,`connection_id`);--> statement-breakpoint
ALTER TABLE `connector_usage_attempts` ADD `owner_kind` text;--> statement-breakpoint
ALTER TABLE `connector_usage_attempts` ADD `owner_id` text;--> statement-breakpoint
INSERT INTO `connector_usage_terminal_receipts`
  (`receipt_id`, `attempt_id`, `outcome`, `provider_log_id`, `error_code`, `source_outcome`, `completed_at`, `recorded_at`, `provenance`)
SELECT
  'migrated-p1:' || `attempt_id`,
  `attempt_id`,
  CASE `outcome`
    WHEN 'success' THEN 'success'
    WHEN 'error' THEN 'error'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'outcome_unknown' THEN 'outcome_unknown'
    WHEN 'unsupported' THEN 'unsupported'
    ELSE 'outcome_unknown'
  END,
  `provider_log_id`,
  `error_code`,
  CASE
    WHEN `outcome` IN ('success', 'error', 'cancelled', 'outcome_unknown', 'unsupported') THEN NULL
    ELSE `outcome`
  END,
  `completed_at`,
  COALESCE(`completed_at`, `started_at`),
  'migrated_p1'
FROM `connector_usage_attempts`;--> statement-breakpoint
ALTER TABLE `connector_usage_attempts` DROP COLUMN `outcome`;--> statement-breakpoint
ALTER TABLE `connector_usage_attempts` DROP COLUMN `provider_log_id`;--> statement-breakpoint
ALTER TABLE `connector_usage_attempts` DROP COLUMN `completed_at`;--> statement-breakpoint
ALTER TABLE `connector_usage_attempts` DROP COLUMN `error_code`;--> statement-breakpoint
CREATE TRIGGER `connector_usage_terminal_receipts_append_only_update`
BEFORE UPDATE ON `connector_usage_terminal_receipts`
BEGIN
	SELECT RAISE(ABORT, 'connector usage terminal receipts are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `connector_usage_terminal_receipts_append_only_delete`
BEFORE DELETE ON `connector_usage_terminal_receipts`
BEGIN
	SELECT RAISE(ABORT, 'connector usage terminal receipts are append-only');
END;
