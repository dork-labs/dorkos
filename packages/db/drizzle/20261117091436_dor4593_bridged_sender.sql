ALTER TABLE `session_metadata` ADD `bridged_sender` text;--> statement-breakpoint
-- HAND-WRITTEN below this line (DOR-4593).
--
-- Every chat that exists before this column is a stranger's for good: nothing
-- recorded says whose words it holds (a per-user Telegram session may hold a
-- group's), so no later turn may vouch for it. Only a linked chat started after
-- this migration can be the owner's own and hand its words on unasked.
UPDATE `session_metadata` SET `bridged_sender` = 'stranger';
