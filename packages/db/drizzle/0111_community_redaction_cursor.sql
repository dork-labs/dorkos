CREATE TABLE `community_mirror_redactions` (
	`community_ref` text NOT NULL,
	`remote_room_id` text NOT NULL,
	`remote_entry_id` text NOT NULL,
	`entry_json` text NOT NULL,
	`author_display_name` text NOT NULL,
	`author_kind` text NOT NULL,
	PRIMARY KEY(`community_ref`, `remote_room_id`, `remote_entry_id`)
);
--> statement-breakpoint
ALTER TABLE `community_room_mirrors` ADD `redaction_cursor` text;