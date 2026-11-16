ALTER TABLE `todos` ADD `original_due_at` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `score_due_at` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `move_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE todos SET original_due_at = due_at, score_due_at = due_at WHERE due_at IS NOT NULL;
