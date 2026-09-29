CREATE TABLE `room_departed_seats` (
	`room_id` text NOT NULL,
	`author_id` text NOT NULL,
	`manifest_id` text,
	`response_mode` text NOT NULL,
	`joined_at` text NOT NULL,
	`joined_seq` integer DEFAULT 0 NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	`held_fallback_seat` integer DEFAULT false NOT NULL,
	`departed_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `author_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_room_departed_seats_author` ON `room_departed_seats` (`author_id`);