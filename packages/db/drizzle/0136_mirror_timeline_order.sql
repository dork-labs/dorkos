ALTER TABLE `room_entries` ADD `timeline_band` integer;--> statement-breakpoint
ALTER TABLE `room_entries` ADD `timeline_pos` integer;--> statement-breakpoint
-- Place every row of a mirrored room in its timeline (DOR-2573): what was written here follows
-- remote history in seq order, and an imported Community entry sits at its Community sequence.
UPDATE `room_entries` SET `timeline_band` = 1, `timeline_pos` = `seq`
  WHERE `room_id` IN (SELECT `local_room_id` FROM `community_room_mirrors`);--> statement-breakpoint
UPDATE `room_entries` SET `timeline_band` = 0, `timeline_pos` = (
    SELECT `remote_seq` FROM `community_mirror_entries` WHERE `local_entry_id` = `room_entries`.`id`
  )
  WHERE `room_id` IN (SELECT `local_room_id` FROM `community_room_mirrors`)
    AND EXISTS (SELECT 1 FROM `community_mirror_entries` WHERE `local_entry_id` = `room_entries`.`id`);--> statement-breakpoint
CREATE INDEX `idx_room_entries_mirror_timeline` ON `room_entries` (`room_id`,`timeline_band`,`timeline_pos`) WHERE "timeline_band" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `community_mirror_entries` ADD `remote_parent_entry_id` text;--> statement-breakpoint
ALTER TABLE `community_mirror_entries` ADD `remote_thread_root_entry_id` text;--> statement-breakpoint
-- The Community relation each cached entry was sent with, so the import can link replies that
-- arrived before their parent without reading the room. Rows cached before entry_json existed
-- have none, exactly as the old full-room repair skipped them.
UPDATE `community_mirror_entries` SET
    `remote_parent_entry_id` = json_extract(`entry_json`, '$.parentEntryId'),
    `remote_thread_root_entry_id` = json_extract(`entry_json`, '$.threadRootEntryId')
  WHERE `entry_json` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_community_mirror_entries_remote_parent` ON `community_mirror_entries` (`local_room_id`,`remote_parent_entry_id`) WHERE "remote_parent_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_community_mirror_entries_remote_thread_root` ON `community_mirror_entries` (`local_room_id`,`remote_thread_root_entry_id`) WHERE "remote_thread_root_entry_id" IS NOT NULL;
