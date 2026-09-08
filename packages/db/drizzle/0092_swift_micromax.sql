CREATE TABLE `connector_event_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_instance_id` text NOT NULL,
	`provider_generation` integer NOT NULL,
	`external_account_ref` text NOT NULL,
	`definition_id` text NOT NULL,
	`filter_hash` text NOT NULL,
	`filter_json` text NOT NULL,
	`provider_trigger_ref` text,
	`provider_trigger_uuid` text,
	`external_account_uuid` text,
	`ownership` text DEFAULT 'borrowed' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`lease_owner` text,
	`leased_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`definition_id`) REFERENCES `connector_event_definitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_event_binding_scope_unique` ON `connector_event_bindings` (`provider_instance_id`,`provider_generation`,`external_account_ref`,`definition_id`,`filter_hash`);--> statement-breakpoint
CREATE INDEX `connector_event_binding_trigger_idx` ON `connector_event_bindings` (`provider_instance_id`,`provider_trigger_ref`);--> statement-breakpoint
CREATE TABLE `connector_event_consent_commands` (
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`review_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`selections_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_kind`, `owner_id`, `review_id`)
);
--> statement-breakpoint
CREATE TABLE `connector_event_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_instance_id` text NOT NULL,
	`toolkit` text NOT NULL,
	`event_type` text NOT NULL,
	`toolkit_version` text NOT NULL,
	`definition_hash` text NOT NULL,
	`provider_definition_ref` text DEFAULT '' NOT NULL,
	`definition_json` text NOT NULL,
	`current` integer DEFAULT true NOT NULL,
	`discovered_at` text NOT NULL,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connector_event_definitions_scope_idx` ON `connector_event_definitions` (`provider_instance_id`,`toolkit`,`event_type`);--> statement-breakpoint
CREATE TABLE `connector_event_provider_settings` (
	`provider_instance_id` text PRIMARY KEY NOT NULL,
	`webhook_secret_ref` text NOT NULL,
	`payload_key_ref` text NOT NULL,
	`public_endpoint` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_instance_id`) REFERENCES `connector_provider_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `connector_event_inbox` ADD `subscription_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_event_inbox` ADD `lease_boot_epoch` text;--> statement-breakpoint
ALTER TABLE `connector_event_subscriptions` ADD `definition_id` text REFERENCES connector_event_definitions(id);--> statement-breakpoint
ALTER TABLE `connector_event_subscriptions` ADD `binding_id` text REFERENCES connector_event_bindings(id);--> statement-breakpoint
ALTER TABLE `connector_event_subscriptions` ADD `scope_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `connector_event_subscriptions` ADD `revoked_at` text;