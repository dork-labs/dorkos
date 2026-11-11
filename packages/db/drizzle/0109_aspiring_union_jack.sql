ALTER TABLE `pulse_schedules` ADD `package_owned` text;--> statement-breakpoint
-- Every schedule that exists before this column may have been a package's under the
-- old rule. NULL would read as "the person's"; 'unknown' makes the first sync treat
-- it as a package it is releasing, so a person's OFF switch is kept (DOR-2272).
UPDATE `pulse_schedules` SET `package_owned` = 'unknown';
