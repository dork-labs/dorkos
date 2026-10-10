CREATE TABLE `remote_command_journal` (
	`command_id` text PRIMARY KEY NOT NULL,
	`lease_token` text NOT NULL,
	`verb` text NOT NULL,
	`instance_id` text NOT NULL,
	`outcome` text,
	`ack_state` text DEFAULT 'pending' NOT NULL,
	`ack_attempts` integer DEFAULT 0 NOT NULL,
	`received_at` text NOT NULL,
	`settled_at` text,
	`acked_at` text,
	CONSTRAINT "remote_command_journal_verb" CHECK("remote_command_journal"."verb" IN ('open', 'close', 'rotate', 'revoke', 'inbox_pending')),
	CONSTRAINT "remote_command_journal_ack_state" CHECK("remote_command_journal"."ack_state" IN ('pending', 'acked', 'rejected', 'unconfirmed'))
);
--> statement-breakpoint
CREATE INDEX `remote_command_journal_ack_idx` ON `remote_command_journal` (`ack_state`,`received_at`);--> statement-breakpoint
CREATE TABLE `remote_event_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`instance_id` text NOT NULL,
	`batch` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`last_attempt_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_event_outbox_idempotency_key_unique` ON `remote_event_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `remote_event_outbox_created_idx` ON `remote_event_outbox` (`created_at`);