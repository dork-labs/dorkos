CREATE TABLE `heartbeat_beats` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`kind` text NOT NULL,
	`wake` text NOT NULL,
	`changes` text,
	`triage` text,
	`turn_session_id` text,
	`turn_usage` text,
	`outcome` text,
	`raises` integer DEFAULT 0 NOT NULL,
	`bypass` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`audit_seq` integer,
	CONSTRAINT "heartbeat_beats_kind" CHECK("heartbeat_beats"."kind" IN ('pulse', 'sweep', 'report'))
);
--> statement-breakpoint
CREATE INDEX `heartbeat_beats_agent_started_idx` ON `heartbeat_beats` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `heartbeat_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`beat_id` text NOT NULL,
	`to_account` text NOT NULL,
	`rung` text NOT NULL,
	`text` text NOT NULL,
	`key` text NOT NULL,
	`about` text,
	`urgent` integer DEFAULT 0 NOT NULL,
	`room_id` text,
	`deliver_after` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`delivered_entry_id` text,
	`created_at` text NOT NULL,
	`closed_at` text,
	CONSTRAINT "heartbeat_outbox_rung" CHECK("heartbeat_outbox"."rung" IN ('report', 'room', 'dm', 'note')),
	CONSTRAINT "heartbeat_outbox_state" CHECK("heartbeat_outbox"."state" IN ('held', 'delivered', 'dropped', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX `heartbeat_outbox_due_idx` ON `heartbeat_outbox` (`to_account`,`state`,`deliver_after`);--> statement-breakpoint
CREATE INDEX `heartbeat_outbox_key_idx` ON `heartbeat_outbox` (`key`);--> statement-breakpoint
CREATE TABLE `heartbeat_state` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`last_beat_at` text,
	`last_change_at` text,
	`gathered_through` text,
	`last_change_keys` text,
	`pace` text,
	`wake_again` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`beat_chat_id` text,
	`beat_chat_date` text,
	`frontmatter_hash` text,
	`last_valid_frontmatter` text,
	`last_report_at` text,
	`new_manager` integer DEFAULT 0 NOT NULL
);
