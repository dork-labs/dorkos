ALTER TABLE `canvas_doc_channels` ADD `receipt_retention_floor` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_doc_events` ADD `envelope_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_doc_events` ADD `payload_pruned_at` text;