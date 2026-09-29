ALTER TABLE `session_metadata` ADD `launch_origin` text;--> statement-breakpoint
ALTER TABLE `session_limits` ADD `cwd` text;--> statement-breakpoint
ALTER TABLE `session_limits` ADD `model_fallback` text;--> statement-breakpoint
ALTER TABLE `session_limits` ADD `all_out` text;--> statement-breakpoint
ALTER TABLE `session_limits` ADD `claimed_by` text;