DROP TABLE `approval_grants`;--> statement-breakpoint
ALTER TABLE `approvals` ADD `area` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `blocked_request` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `request_reason` text;--> statement-breakpoint
CREATE INDEX `idx_approvals_blocked_requester` ON `approvals` (`requested_by_path`,`blocked_request`,`created_at`);