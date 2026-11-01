PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_relay_index` (
	`id` text NOT NULL,
	`subject` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text,
	`sender` text,
	`payload` text,
	`metadata` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`id`, `endpoint_hash`)
);
--> statement-breakpoint
INSERT INTO `__new_relay_index`("id", "subject", "endpoint_hash", "status", "expires_at", "sender", "payload", "metadata", "created_at") SELECT "id", "subject", "endpoint_hash", "status", "expires_at", "sender", "payload", "metadata", "created_at" FROM `relay_index`;--> statement-breakpoint
DROP TABLE `relay_index`;--> statement-breakpoint
ALTER TABLE `__new_relay_index` RENAME TO `relay_index`;--> statement-breakpoint
PRAGMA foreign_keys=ON;