CREATE TABLE `known_project_reporters` (
	`root` text NOT NULL,
	`extension_id` text NOT NULL,
	`kind` text NOT NULL,
	`reported_at` text NOT NULL,
	PRIMARY KEY(`root`, `extension_id`),
	FOREIGN KEY (`root`) REFERENCES `known_projects`(`root`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "known_project_reporters_kind" CHECK("known_project_reporters"."kind" IN ('report', 'resolve'))
);
--> statement-breakpoint
CREATE INDEX `known_project_reporters_extension_idx` ON `known_project_reporters` (`extension_id`);--> statement-breakpoint
CREATE TABLE `known_projects` (
	`root` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`origin_repo` text,
	`source` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT "known_projects_source" CHECK("known_projects"."source" IN ('seen', 'reported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `known_projects_name_unique` ON `known_projects` (`name`);