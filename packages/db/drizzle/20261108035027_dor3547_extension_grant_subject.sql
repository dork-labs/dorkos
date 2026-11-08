CREATE TABLE `extension_connection_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`install_scope` text NOT NULL,
	`install_real_path` text NOT NULL,
	`install_origin` text NOT NULL,
	`origin_source` text,
	`approved_files_digest` text NOT NULL,
	`approved_version` text NOT NULL,
	`service` text NOT NULL,
	`connection_id` text NOT NULL,
	`approved_operations_digest` text NOT NULL,
	`approved_by` text NOT NULL,
	`approved_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "extension_connection_approvals_scope" CHECK("extension_connection_approvals"."install_scope" IN ('global', 'local')),
	CONSTRAINT "extension_connection_approvals_origin" CHECK("extension_connection_approvals"."install_origin" IN ('core', 'trusted_source', 'digest_pinned')),
	CONSTRAINT "extension_connection_approvals_origin_source" CHECK(("extension_connection_approvals"."install_origin" = 'trusted_source') = ("extension_connection_approvals"."origin_source" IS NOT NULL)),
	CONSTRAINT "extension_connection_approvals_extension_id" CHECK("extension_connection_approvals"."extension_id" <> '' AND substr("extension_connection_approvals"."extension_id", 1, 1) <> '-' AND "extension_connection_approvals"."extension_id" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "extension_connection_approvals_digests" CHECK("extension_connection_approvals"."approved_files_digest" <> '' AND "extension_connection_approvals"."approved_operations_digest" <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extension_connection_approvals_live_unique` ON `extension_connection_approvals` (`extension_id`,`install_scope`,`install_real_path`,`service`) WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX `extension_connection_approvals_connection_idx` ON `extension_connection_approvals` (`connection_id`);--> statement-breakpoint
ALTER TABLE `connection_operation_grants` ADD `extension_id` text;--> statement-breakpoint
CREATE INDEX `connection_operation_grants_extension_idx` ON `connection_operation_grants` (`extension_id`);--> statement-breakpoint
ALTER TABLE `connector_usage_attempts` ADD `arguments_hash` text;--> statement-breakpoint
CREATE TRIGGER `connection_operation_grants_extension_subject_insert` BEFORE INSERT ON `connection_operation_grants` WHEN (NEW."subject_type" = 'extension' AND (NEW."extension_id" IS NULL OR NEW."agent_id" IS NOT NULL OR NEW."subject_id" IS NOT NEW."extension_id" OR NEW."extension_id" = '' OR substr(NEW."extension_id", 1, 1) = '-' OR NEW."extension_id" GLOB '*[^a-z0-9-]*')) OR (NEW."subject_type" <> 'extension' AND NEW."extension_id" IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'connection_operation_grants: an extension grant names its extension in extension_id and nowhere else'); END;--> statement-breakpoint
CREATE TRIGGER `connection_operation_grants_extension_subject_update` BEFORE UPDATE ON `connection_operation_grants` WHEN (NEW."subject_type" = 'extension' AND (NEW."extension_id" IS NULL OR NEW."agent_id" IS NOT NULL OR NEW."subject_id" IS NOT NEW."extension_id" OR NEW."extension_id" = '' OR substr(NEW."extension_id", 1, 1) = '-' OR NEW."extension_id" GLOB '*[^a-z0-9-]*')) OR (NEW."subject_type" <> 'extension' AND NEW."extension_id" IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'connection_operation_grants: an extension grant names its extension in extension_id and nowhere else'); END;