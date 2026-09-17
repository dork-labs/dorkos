CREATE TABLE `community_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`community_ref` text NOT NULL,
	`remote_room_id` text NOT NULL,
	`owner_author_id` text NOT NULL,
	`local_entry_id` text NOT NULL,
	`local_agent_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`remote_entry_id` text,
	`failure` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_outbox_local_entry_unique` ON `community_outbox` (`local_entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `community_outbox_ref_idempotency_unique` ON `community_outbox` (`community_ref`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_community_outbox_state_expiry` ON `community_outbox` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_community_outbox_ref_state` ON `community_outbox` (`community_ref`,`state`);