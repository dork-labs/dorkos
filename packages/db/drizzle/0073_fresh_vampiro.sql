CREATE TABLE `session_staged_context` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_staged_context_session_idx` ON `session_staged_context` (`session_id`,`position`);