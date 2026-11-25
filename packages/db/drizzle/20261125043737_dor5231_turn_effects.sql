CREATE TABLE `turn_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`run_id` text,
	`session_id` text,
	`payload_json` text NOT NULL,
	`delivery` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`available_at` integer NOT NULL,
	`not_after` integer,
	`lease_owner` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`created_at` text NOT NULL,
	`settled_at` text,
	CONSTRAINT "turn_effects_kind" CHECK("turn_effects"."kind" IN ('start_turn', 'deliver_room_handoff', 'report_to_parent', 'post_room_outcome', 'wake_chat', 'continue_after_restart', 'lost_work_wake', 'notify_person')),
	CONSTRAINT "turn_effects_delivery" CHECK("turn_effects"."delivery" IN ('repeatable', 'once')),
	CONSTRAINT "turn_effects_state" CHECK("turn_effects"."state" IN ('pending', 'leased', 'done', 'dropped', 'unknown', 'expired')),
	CONSTRAINT "turn_effects_follow_up_deadline" CHECK("turn_effects"."kind" = 'start_turn' OR "turn_effects"."not_after" IS NOT NULL),
	CONSTRAINT "turn_effects_lease" CHECK("turn_effects"."state" <> 'leased' OR ("turn_effects"."lease_owner" IS NOT NULL AND "turn_effects"."lease_until" IS NOT NULL)),
	CONSTRAINT "turn_effects_attempts" CHECK("turn_effects"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_effects_key_unique` ON `turn_effects` (`key`);--> statement-breakpoint
CREATE INDEX `turn_effects_due_idx` ON `turn_effects` (`state`,`available_at`);--> statement-breakpoint
CREATE INDEX `turn_effects_run_idx` ON `turn_effects` (`run_id`,`state`) WHERE "run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notifications_outbox_key` ON `notifications` (`dedupe_key`) WHERE substr("dedupe_key", 1, 7) = 'notify:';