CREATE TABLE `extension_person_records` (
	`extension_id` text NOT NULL,
	`hash` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`extension_id`, `hash`)
);
