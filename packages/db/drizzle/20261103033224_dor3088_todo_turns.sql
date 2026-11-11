CREATE TABLE `todo_person_asks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`todo_id` text NOT NULL,
	`day` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_person_asks_agent_day_idx` ON `todo_person_asks` (`agent_id`,`day`);--> statement-breakpoint
CREATE TABLE `todo_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`charged_to` text,
	`status` text NOT NULL,
	`reason` text,
	`day` text NOT NULL,
	`session_id` text,
	`created_at` text NOT NULL,
	`started_at` text,
	CONSTRAINT "todo_turns_status" CHECK("todo_turns"."status" IN ('started', 'queued', 'retry', 'held'))
);
--> statement-breakpoint
CREATE INDEX `todo_turns_charge_day_idx` ON `todo_turns` (`charged_to`,`day`,`status`);--> statement-breakpoint
CREATE INDEX `todo_turns_todo_idx` ON `todo_turns` (`todo_id`);--> statement-breakpoint
CREATE INDEX `todo_turns_status_idx` ON `todo_turns` (`status`,`day`);--> statement-breakpoint
CREATE INDEX `todo_turns_session_idx` ON `todo_turns` (`session_id`);