ALTER TABLE `agents` ADD `persona` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `persona_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `color` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `icon` text;