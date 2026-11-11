PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_remote_command_journal` (
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
	CONSTRAINT "remote_command_journal_verb" CHECK("__new_remote_command_journal"."verb" IN ('open', 'close', 'rotate', 'revoke', 'inbox_pending', 'viewer_open', 'hub_assignment_changed')),
	CONSTRAINT "remote_command_journal_ack_state" CHECK("__new_remote_command_journal"."ack_state" IN ('pending', 'acked', 'rejected', 'unconfirmed'))
);
--> statement-breakpoint
INSERT INTO `__new_remote_command_journal`("command_id", "lease_token", "verb", "instance_id", "outcome", "ack_state", "ack_attempts", "received_at", "settled_at", "acked_at") SELECT "command_id", "lease_token", "verb", "instance_id", "outcome", "ack_state", "ack_attempts", "received_at", "settled_at", "acked_at" FROM `remote_command_journal`;--> statement-breakpoint
DROP TABLE `remote_command_journal`;--> statement-breakpoint
ALTER TABLE `__new_remote_command_journal` RENAME TO `remote_command_journal`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `remote_command_journal_ack_idx` ON `remote_command_journal` (`ack_state`,`received_at`);