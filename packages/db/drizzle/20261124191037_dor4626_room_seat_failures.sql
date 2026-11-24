CREATE TABLE `room_seat_failures` (
	`session_id` text PRIMARY KEY NOT NULL,
	`boot_id` text NOT NULL,
	`payload` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`consumed_at` integer
);
