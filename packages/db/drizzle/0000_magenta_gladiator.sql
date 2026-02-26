CREATE TABLE `pulse_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`output` text,
	`error` text,
	`session_id` text,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `pulse_schedules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pulse_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cron` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`prompt` text NOT NULL,
	`cwd` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_index` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text,
	`payload` text,
	`metadata` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`sent_at` text NOT NULL,
	`delivered_at` text,
	`processed_at` text,
	`error_message` text,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_traces_message_id_unique` ON `relay_traces` (`message_id`);--> statement-breakpoint
CREATE TABLE `agent_denials` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`reason` text,
	`denier` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_denials_path_unique` ON `agent_denials` (`path`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`runtime` text NOT NULL,
	`project_path` text NOT NULL,
	`namespace` text DEFAULT 'default' NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`entrypoint` text,
	`version` text,
	`description` text,
	`approver` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` text,
	`last_seen_event` text,
	`registered_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_project_path_unique` ON `agents` (`project_path`);--> statement-breakpoint
CREATE TABLE `rate_limit_buckets` (
	`agent_id` text NOT NULL,
	`bucket_minute` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
