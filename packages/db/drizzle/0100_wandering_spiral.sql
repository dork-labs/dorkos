CREATE TABLE `community_agent_enrollments` (
	`community_ref` text NOT NULL,
	`local_agent_id` text NOT NULL,
	`remote_member_id` text NOT NULL,
	`owner_author_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`community_ref`, `local_agent_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_agent_enrollments_ref_remote_member_unique` ON `community_agent_enrollments` (`community_ref`,`remote_member_id`);--> statement-breakpoint
CREATE INDEX `idx_community_agent_enrollments_owner_state` ON `community_agent_enrollments` (`owner_author_id`,`state`);