CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`capability_id` text NOT NULL,
	`capability_title` text NOT NULL,
	`tier` text DEFAULT 'destructive' NOT NULL,
	`input_hash` text NOT NULL,
	`summary` text NOT NULL,
	`requested_by` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`deny_reason` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`decided_at` text,
	`consumed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_token_hash_unique` ON `approvals` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_approvals_state` ON `approvals` (`state`);--> statement-breakpoint
CREATE INDEX `idx_approvals_expires_at` ON `approvals` (`expires_at`);