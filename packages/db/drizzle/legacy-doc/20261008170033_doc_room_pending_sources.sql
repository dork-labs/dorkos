CREATE TABLE `canvas_doc_room_pending_sources` (
 `document_id` text NOT NULL,
 `batch_id` text NOT NULL,
 `generation` text NOT NULL,
 `source_json` text NOT NULL,
 `source_hash` text NOT NULL,
 `due_at` text NOT NULL,
 `updated_at` text NOT NULL,
 PRIMARY KEY(`document_id`, `batch_id`, `generation`),
 FOREIGN KEY (`batch_id`) REFERENCES `canvas_doc_batches`(`batch_id`) ON UPDATE no action ON DELETE cascade
);
