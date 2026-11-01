ALTER TABLE `pulse_schedules` ADD `file_enabled` integer;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `offers_turn_on` integer DEFAULT false NOT NULL;