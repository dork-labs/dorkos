ALTER TABLE `connection_grant_changes` ADD `actor_snapshot_json` text;--> statement-breakpoint
CREATE INDEX `connection_grant_changes_request_idx` ON `connection_grant_changes` (`request_id`);