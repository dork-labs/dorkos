CREATE TABLE `owner_factors` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`sealed_secret` text,
	`last_step` integer,
	`credential_id` text,
	`public_key` text,
	`alg` integer,
	`sign_count` integer,
	`rp_id` text,
	`confirmed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`removed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `owner_factors_user_idx` ON `owner_factors` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `owner_factors_credential_idx` ON `owner_factors` (`credential_id`);--> statement-breakpoint
ALTER TABLE `session` ADD `last_active_at` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `wifi_agent_turns_at` integer;