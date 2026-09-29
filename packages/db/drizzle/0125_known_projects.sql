CREATE TABLE `known_projects` (
	`root` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`origin_repo` text,
	`source` text NOT NULL,
	`reported_by` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT "known_projects_source" CHECK("known_projects"."source" IN ('seen', 'reported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `known_projects_name_unique` ON `known_projects` (`name`);