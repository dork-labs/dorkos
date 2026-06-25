CREATE TABLE `pulse_dispatch_log` (
	`task_id` text NOT NULL,
	`scheduled_fire_time` integer NOT NULL,
	`dispatched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pulse_dispatch_log_task_tick` ON `pulse_dispatch_log` (`task_id`,`scheduled_fire_time`);