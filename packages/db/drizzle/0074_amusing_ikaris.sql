ALTER TABLE `rooms` ADD `turn_limits_enabled` integer;--> statement-breakpoint
ALTER TABLE `rooms` ADD `max_agent_depth` integer;--> statement-breakpoint
ALTER TABLE `rooms` ADD `max_turns_per_agent_per_cascade` integer;--> statement-breakpoint
ALTER TABLE `rooms` ADD `max_auto_turns_per_hour` integer;