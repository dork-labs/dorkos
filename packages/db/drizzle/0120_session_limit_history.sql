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
ALTER TABLE `session_limits` ADD `model` text;--> statement-breakpoint
-- A limit live during the upgrade has no recorded model. Take the session's
-- current choice ('' = the runtime's default, as the store writes it), or its
-- next turn would read NULL -> 'opus' as a model switch when it only waited.
UPDATE `session_limits` SET `model` = COALESCE((SELECT `model` FROM `session_metadata` WHERE `session_metadata`.`session_id` = `session_limits`.`session_id`), '');
