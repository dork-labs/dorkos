PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_extension_connection_approvals` (
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
	CONSTRAINT "extension_connection_approvals_scope" CHECK("__new_extension_connection_approvals"."install_scope" IN ('global', 'local')),
	CONSTRAINT "extension_connection_approvals_origin" CHECK("__new_extension_connection_approvals"."install_origin" IN ('core', 'trusted_source', 'digest_pinned')),
	CONSTRAINT "extension_connection_approvals_origin_source" CHECK(("__new_extension_connection_approvals"."install_origin" = 'trusted_source') = ("__new_extension_connection_approvals"."origin_source" IS NOT NULL)),
	CONSTRAINT "extension_connection_approvals_origin_source_text" CHECK("__new_extension_connection_approvals"."origin_source" IS NULL OR trim("__new_extension_connection_approvals"."origin_source", ' ' || char(9) || char(10) || char(13)) <> ''),
	CONSTRAINT "extension_connection_approvals_extension_id" CHECK("__new_extension_connection_approvals"."extension_id" <> '' AND substr("__new_extension_connection_approvals"."extension_id", 1, 1) <> '-' AND "__new_extension_connection_approvals"."extension_id" NOT GLOB '*[^a-z0-9-]*' AND length(CAST("__new_extension_connection_approvals"."extension_id" AS BLOB)) = length("__new_extension_connection_approvals"."extension_id")),
	CONSTRAINT "extension_connection_approvals_digests" CHECK(trim("__new_extension_connection_approvals"."approved_files_digest", ' ' || char(9) || char(10) || char(13)) <> '' AND trim("__new_extension_connection_approvals"."approved_operations_digest", ' ' || char(9) || char(10) || char(13)) <> ''),
	CONSTRAINT "extension_connection_approvals_real_path" CHECK(substr("__new_extension_connection_approvals"."install_real_path", 1, 1) = '/' AND length(CAST("__new_extension_connection_approvals"."install_real_path" AS BLOB)) = length("__new_extension_connection_approvals"."install_real_path"))
);
--> statement-breakpoint
INSERT INTO `__new_extension_connection_approvals`("id", "extension_id", "install_scope", "install_real_path", "install_origin", "origin_source", "approved_files_digest", "approved_version", "service", "connection_id", "approved_operations_digest", "approved_by", "approved_at", "revoked_at") SELECT "id", "extension_id", "install_scope", "install_real_path", "install_origin", "origin_source", "approved_files_digest", "approved_version", "service", "connection_id", "approved_operations_digest", "approved_by", "approved_at", "revoked_at" FROM `extension_connection_approvals`;--> statement-breakpoint
DROP TABLE `extension_connection_approvals`;--> statement-breakpoint
ALTER TABLE `__new_extension_connection_approvals` RENAME TO `extension_connection_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `extension_connection_approvals_live_unique` ON `extension_connection_approvals` (`extension_id`,`install_scope`,`install_real_path`,`service`) WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX `extension_connection_approvals_connection_idx` ON `extension_connection_approvals` (`connection_id`);--> statement-breakpoint
DROP TRIGGER `connection_operation_grants_extension_subject_insert`;--> statement-breakpoint
DROP TRIGGER `connection_operation_grants_extension_subject_update`;--> statement-breakpoint
CREATE TRIGGER `connection_operation_grants_extension_subject_insert` BEFORE INSERT ON `connection_operation_grants` WHEN (NEW."subject_type" = 'extension' AND (NEW."extension_id" IS NULL OR NEW."agent_id" IS NOT NULL OR NEW."subject_id" IS NOT NEW."extension_id" OR NEW."extension_id" = '' OR substr(NEW."extension_id", 1, 1) = '-' OR NEW."extension_id" GLOB '*[^a-z0-9-]*' OR length(CAST(NEW."extension_id" AS BLOB)) <> length(NEW."extension_id"))) OR (NEW."subject_type" <> 'extension' AND NEW."extension_id" IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'connection_operation_grants: an extension grant names its extension in extension_id and nowhere else'); END;--> statement-breakpoint
CREATE TRIGGER `connection_operation_grants_extension_subject_update` BEFORE UPDATE ON `connection_operation_grants` WHEN (NEW."subject_type" = 'extension' AND (NEW."extension_id" IS NULL OR NEW."agent_id" IS NOT NULL OR NEW."subject_id" IS NOT NEW."extension_id" OR NEW."extension_id" = '' OR substr(NEW."extension_id", 1, 1) = '-' OR NEW."extension_id" GLOB '*[^a-z0-9-]*' OR length(CAST(NEW."extension_id" AS BLOB)) <> length(NEW."extension_id"))) OR (NEW."subject_type" <> 'extension' AND NEW."extension_id" IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'connection_operation_grants: an extension grant names its extension in extension_id and nowhere else'); END;--> statement-breakpoint
CREATE TRIGGER `connection_operation_grants_extension_read_only_insert` BEFORE INSERT ON `connection_operation_grants` WHEN NEW."subject_type" = 'extension' AND (SELECT `capability_classification` FROM `connector_operation_revisions` WHERE `id` = NEW."operation_revision_id") IS NOT 'read' BEGIN SELECT RAISE(ABORT, 'connection_operation_grants: an extension grant holds read operations only'); END;--> statement-breakpoint
CREATE TRIGGER `connection_operation_grants_extension_read_only_update` BEFORE UPDATE ON `connection_operation_grants` WHEN NEW."subject_type" = 'extension' AND (SELECT `capability_classification` FROM `connector_operation_revisions` WHERE `id` = NEW."operation_revision_id") IS NOT 'read' BEGIN SELECT RAISE(ABORT, 'connection_operation_grants: an extension grant holds read operations only'); END;
