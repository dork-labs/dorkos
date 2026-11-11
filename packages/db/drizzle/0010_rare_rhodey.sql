-- Make pulse_schedules.cron nullable (tasks can be on-demand without a schedule)
-- Must drop pulse_runs first since it has FK to pulse_schedules
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `pulse_runs`;--> statement-breakpoint
CREATE TABLE `__new_pulse_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cron` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`prompt` text NOT NULL,
	`cwd` text,
	`agent_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`max_runtime` integer,
	`permission_mode` text DEFAULT 'acceptEdits' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_pulse_schedules`("id", "name", "description", "cron", "timezone", "prompt", "cwd", "agent_id", "enabled", "max_runtime", "permission_mode", "status", "created_at", "updated_at") SELECT "id", "name", "description", "cron", "timezone", "prompt", "cwd", "agent_id", "enabled", "max_runtime", "permission_mode", "status", "created_at", "updated_at" FROM `pulse_schedules`;--> statement-breakpoint
DROP TABLE `pulse_schedules`;--> statement-breakpoint
ALTER TABLE `__new_pulse_schedules` RENAME TO `pulse_schedules`;--> statement-breakpoint
CREATE TABLE `pulse_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL REFERENCES `pulse_schedules`(`id`),
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`output` text,
	`error` text,
	`session_id` text,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
PRAGMA foreign_keys=ON;
