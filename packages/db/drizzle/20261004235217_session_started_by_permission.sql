ALTER TABLE `session_started_by` ADD `permission_mode` text;--> statement-breakpoint
ALTER TABLE `session_started_by` ADD `starter_permission_mode` text;--> statement-breakpoint
ALTER TABLE `session_started_by` ADD `permission_same_as_starter` integer;