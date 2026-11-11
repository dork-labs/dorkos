CREATE TABLE `agent_pauses` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`paused_by` text NOT NULL,
	`paused_by_kind` text NOT NULL,
	`paused_by_name` text NOT NULL,
	`paused_at` text NOT NULL,
	`reason` text
);
