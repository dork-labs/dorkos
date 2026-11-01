CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`to_account` text,
	`what` text NOT NULL,
	`due_at` text,
	`state` text NOT NULL,
	`source_session_id` text,
	`source_room_entry_id` text,
	`created_at` text NOT NULL,
	`due_notified_at` text,
	`closed_at` text,
	`note` text,
	CONSTRAINT "commitments_state" CHECK("commitments"."state" IN ('open', 'kept', 'missed', 'dropped')),
	CONSTRAINT "commitments_what_length" CHECK(length("commitments"."what") <= 300)
);
--> statement-breakpoint
CREATE INDEX `commitments_agent_state_idx` ON `commitments` (`agent_id`,`state`);--> statement-breakpoint
CREATE INDEX `commitments_due_idx` ON `commitments` (`due_at`);