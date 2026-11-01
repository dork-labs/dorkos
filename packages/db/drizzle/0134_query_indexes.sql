DROP INDEX `session_events_session_idx`;--> statement-breakpoint
DROP INDEX `idx_community_mirror_entries_room_seq`;--> statement-breakpoint
DROP INDEX `idx_room_entries_author_room`;--> statement-breakpoint
CREATE INDEX `idx_room_entries_author_room` ON `room_entries` (`author_id`,`room_id`,`thread_root_entry_id`);--> statement-breakpoint
CREATE INDEX `session_metadata_agent_path_idx` ON `session_metadata` (`agent_path`) WHERE "session_metadata"."agent_path" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_room_members_author` ON `room_members` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_read_cursors_thread` ON `read_cursors` (`thread_kind`,`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_community_outbox_remote_entry` ON `community_outbox` (`community_ref`,`remote_room_id`,`remote_entry_id`) WHERE "community_outbox"."remote_entry_id" IS NOT NULL;