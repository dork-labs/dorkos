ALTER TABLE `connections` ADD `writes_back_unasked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `writes_back_attested_at` text;