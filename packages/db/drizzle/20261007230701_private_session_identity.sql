CREATE TABLE `session_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`cwd` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_locations_owner_cwd` ON `session_locations` (`owner_id`,`cwd`);--> statement-breakpoint
CREATE TABLE `session_native_bindings` (
	`session_id` text PRIMARY KEY NOT NULL,
	`runtime` text NOT NULL,
	`cwd` text NOT NULL,
	`account` text,
	`created_at` text NOT NULL
);
