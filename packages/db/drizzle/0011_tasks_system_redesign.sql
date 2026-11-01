-- Tasks System Redesign: add file_path and tags_json to pulse_schedules, add is_system to agents.
-- Alpha project — drop existing schedules and runs (no backfill needed).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DELETE FROM `pulse_runs`;--> statement-breakpoint
DELETE FROM `pulse_schedules`;--> statement-breakpoint
CREATE TABLE `__new_pulse_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cron` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`prompt` text NOT NULL,
	`cwd` text,
	`agent_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`max_runtime` integer,
	`permission_mode` text DEFAULT 'acceptEdits' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`file_path` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `pulse_schedules`;--> statement-breakpoint
ALTER TABLE `__new_pulse_schedules` RENAME TO `pulse_schedules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `agents` ADD `is_system` integer DEFAULT false NOT NULL;
