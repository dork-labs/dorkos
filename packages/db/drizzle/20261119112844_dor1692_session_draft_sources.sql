CREATE TABLE `session_draft_sources` (
	`session_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`location_id` text,
	`registered_agent_id` text,
	`source_path` text NOT NULL,
	`source_created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session_metadata`(`session_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_draft_sources_shape" CHECK(length("session_draft_sources"."owner_id") > 0 AND length("session_draft_sources"."source_path") > 0 AND
        length("session_draft_sources"."source_created_at") > 0 AND
        (("session_draft_sources"."source_kind" = 'person-location' AND "session_draft_sources"."location_id" IS NOT NULL AND
          length("session_draft_sources"."location_id") > 0 AND "session_draft_sources"."registered_agent_id" IS NULL) OR
         ("session_draft_sources"."source_kind" = 'person-agent' AND "session_draft_sources"."registered_agent_id" IS NOT NULL AND
          length("session_draft_sources"."registered_agent_id") > 0 AND "session_draft_sources"."location_id" IS NULL)))
);
