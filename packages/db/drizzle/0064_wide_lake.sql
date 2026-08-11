CREATE TABLE `session_message_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`disposition` text NOT NULL,
	`client_id` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`context_json` text
);
--> statement-breakpoint
CREATE INDEX `session_message_queue_session_idx` ON `session_message_queue` (`session_id`,`position`);