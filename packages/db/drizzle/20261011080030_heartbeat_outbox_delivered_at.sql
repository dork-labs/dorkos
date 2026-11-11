ALTER TABLE `heartbeat_outbox` ADD `delivered_at` text;--> statement-breakpoint
-- Backfill what can still be told apart: a row still delivered, or one that
-- landed as an entry, reached its reader at closed_at.
UPDATE `heartbeat_outbox` SET `delivered_at` = `closed_at` WHERE `closed_at` IS NOT NULL AND (`state` = 'delivered' OR `delivered_entry_id` IS NOT NULL);
