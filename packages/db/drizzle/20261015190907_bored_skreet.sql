CREATE TABLE `canvas_doc_file_save_intents` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`event_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`incarnation` text NOT NULL,
	`source` text NOT NULL,
	`owner` text NOT NULL,
	`canonical_path` text NOT NULL,
	`before_device` text NOT NULL,
	`before_inode` text NOT NULL,
	`before_hash` text NOT NULL,
	`after_hash` text NOT NULL,
	`replacement_device` text,
	`replacement_inode` text,
	`status` text NOT NULL,
	`doc_seq` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `canvas_doc_channels`(`document_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "canvas_doc_file_save_status_valid" CHECK("status" in ('prepared','staged','committed','no_op','in_doubt','failed')),
	CONSTRAINT "canvas_doc_file_save_sequence_valid" CHECK(("status" = 'committed' AND "doc_seq" IS NOT NULL AND "doc_seq" > 0) OR ("status" != 'committed' AND "doc_seq" IS NULL)),
	CONSTRAINT "canvas_doc_file_save_replacement_pair" CHECK(("replacement_device" IS NULL) = ("replacement_inode" IS NULL)),
	CONSTRAINT "canvas_doc_file_save_replacement_phase" CHECK(("status" NOT IN ('staged','committed') OR "replacement_inode" IS NOT NULL) AND ("status" NOT IN ('prepared','no_op','failed') OR "replacement_inode" IS NULL)),
	CONSTRAINT "canvas_doc_file_save_noop_valid" CHECK("status" != 'no_op' OR "before_hash" = "after_hash")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_file_save_intents_event_unique` ON `canvas_doc_file_save_intents` (`document_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `canvas_doc_file_save_intents_recovery_idx` ON `canvas_doc_file_save_intents` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_file_save_intents_active_path_unique` ON `canvas_doc_file_save_intents` (`canonical_path`) WHERE "status" in ('prepared', 'staged', 'in_doubt');