CREATE TABLE `session_events` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `session_events_session_idx` ON `session_events` (`session_id`,`seq`);