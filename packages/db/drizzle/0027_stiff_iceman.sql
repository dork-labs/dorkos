CREATE TABLE `opencode_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`oc_session_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opencode_sessions_oc_session_id_unique` ON `opencode_sessions` (`oc_session_id`);