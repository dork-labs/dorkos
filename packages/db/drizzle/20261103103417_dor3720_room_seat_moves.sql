CREATE TABLE `room_seat_moves` (
	`from_session_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`author_id` text NOT NULL,
	`moved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_room_seat_moves_at` ON `room_seat_moves` (`moved_at`);