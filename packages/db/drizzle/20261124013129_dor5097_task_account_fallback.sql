ALTER TABLE `pulse_runs` ADD `account_move` text;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `account_pinned` integer DEFAULT false NOT NULL;