CREATE TABLE `canvas_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`room_id` text NOT NULL,
	`content` text NOT NULL,
	`title` text NOT NULL,
	`content_type` text NOT NULL,
	`author_id` text NOT NULL,
	`source_key` text,
	`source_label` text,
	`resolved_cwd` text,
	`tree_kind` text,
	`ahead_of_main` integer,
	`pinned` integer DEFAULT false NOT NULL,
	`rev` integer NOT NULL,
	`last_touched_by` text NOT NULL,
	`last_touched_at` text NOT NULL,
	`editing_by` text,
	`editing_heartbeat_at` text,
	`opened_at` text NOT NULL,
	`last_active_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_canvas_documents_room` ON `canvas_documents` (`room_id`,`last_active_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_documents_source_unique` ON `canvas_documents` (`scope`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_canvas_documents_type` ON `canvas_documents` (`room_id`,`content_type`);--> statement-breakpoint
CREATE INDEX `idx_canvas_documents_last_touched` ON `canvas_documents` (`room_id`,`last_touched_by`,`last_touched_at`);