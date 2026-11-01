DROP INDEX `authors_kind_natural_key_unique`;--> statement-breakpoint
ALTER TABLE `authors` ADD `minted_for_manifest_id` text;--> statement-breakpoint
ALTER TABLE `authors` ADD `retired_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `authors_kind_natural_key_unique` ON `authors` (`kind`,`natural_key`) WHERE "retired_at" is null;