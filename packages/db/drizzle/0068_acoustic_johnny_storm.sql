CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`channel` text NOT NULL,
	`sent_at` text NOT NULL,
	`seen_at` text,
	`acted_at` text,
	`detail_json` text,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_notification` ON `notification_deliveries` (`notification_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`tier` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`agent_id` text,
	`session_id` text,
	`room_id` text,
	`title` text NOT NULL,
	`body` text,
	`data_json` text,
	`dedupe_key` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	`resolved_at` text,
	`outcome` text
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_dedupe_key` ON `notifications` (`dedupe_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_created_at` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`keys_json` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);