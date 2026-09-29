CREATE TABLE `connection_access_levels` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`agent_id` text,
	`connection_id` text NOT NULL,
	`level` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`follower_command_id` text,
	PRIMARY KEY(`subject_type`, `subject_id`, `connection_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connection_access_levels_agent_idx` ON `connection_access_levels` (`agent_id`);--> statement-breakpoint
CREATE INDEX `connection_access_levels_connection_idx` ON `connection_access_levels` (`connection_id`);--> statement-breakpoint
CREATE TABLE `connection_level_follows` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`followed_at` text NOT NULL,
	`app_version` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- A level is stored as the owner's intent from now on (ADR 260929-071355).
-- Before, "Read" was saved as the exact actions it covered that day, and the
-- access card read a grant back as "Read" only while it still matched. Each
-- live grant that matches a level against the account's last reviewed
-- catalog (its newest permission review: every action still offered, by
-- class) becomes that level. Anything else stays exact actions. Read wins
-- when an app has no write actions, since both levels are then the same set.
WITH `latest_review` AS (
  SELECT `review`.`connection_id`, `review`.`id` AS `preview_id`
  FROM `connector_reconciliation_previews` AS `review`
  WHERE `review`.`id` = (
    SELECT `newer`.`id` FROM `connector_reconciliation_previews` AS `newer`
    WHERE `newer`.`connection_id` = `review`.`connection_id`
    ORDER BY `newer`.`created_at` DESC, `newer`.`id` DESC LIMIT 1
  )
),
`level_sets` AS (
  SELECT `latest`.`connection_id`, `level`.`value` AS `level`, `candidate`.`operation_revision_id` AS `revision_id`
  FROM `latest_review` AS `latest`
  JOIN `connector_reconciliation_candidates` AS `candidate` ON `candidate`.`preview_id` = `latest`.`preview_id`
  JOIN `connector_operation_revisions` AS `revision` ON `revision`.`id` = `candidate`.`operation_revision_id`
  JOIN (SELECT 'read' AS `value` UNION ALL SELECT 'read-write') AS `level`
  WHERE `candidate`.`supported` = 1
    AND (`revision`.`capability_classification` = 'read'
      OR (`level`.`value` = 'read-write' AND `revision`.`capability_classification` = 'write'))
),
`subjects` AS (
  SELECT `subject_type`, `subject_id`, `agent_id`, `connection_id`, MAX(`created_by`) AS `created_by`
  FROM `connection_operation_grants`
  WHERE `revoked_at` IS NULL AND `subject_type` IN ('agent', 'every_agent')
  GROUP BY `subject_type`, `subject_id`, `agent_id`, `connection_id`
)
INSERT INTO `connection_access_levels` (`subject_type`, `subject_id`, `agent_id`, `connection_id`, `level`, `created_by`, `updated_at`)
SELECT `subject`.`subject_type`, `subject`.`subject_id`, `subject`.`agent_id`, `subject`.`connection_id`, `offered`.`level`, `subject`.`created_by`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `subjects` AS `subject`
JOIN (SELECT DISTINCT `connection_id`, `level` FROM `level_sets`) AS `offered` ON `offered`.`connection_id` = `subject`.`connection_id`
WHERE NOT EXISTS (
    SELECT 1 FROM `connection_operation_grants` AS `grant`
    WHERE `grant`.`subject_type` = `subject`.`subject_type` AND `grant`.`subject_id` = `subject`.`subject_id`
      AND `grant`.`connection_id` = `subject`.`connection_id` AND `grant`.`revoked_at` IS NULL
      AND `grant`.`operation_revision_id` NOT IN (
        SELECT `revision_id` FROM `level_sets` AS `member`
        WHERE `member`.`connection_id` = `subject`.`connection_id` AND `member`.`level` = `offered`.`level`
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM `level_sets` AS `member`
    WHERE `member`.`connection_id` = `subject`.`connection_id` AND `member`.`level` = `offered`.`level`
      AND `member`.`revision_id` NOT IN (
        SELECT `grant`.`operation_revision_id` FROM `connection_operation_grants` AS `grant`
        WHERE `grant`.`subject_type` = `subject`.`subject_type` AND `grant`.`subject_id` = `subject`.`subject_id`
          AND `grant`.`connection_id` = `subject`.`connection_id` AND `grant`.`revoked_at` IS NULL
      )
  )
  AND (`offered`.`level` = 'read' OR EXISTS (
    SELECT 1 FROM `level_sets` AS `member`
    WHERE `member`.`connection_id` = `subject`.`connection_id` AND `member`.`level` = 'read-write'
      AND `member`.`revision_id` NOT IN (
        SELECT `revision_id` FROM `level_sets` AS `read_member`
        WHERE `read_member`.`connection_id` = `subject`.`connection_id` AND `read_member`.`level` = 'read'
      )
  ));
