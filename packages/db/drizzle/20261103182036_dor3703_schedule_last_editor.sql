ALTER TABLE `pulse_schedules` ADD `last_edited_by_agent_path` text;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `last_edited_by_session_id` text;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `agent_approval_key` text;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `agent_mode_record` text;--> statement-breakpoint
ALTER TABLE `pulse_schedules` ADD `person_approved_key` text;--> statement-breakpoint
ALTER TABLE `session_started_by` ADD `scheduled_origin` text;--> statement-breakpoint
-- HAND-WRITTEN backfill (DOR-3703). Until now DorkOS kept no last editor, so
-- the creator stands in for it: an agent never approves a schedule it made.
-- A row nobody proposed stays NULL, and no agent may approve that one. This
-- backfill deliberately treats the proposer as the last editor, which can only
-- refuse more agent approvals, never fewer.
UPDATE `pulse_schedules` SET `last_edited_by_agent_path` = `proposed_by_agent_path`,
  `last_edited_by_session_id` = `proposed_by_session_id`
  WHERE `last_edited_by_agent_path` IS NULL;--> statement-breakpoint
-- HAND-WRITTEN backfill (DOR-3703). A schedule no agent proposed was a
-- person's own, so the content it was approved with is the person's approval.
-- An agent's proposal a person approved before now is not marked: it reads as
-- not person-approved, which can only park more, never less.
UPDATE `pulse_schedules` SET `person_approved_key` = `approved_content_key`
  WHERE `proposed_by_agent_path` IS NULL AND `approved_content_key` IS NOT NULL;
