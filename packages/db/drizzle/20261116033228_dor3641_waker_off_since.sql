ALTER TABLE `pulse_schedules` ADD `off_since` text;--> statement-breakpoint
-- HAND-WRITTEN below this line (DOR-3641).
--
-- Schedules already active, or holding a grant, when the approval receipt
-- arrived have no receipt. Nobody knows who approved them, so they are stamped
-- as the policy's, at the row's last write: never active with the receipt
-- blank, and never brought back from a pause with it blank either.
UPDATE `pulse_schedules` SET
  `approved_at` = `updated_at`,
  `approved_by` = '{"kind":"policy"}',
  `approved_via` = 'unknown'
  WHERE (`status` = 'active' OR `approved_content_key` IS NOT NULL) AND (`approved_at` IS NULL OR `approved_by` IS NULL OR `approved_via` IS NULL);
--> statement-breakpoint
-- A schedule that is off now has been off since at least its last write.
-- A project's copy that is off and otherwise ready is left blank: it starts
-- that way on purpose (DOR-3376), and nothing recorded says whether a person
-- ever turned it on.
UPDATE `pulse_schedules` SET `off_since` = `updated_at`
  WHERE NOT (`enabled` = 1 AND `status` = 'active')
    AND NOT (`project_only` = 1 AND `enabled` = 0 AND `status` = 'active');
--> statement-breakpoint
-- `off_since` follows `enabled` and `status` from here on, whoever writes them.
-- A project's copy born off is not "turned off": its blank off_since is how the
-- team page tells it from one a person turned on and later off.
CREATE TRIGGER `pulse_schedules_off_since_insert` AFTER INSERT ON `pulse_schedules`
  WHEN NOT (NEW.`enabled` = 1 AND NEW.`status` = 'active')
    AND NOT (NEW.`project_only` = 1 AND NEW.`enabled` = 0 AND NEW.`status` = 'active')
BEGIN
  UPDATE `pulse_schedules` SET `off_since` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `pulse_schedules_off_since_update` AFTER UPDATE OF `enabled`, `status` ON `pulse_schedules`
  WHEN (OLD.`enabled` = 1 AND OLD.`status` = 'active') IS NOT (NEW.`enabled` = 1 AND NEW.`status` = 'active')
BEGIN
  UPDATE `pulse_schedules` SET `off_since` = CASE
    WHEN NEW.`enabled` = 1 AND NEW.`status` = 'active' THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END WHERE `id` = NEW.`id`;
END;
