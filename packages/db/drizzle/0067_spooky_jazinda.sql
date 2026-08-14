CREATE TABLE `room_session_retirements` (
	`retired_session_id` text PRIMARY KEY NOT NULL,
	`canonical_session_id` text NOT NULL,
	`retired_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_room_session_retirements_at` ON `room_session_retirements` (`retired_at`);--> statement-breakpoint
CREATE TABLE `room_turn_spend` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_room_turn_spend_at` ON `room_turn_spend` (`at`);