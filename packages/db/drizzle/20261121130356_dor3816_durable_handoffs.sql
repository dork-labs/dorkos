CREATE TABLE `room_handoff_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`room_id` text NOT NULL,
	`envelope_json` text NOT NULL,
	`draft` text NOT NULL,
	`origin_json` text NOT NULL,
	`reply_to` text,
	`verbatim` integer NOT NULL,
	`enqueued_at` integer NOT NULL,
	`wait_deadline_at` integer NOT NULL,
	`state` text NOT NULL,
	`boot_owner` text,
	`dispatch_id` text,
	`posted_entry_id` text,
	`posted_seq` integer,
	`settled_at` integer,
	`terminal_reason` text,
	`notice_state` text NOT NULL,
	`notice_receipt_id` text,
	`notice_text` text,
	`notice_skip_reason` text,
	`notice_room_entry_id` text,
	`notice_room_seq` integer
);
--> statement-breakpoint
CREATE INDEX `idx_room_handoff_replay` ON `room_handoff_outbox` (`state`,`enqueued_at`);--> statement-breakpoint
CREATE INDEX `idx_room_handoff_notice` ON `room_handoff_outbox` (`notice_state`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_room_handoff_posted_entry` ON `room_handoff_outbox` (`room_id`,`posted_entry_id`);--> statement-breakpoint
CREATE TABLE `room_report_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`parent_session_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`state` text NOT NULL,
	`enqueued_at` integer NOT NULL,
	`wait_deadline_at` integer,
	`boot_owner` text,
	`terminal_reason` text,
	`settled_at` integer,
	`notice_state` text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_room_report_recovery` ON `room_report_outbox` (`state`,`enqueued_at`);--> statement-breakpoint
CREATE INDEX `idx_room_report_source` ON `room_report_outbox` (`source_session_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_room_report_notice` ON `room_report_outbox` (`notice_state`);