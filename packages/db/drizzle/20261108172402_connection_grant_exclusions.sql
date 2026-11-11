CREATE TABLE `connection_grant_exclusions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_by` text,
	`revoked_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "connection_grant_exclusions_revoked_pair" CHECK(("connection_grant_exclusions"."revoked_at" IS NULL) = ("connection_grant_exclusions"."revoked_by" IS NULL)),
	CONSTRAINT "connection_grant_exclusions_agent_id" CHECK("connection_grant_exclusions"."agent_id" <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_grant_exclusions_live_unique` ON `connection_grant_exclusions` (`agent_id`,`connection_id`) WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX `connection_grant_exclusions_connection_idx` ON `connection_grant_exclusions` (`connection_id`);