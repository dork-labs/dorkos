-- Hand-written: the two append-only triggers at the end (work_links_append_only_*), as
-- audit_events has. Drizzle does not generate them; a renumber must copy them over.
CREATE TABLE `work_links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_ref` text NOT NULL,
	`to_ref` text NOT NULL,
	`relation` text NOT NULL,
	`recorded_at` text NOT NULL,
	`recording_chat_id` text,
	`source` text NOT NULL,
	CONSTRAINT "work_links_relation" CHECK("work_links"."relation" IN ('started', 'claims', 'opened', 'works_on', 'belongs_to', 'produced', 'forked_from', 'rekeyed_from')),
	CONSTRAINT "work_links_from_length" CHECK(length("work_links"."from_ref") BETWEEN 1 AND 300),
	CONSTRAINT "work_links_to_length" CHECK(length("work_links"."to_ref") BETWEEN 1 AND 300),
	CONSTRAINT "work_links_not_self" CHECK("work_links"."from_ref" <> "work_links"."to_ref"),
	CONSTRAINT "work_links_source" CHECK(length("work_links"."source") BETWEEN 1 AND 32),
	CONSTRAINT "work_links_recording_chat_length" CHECK("work_links"."recording_chat_id" IS NULL OR length("work_links"."recording_chat_id") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_links_edge_unique` ON `work_links` (`from_ref`,`relation`,`to_ref`);--> statement-breakpoint
CREATE INDEX `work_links_to_idx` ON `work_links` (`to_ref`,`relation`);--> statement-breakpoint
CREATE TRIGGER `work_links_append_only_update`
BEFORE UPDATE ON `work_links`
BEGIN
	SELECT RAISE(ABORT, 'work links are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `work_links_append_only_delete`
BEFORE DELETE ON `work_links`
BEGIN
	SELECT RAISE(ABORT, 'work links are append-only');
END;
