CREATE TABLE `room_seat_launch_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_session_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_dispatch_id` text NOT NULL,
	`start_seq` integer NOT NULL,
	`end_seq` integer NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_seat_launch_requirements_destination_session_id_unique` ON `room_seat_launch_requirements` (`destination_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_seat_launch_requirements_source_dispatch_id_unique` ON `room_seat_launch_requirements` (`source_dispatch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_seat_launch_source_once` ON `room_seat_launch_requirements` (`source_session_id`,`end_seq`);--> statement-breakpoint
ALTER TABLE `session_metadata` ADD `required_launch_id` text;