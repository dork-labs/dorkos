CREATE TABLE `browser_attachments` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`owner_author_id` text NOT NULL,
	`browser_id` text NOT NULL,
	`browser_generation` integer NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`room_id` text,
	`attached_at` text NOT NULL,
	`detached_at` text,
	FOREIGN KEY (`owner_author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`browser_id`,`owner_author_id`,`browser_generation`) REFERENCES `browser_instances`(`browser_id`,`owner_author_id`,`browser_generation`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "browser_attachments_target" CHECK(("browser_attachments"."kind" = 'session' AND "browser_attachments"."session_id" IS NOT NULL AND "browser_attachments"."room_id" IS NULL) OR ("browser_attachments"."kind" = 'room' AND "browser_attachments"."room_id" IS NOT NULL AND "browser_attachments"."session_id" IS NULL)),
	CONSTRAINT "browser_attachments_generation" CHECK(typeof("browser_attachments"."browser_generation") = 'integer' AND "browser_attachments"."browser_generation" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "browser_attachments_revision" CHECK(typeof("browser_attachments"."revision") = 'integer' AND "browser_attachments"."revision" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_attachments_session` ON `browser_attachments` (`browser_id`,`browser_generation`,`session_id`) WHERE "browser_attachments"."detached_at" IS NULL AND "browser_attachments"."kind" = 'session';--> statement-breakpoint
CREATE UNIQUE INDEX `browser_attachments_room` ON `browser_attachments` (`browser_id`,`browser_generation`,`room_id`) WHERE "browser_attachments"."detached_at" IS NULL AND "browser_attachments"."kind" = 'room';--> statement-breakpoint
CREATE TABLE `browser_instances` (
	`browser_id` text PRIMARY KEY NOT NULL,
	`owner_author_id` text NOT NULL,
	`profile_id` text,
	`mode` text NOT NULL,
	`browser_generation` integer NOT NULL,
	`revision` integer NOT NULL,
	`metadata_version` integer NOT NULL,
	`status` text NOT NULL,
	`boot_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`profile_id`,`owner_author_id`) REFERENCES `browser_profiles`(`profile_id`,`owner_author_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "browser_instances_mode_profile" CHECK(("browser_instances"."mode" = 'persistent' AND "browser_instances"."profile_id" IS NOT NULL) OR ("browser_instances"."mode" = 'ephemeral' AND "browser_instances"."profile_id" IS NULL)),
	CONSTRAINT "browser_instances_generation" CHECK(typeof("browser_instances"."browser_generation") = 'integer' AND "browser_instances"."browser_generation" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "browser_instances_revision" CHECK(typeof("browser_instances"."revision") = 'integer' AND "browser_instances"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "browser_instances_version" CHECK("browser_instances"."metadata_version" = 1),
	CONSTRAINT "browser_instances_status" CHECK("browser_instances"."status" IN ('opening', 'running', 'stopping', 'stopped', 'uncertain'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_instances_owner_identity` ON `browser_instances` (`browser_id`,`owner_author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_instances_generation_identity` ON `browser_instances` (`browser_id`,`owner_author_id`,`browser_generation`);--> statement-breakpoint
CREATE INDEX `browser_instances_owner` ON `browser_instances` (`owner_author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_instances_reserved_profile` ON `browser_instances` (`profile_id`) WHERE "browser_instances"."status" IN ('opening', 'running', 'stopping', 'uncertain');--> statement-breakpoint
CREATE TABLE `browser_profiles` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`owner_author_id` text NOT NULL,
	`label` text NOT NULL,
	`mode` text NOT NULL,
	`metadata_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "browser_profiles_mode" CHECK("browser_profiles"."mode" = 'persistent'),
	CONSTRAINT "browser_profiles_version" CHECK("browser_profiles"."metadata_version" = 1),
	CONSTRAINT "browser_profiles_revision" CHECK(typeof("browser_profiles"."revision") = 'integer' AND "browser_profiles"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "browser_profiles_status" CHECK("browser_profiles"."status" IN ('available', 'inUse', 'quarantined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_profiles_owner_identity` ON `browser_profiles` (`profile_id`,`owner_author_id`);--> statement-breakpoint
CREATE INDEX `browser_profiles_owner` ON `browser_profiles` (`owner_author_id`);