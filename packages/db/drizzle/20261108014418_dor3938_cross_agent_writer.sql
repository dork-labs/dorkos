ALTER TABLE `pulse_runs` ADD `creator_agent_path` text;--> statement-breakpoint
ALTER TABLE `pulse_runs` ADD `creator_session_id` text;--> statement-breakpoint
ALTER TABLE `pulse_runs` ADD `creator_marks` text;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `cross_agent_writer` text;