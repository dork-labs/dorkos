ALTER TABLE `canvas_doc_channels` ADD `receipt_retention_floor` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_doc_events` ADD `envelope_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvas_doc_events` ADD `payload_pruned_at` text;--> statement-breakpoint
CREATE INDEX `canvas_doc_events_retention_idx` ON `canvas_doc_events` (`received_at`,`document_id`,`doc_seq`);--> statement-breakpoint
CREATE INDEX `canvas_doc_events_unaccounted_idx` ON `canvas_doc_events` (`document_id`,`event_id`) WHERE "canvas_doc_events"."envelope_bytes"=0 AND "canvas_doc_events"."payload_pruned_at" IS NULL;