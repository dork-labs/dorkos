ALTER TABLE `connector_event_subscriptions` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `connector_event_subscriptions` ADD `removed_at` text;--> statement-breakpoint
CREATE INDEX `connector_event_inbox_subscription_received_idx` ON `connector_event_inbox` (`subscription_id`,`received_at`);--> statement-breakpoint
-- Every revoked row predates Remove taking a row off the owner's list, and most
-- were removed by that owner, so none of them is listed again.
UPDATE `connector_event_subscriptions` SET `removed_at` = `revoked_at` WHERE `revoked_at` IS NOT NULL;
