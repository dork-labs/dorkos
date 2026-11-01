CREATE TABLE `connected_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`toolkit` text NOT NULL,
	`label` text NOT NULL,
	`custody` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connected_accounts_provider_idx` ON `connected_accounts` (`provider`);