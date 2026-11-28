-- Hand-written: the two append-only triggers at the end (work_links_append_only_*). The rebuild
-- drops them with the old table; they are WORK_LINKS_APPEND_ONLY_TRIGGERS, copied exactly.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_ref` text NOT NULL,
	`to_ref` text NOT NULL,
	`relation` text NOT NULL,
	`recorded_at` text NOT NULL,
	`recording_chat_id` text,
	`source` text NOT NULL,
	`turn_marks` text,
	CONSTRAINT "work_links_relation" CHECK("__new_work_links"."relation" IN ('started', 'claims', 'opened', 'works_on', 'belongs_to', 'produced', 'forked_from', 'rekeyed_from', 'released')),
	CONSTRAINT "work_links_from_length" CHECK(length("__new_work_links"."from_ref") BETWEEN 1 AND 300),
	CONSTRAINT "work_links_to_length" CHECK(length("__new_work_links"."to_ref") BETWEEN 1 AND 300),
	CONSTRAINT "work_links_not_self" CHECK("__new_work_links"."from_ref" <> "__new_work_links"."to_ref"),
	CONSTRAINT "work_links_source" CHECK(length("__new_work_links"."source") BETWEEN 1 AND 32),
	CONSTRAINT "work_links_recording_chat_length" CHECK("__new_work_links"."recording_chat_id" IS NULL OR length("__new_work_links"."recording_chat_id") BETWEEN 1 AND 64)
);
--> statement-breakpoint
INSERT INTO `__new_work_links`("id", "from_ref", "to_ref", "relation", "recorded_at", "recording_chat_id", "source", "turn_marks") SELECT "id", "from_ref", "to_ref", "relation", "recorded_at", "recording_chat_id", "source", "turn_marks" FROM `work_links`;--> statement-breakpoint
DROP TABLE `work_links`;--> statement-breakpoint
ALTER TABLE `__new_work_links` RENAME TO `work_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `work_links_edge_unique` ON `work_links` (`from_ref`,`relation`,`to_ref`) WHERE "relation" NOT IN ('claims', 'released');--> statement-breakpoint
CREATE UNIQUE INDEX `work_links_span_unique` ON `work_links` (`from_ref`,`relation`,`to_ref`,`recorded_at`) WHERE "relation" IN ('claims', 'released');--> statement-breakpoint
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
