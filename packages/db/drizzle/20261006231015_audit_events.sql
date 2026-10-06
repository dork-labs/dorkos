CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`at` text NOT NULL,
	`space_id` text,
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_name` text NOT NULL,
	`on_behalf_of` text,
	`credential` text,
	`source` text NOT NULL,
	`session_id` text,
	`action` text NOT NULL,
	`operation` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_name` text,
	`container_id` text,
	`outcome` text NOT NULL,
	`error` text,
	`change` text,
	`reason` text,
	`links` text,
	`summary` text NOT NULL,
	`visibility` text NOT NULL,
	`participants` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	CONSTRAINT "audit_events_actor_kind" CHECK("audit_events"."actor_kind" IN ('person', 'agent', 'system', 'external')),
	CONSTRAINT "audit_events_operation" CHECK("audit_events"."operation" IN ('create', 'modify', 'remove', 'access', 'execute', 'auth')),
	CONSTRAINT "audit_events_outcome" CHECK("audit_events"."outcome" IN ('ok', 'failed', 'refused')),
	CONSTRAINT "audit_events_visibility" CHECK("audit_events"."visibility" IN ('space', 'participants', 'admins')),
	CONSTRAINT "audit_events_participants_required" CHECK("audit_events"."visibility" <> 'participants' OR "audit_events"."participants" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_id_unique` ON `audit_events` (`id`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_seq_idx` ON `audit_events` (`actor_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_target_seq_idx` ON `audit_events` (`target_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_action_seq_idx` ON `audit_events` (`action`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_session_seq_idx` ON `audit_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE TRIGGER `audit_events_append_only_update`
BEFORE UPDATE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'audit events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_append_only_delete`
BEFORE DELETE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'audit events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_chain_link`
BEFORE INSERT ON `audit_events`
WHEN NEW.`seq` IS NOT COALESCE((SELECT MAX(`seq`) FROM `audit_events`), 0) + 1
	OR NEW.`prev_hash` IS NOT COALESCE(
		(SELECT `hash` FROM `audit_events` ORDER BY `seq` DESC LIMIT 1),
		'0000000000000000000000000000000000000000000000000000000000000000'
	)
BEGIN
	SELECT RAISE(ABORT, 'audit events must extend the chain');
END;
