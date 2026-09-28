CREATE TABLE `session_limit_history` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`since` text NOT NULL,
	`runtime` text NOT NULL,
	`account_id` text,
	`window` text NOT NULL,
	`scope` text NOT NULL,
	`resets_at` text,
	`resolution` text NOT NULL,
	`resolved_at` text NOT NULL,
	`to_session_id` text,
	`to_account_id` text,
	`model_from` text,
	`model_to` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_limit_history_episode_idx` ON `session_limit_history` (`session_id`,`since`);--> statement-breakpoint
CREATE INDEX `session_limit_history_resolved_at_idx` ON `session_limit_history` (`resolved_at`);--> statement-breakpoint
ALTER TABLE `session_limits` ADD `model` text;