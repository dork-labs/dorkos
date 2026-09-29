ALTER TABLE `connector_event_subscriptions` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `connector_event_subscriptions` ADD `removed_at` text;--> statement-breakpoint
CREATE INDEX `connector_event_inbox_subscription_received_idx` ON `connector_event_inbox` (`subscription_id`,`received_at`);--> statement-breakpoint
-- Every revoked row predates Remove taking a row off the owner's list, so all
-- of them are hidden: the ones the owner removed, and also the ones the system
-- ended (a disconnect, a removed agent, a replaced kind of activity). Those
-- could never come back either; hiding them loses no fix.
UPDATE `connector_event_subscriptions` SET `removed_at` = `revoked_at` WHERE `revoked_at` IS NOT NULL;
