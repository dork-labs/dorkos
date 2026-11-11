CREATE TABLE `work_queue_item_authority` (
	`item_id` text PRIMARY KEY NOT NULL,
	`author_agent_id` text,
	`author_session_id` text,
	`requested_level` text,
	`first_run_level` text,
	FOREIGN KEY (`item_id`) REFERENCES `agent_work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agent_work_queues` ADD `daily_cap_ceiling` integer DEFAULT 20 NOT NULL;
--> statement-breakpoint
UPDATE `agent_work_queues` SET `daily_cap_ceiling` = `daily_start_cap`;
