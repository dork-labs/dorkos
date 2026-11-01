-- Escalation deliveries: `notification_id` becomes nullable (an escalation about
-- a STANDING condition has no notification row to hang off yet) and every row
-- gains `subject_key`, which is what interprets one.
--
-- HAND-EDITED, one line: drizzle-kit's copy step emitted
-- `SELECT … "subject_key" … FROM notification_deliveries`, reading a column the
-- OLD table does not have — the generator assumes a rebuild never ADDS a column,
-- which every earlier rebuild here (0010, 0024, 0044, 0046) happened to satisfy.
-- The literal `NULL` below is the correct copy: rows written before this
-- migration have no subject key, which is why the column is nullable.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text,
	`subject_key` text,
	`channel` text NOT NULL,
	`sent_at` text NOT NULL,
	`seen_at` text,
	`acted_at` text,
	`detail_json` text,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_notification_deliveries`("id", "notification_id", "subject_key", "channel", "sent_at", "seen_at", "acted_at", "detail_json") SELECT "id", "notification_id", NULL, "channel", "sent_at", "seen_at", "acted_at", "detail_json" FROM `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notification_deliveries` RENAME TO `notification_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_notification` ON `notification_deliveries` (`notification_id`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_subject` ON `notification_deliveries` (`subject_key`);