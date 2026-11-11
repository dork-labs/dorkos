ALTER TABLE `pulse_schedules` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `max_runtime` integer;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `permission_mode` text DEFAULT 'acceptEdits' NOT NULL;