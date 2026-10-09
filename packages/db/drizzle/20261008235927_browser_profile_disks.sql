CREATE TABLE `browser_profile_disks` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`owner_author_id` text NOT NULL,
	`generation` text NOT NULL,
	`backend` text NOT NULL,
	`format_version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`,`owner_author_id`) REFERENCES `browser_profiles`(`profile_id`,`owner_author_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "browser_profile_disks_generation_shape" CHECK(length("browser_profile_disks"."generation") = 22 AND "browser_profile_disks"."generation" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "browser_profile_disks_backend" CHECK("browser_profile_disks"."backend" = 'qemu-hvf'),
	CONSTRAINT "browser_profile_disks_format" CHECK(typeof("browser_profile_disks"."format_version") = 'integer' AND "browser_profile_disks"."format_version" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_profile_disks_generation` ON `browser_profile_disks` (`generation`);