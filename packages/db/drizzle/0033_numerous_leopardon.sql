CREATE TABLE `approval_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_path` text NOT NULL,
	`capability_id` text NOT NULL,
	`granted_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`granted_by` text NOT NULL,
	`posture` text NOT NULL,
	`source_approval_id` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_approval_grants_agent_capability` ON `approval_grants` (`agent_path`,`capability_id`);--> statement-breakpoint
CREATE INDEX `idx_approval_grants_expires_at` ON `approval_grants` (`expires_at`);--> statement-breakpoint
ALTER TABLE `approvals` ADD `requested_by_path` text;