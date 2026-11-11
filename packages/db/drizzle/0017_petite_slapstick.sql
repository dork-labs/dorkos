CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`key` text NOT NULL,
	`path` text NOT NULL,
	`source` text NOT NULL,
	`branch` text,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`port_base` integer NOT NULL,
	`port_block_size` integer NOT NULL,
	`hostname` text,
	`url` text,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_path_unique` ON `workspaces` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_project_key_unique` ON `workspaces` (`project_key`,`key`);