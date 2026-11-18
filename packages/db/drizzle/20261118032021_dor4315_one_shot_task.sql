ALTER TABLE `pulse_schedules` ADD `allow_list_pins` text;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `run_once` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `ran_once_at` text;