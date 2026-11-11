CREATE TABLE `agent_identity_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`agent_path` text NOT NULL,
	`display_name` text NOT NULL,
	`tier_ceiling` text DEFAULT 'destructive' NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_agent_identity_agent_path` ON `agent_identity_tokens` (`agent_path`);