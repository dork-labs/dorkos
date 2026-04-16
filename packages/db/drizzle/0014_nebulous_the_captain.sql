CREATE TABLE `session_metadata` (
	`session_id` text PRIMARY KEY NOT NULL,
	`runtime` text NOT NULL,
	`agent_path` text,
	`created_at` integer NOT NULL
);
