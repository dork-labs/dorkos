CREATE TABLE `agent_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`cwd` text,
	`state` text NOT NULL,
	`outcome` text,
	`note` text,
	`session_id` text,
	`account_id` text,
	`added_by` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	CONSTRAINT "agent_work_items_state" CHECK("agent_work_items"."state" IN ('queued', 'starting', 'running', 'ended')),
	CONSTRAINT "agent_work_items_title_length" CHECK(length("agent_work_items"."title") <= 80)
);
--> statement-breakpoint
CREATE INDEX `agent_work_items_agent_state_idx` ON `agent_work_items` (`agent_id`,`state`,`position`);--> statement-breakpoint
CREATE INDEX `agent_work_items_session_idx` ON `agent_work_items` (`session_id`);--> statement-breakpoint
CREATE TABLE `agent_work_queues` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`target` integer DEFAULT 1 NOT NULL,
	`daily_start_cap` integer DEFAULT 20 NOT NULL,
	`starts_day` text,
	`starts_today` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_queue_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`stopped` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "work_queue_control_one_row" CHECK("work_queue_control"."id" = 1)
);
