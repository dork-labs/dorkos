ALTER TABLE `approvals` ADD `origin_marks` text;--> statement-breakpoint
ALTER TABLE `session_metadata` ADD `last_turn_marks` text;--> statement-breakpoint
UPDATE `session_metadata` SET `last_turn_marks` = '{}' WHERE `last_turn_marks` IS NULL;
