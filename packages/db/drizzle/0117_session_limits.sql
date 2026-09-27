CREATE TABLE `session_limits` (
	`session_id` text PRIMARY KEY NOT NULL,
	`since` text NOT NULL,
	`window` text NOT NULL,
	`scope` text NOT NULL,
	`resets_at` text,
	`account_id` text,
	`account_path` text,
	`plan` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
