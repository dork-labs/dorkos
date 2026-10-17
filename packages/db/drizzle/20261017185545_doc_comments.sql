CREATE TABLE `doc_comment_agent_chats` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `doc_comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_key` text NOT NULL,
	`space_key` text NOT NULL,
	`doc_path` text NOT NULL,
	`anchor_json` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`resolved_at` text,
	`resolved_by_author_id` text,
	`created_by_author_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `doc_comment_threads_doc_idx` ON `doc_comment_threads` (`doc_key`);--> statement-breakpoint
CREATE TABLE `doc_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`mentions_json` text DEFAULT '[]' NOT NULL,
	`cascade_root` text NOT NULL,
	`cascade_depth` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`edited_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `doc_comment_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_comments_thread_idx` ON `doc_comments` (`thread_id`);--> statement-breakpoint
CREATE INDEX `doc_comments_cascade_idx` ON `doc_comments` (`cascade_root`);