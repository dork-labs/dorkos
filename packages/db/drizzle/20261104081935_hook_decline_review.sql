ALTER TABLE `approvals` ADD `decline_kind` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `retry_of` text;--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_retry_of_unique` ON `approvals` (`retry_of`);