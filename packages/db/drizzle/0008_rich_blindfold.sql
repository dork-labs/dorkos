CREATE TABLE `a2a_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`history_json` text DEFAULT '[]' NOT NULL,
	`artifacts_json` text DEFAULT '[]' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
