CREATE TABLE `agent_browser_profile_agents` (
	`profile_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`signature` text NOT NULL,
	PRIMARY KEY(`profile_id`, `agent_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `agent_browser_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_browser_profile_agents_agent` ON `agent_browser_profile_agents` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_browser_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL
);
