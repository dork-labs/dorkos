DROP INDEX `connections_instance_external_ref_unique`;--> statement-breakpoint
ALTER TABLE `connections` ADD `removed_at` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `external_cleanup_state` text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `cleanup_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_instance_external_ref_unique` ON `connections` (`provider_instance_id`,`external_account_ref`) WHERE "connections"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE `connector_authentication_flows` ADD `cleanup_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `connector_managed_authority_outbox` ADD `cleanup_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- HAND-ADDED, one statement: drizzle-kit only writes schema DDL, and the new
-- `external_cleanup_state` column has to start out honest for rows that were
-- already disconnected before this migration ran. Nothing recorded whether
-- their external cleanup finished, so they are `unknown` rather than the
-- `not_required` default — which is what makes the recovery action in the UI
-- offer itself for exactly those historical rows.
UPDATE connections SET external_cleanup_state = 'unknown' WHERE lifecycle_state = 'disconnected';
