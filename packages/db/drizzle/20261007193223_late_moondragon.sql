PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_browser_profiles` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`owner_author_id` text NOT NULL,
	`label` text NOT NULL,
	`mode` text NOT NULL,
	`metadata_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`import_state` text DEFAULT 'none' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "browser_profiles_mode" CHECK("__new_browser_profiles"."mode" = 'persistent'),
	CONSTRAINT "browser_profiles_version" CHECK("__new_browser_profiles"."metadata_version" = 1),
	CONSTRAINT "browser_profiles_revision" CHECK(typeof("__new_browser_profiles"."revision") = 'integer' AND "__new_browser_profiles"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "browser_profiles_import_state" CHECK("__new_browser_profiles"."import_state" IN ('none', 'pending', 'failed', 'ready')),
	CONSTRAINT "browser_profiles_status" CHECK("__new_browser_profiles"."status" IN ('available', 'inUse', 'quarantined'))
);
--> statement-breakpoint
INSERT INTO `__new_browser_profiles`("profile_id", "owner_author_id", "label", "mode", "metadata_version", "revision", "status", "import_state", "created_at", "updated_at") SELECT "profile_id", "owner_author_id", "label", "mode", "metadata_version", "revision", "status", "import_state", "created_at", "updated_at" FROM `browser_profiles`;--> statement-breakpoint
DROP TABLE `browser_profiles`;--> statement-breakpoint
ALTER TABLE `__new_browser_profiles` RENAME TO `browser_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_profiles_owner_identity` ON `browser_profiles` (`profile_id`,`owner_author_id`);--> statement-breakpoint
CREATE INDEX `browser_profiles_owner` ON `browser_profiles` (`owner_author_id`);