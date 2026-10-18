ALTER TABLE `approvals` ADD `teammate_member_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connection_ref` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `result_goes_to` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `teammate_request` text;--> statement-breakpoint
CREATE INDEX `idx_approvals_teammate_asker` ON `approvals` (`connection_ref`,`teammate_member_id`,`created_at`);