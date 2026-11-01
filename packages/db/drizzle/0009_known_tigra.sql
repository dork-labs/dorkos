CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text NOT NULL,
	`category` text NOT NULL,
	`event_type` text NOT NULL,
	`resource_type` text,
	`resource_id` text,
	`resource_label` text,
	`summary` text NOT NULL,
	`link_path` text,
	`metadata` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_occurred_at` ON `activity_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_category` ON `activity_events` (`category`);--> statement-breakpoint
CREATE INDEX `idx_activity_actor_type` ON `activity_events` (`actor_type`);