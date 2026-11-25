CREATE TABLE `turn_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`chat_seq` integer NOT NULL,
	`start_key` text,
	`chain_id` text NOT NULL,
	`asked_by_ref` text,
	`agent_id` text,
	`origin_json` text,
	`opened_by` text NOT NULL,
	`status` text NOT NULL,
	`wait_reason` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`attempt_reason` text DEFAULT 'initial' NOT NULL,
	`continues_run_id` text,
	`queue_message_id` text,
	`source_ref` text,
	`runtime` text,
	`runtime_turn_ref` integer,
	`turn_binding_id` text,
	`account_ref` text,
	`playbook_id` text,
	`owner_epoch` text,
	`lease_until` integer,
	`not_after` integer,
	`waiting_on_person` integer DEFAULT false NOT NULL,
	`ending` text,
	`ending_detail` text,
	`lost_background_json` text,
	`recovery_decided_at` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`delivered_at` text,
	`ended_at` text,
	`settled_at` text,
	CONSTRAINT "turn_runs_status" CHECK("turn_runs"."status" IN ('queued', 'starting', 'started', 'running', 'ended', 'settled', 'cancelled', 'superseded')),
	CONSTRAINT "turn_runs_opened_by" CHECK("turn_runs"."opened_by" IN ('caller', 'runtime', 'recovery')),
	CONSTRAINT "turn_runs_wait_reason" CHECK("turn_runs"."wait_reason" IS NULL OR "turn_runs"."wait_reason" IN ('chat_busy', 'agent_busy', 'machine_full', 'paused', 'held_after_restart')),
	CONSTRAINT "turn_runs_attempt_reason" CHECK("turn_runs"."attempt_reason" IN ('initial', 'restart')),
	CONSTRAINT "turn_runs_ending" CHECK("turn_runs"."ending" IS NULL OR "turn_runs"."ending" IN ('completed', 'failed', 'stopped', 'limited', 'refused', 'shutdown', 'process_died')),
	CONSTRAINT "turn_runs_attempt" CHECK("turn_runs"."attempt" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_runs_chat_seq_unique` ON `turn_runs` (`session_id`,`chat_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `turn_runs_start_key_unique` ON `turn_runs` (`start_key`) WHERE "start_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `turn_runs_continues_unique` ON `turn_runs` (`continues_run_id`) WHERE "continues_run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `turn_runs_one_live_per_chat` ON `turn_runs` (`session_id`) WHERE "status" IN ('starting', 'started', 'running');--> statement-breakpoint
CREATE INDEX `turn_runs_queue_message_idx` ON `turn_runs` (`queue_message_id`) WHERE "queue_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `turn_runs_lease_idx` ON `turn_runs` (`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `turn_runs_recovery_idx` ON `turn_runs` (`ending`,`recovery_decided_at`);--> statement-breakpoint
ALTER TABLE `session_message_queue` ADD `state` text DEFAULT 'waiting' NOT NULL;