ALTER TABLE `rooms` ADD `well_known` text;--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_well_known_unique` ON `rooms` (`well_known`);