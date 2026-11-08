CREATE TABLE `connection_grant_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`refusal_code` text,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`target_agent_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`reason` text,
	`undo_of` text,
	`undone_by` text,
	`created_at` text NOT NULL,
	CONSTRAINT "connection_grant_changes_kind" CHECK("connection_grant_changes"."kind" IN ('narrow_own', 'narrow_other', 'exclude_own', 'exclude_other', 'undo')),
	CONSTRAINT "connection_grant_changes_outcome" CHECK("connection_grant_changes"."outcome" IN ('applied', 'refused')),
	CONSTRAINT "connection_grant_changes_refusal" CHECK(("connection_grant_changes"."outcome" = 'refused') = ("connection_grant_changes"."refusal_code" IS NOT NULL)),
	CONSTRAINT "connection_grant_changes_actor_kind" CHECK("connection_grant_changes"."actor_kind" IN ('person', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `connection_grant_changes_actor_idx` ON `connection_grant_changes` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `connection_grant_changes_connection_idx` ON `connection_grant_changes` (`connection_id`,`created_at`);