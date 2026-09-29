CREATE TABLE `session_started_by` (
	`session_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`extension_id` text,
	`started_by_session_id` text,
	`origin_extension_id` text,
	`reason` text,
	`carried` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "session_started_by_kind" CHECK("session_started_by"."kind" IN ('extension', 'chat'))
);
--> statement-breakpoint
CREATE INDEX `session_started_by_origin_created_idx` ON `session_started_by` (`origin_extension_id`,`created_at`);