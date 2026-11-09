-- Context viewer phase 1 (Record): what each turn actually handed its runtime. Three new tables,
-- no change to any existing one.
-- A build without this migration ignores these tables, so it never sweeps them: recorded text stays
-- unswept, with no 30-day limit, until you upgrade again or run the down-migration
-- (packages/db/src/down/20261109151737_turn_context.down.sql).
CREATE TABLE `turn_context_bodies` (
	`hash` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn_context_parts` (
	`turn_context_id` text NOT NULL,
	`position` integer NOT NULL,
	`slot` text NOT NULL,
	`body_hash` text NOT NULL,
	`bytes` integer NOT NULL,
	`tokens_estimate` integer NOT NULL,
	`redacted` integer NOT NULL,
	PRIMARY KEY(`turn_context_id`, `position`),
	FOREIGN KEY (`turn_context_id`) REFERENCES `turn_contexts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_turn_context_parts_hash` ON `turn_context_parts` (`body_hash`);--> statement-breakpoint
CREATE TABLE `turn_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text,
	`runtime` text NOT NULL,
	`place` text NOT NULL,
	`permission_mode` text,
	`system_sent_this_turn` integer NOT NULL,
	`usage` text,
	`usage_kind` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_turn_contexts_session` ON `turn_contexts` (`session_id`,`created_at`);