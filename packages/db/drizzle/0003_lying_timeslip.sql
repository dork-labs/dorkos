ALTER TABLE `agents` ADD `scan_root` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `behavior_json` text DEFAULT '{"responseMode":"always"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `budget_json` text DEFAULT '{"maxHopsPerMessage":5,"maxCallsPerHour":100}' NOT NULL;