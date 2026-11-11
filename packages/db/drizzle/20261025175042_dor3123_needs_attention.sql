ALTER TABLE `pulse_runs` ADD `outcome` text;--> statement-breakpoint
-- HAND-WRITTEN data migration (DOR-3123, FB-67). `needs_attention` replaces
-- `blocked`, and `completed` now means a run was refused nothing. Old rows are
-- rewritten so run history tells the truth: a `blocked` run got nothing done,
-- and a `completed` run that lost a tool and carried on did part of its job.
UPDATE `pulse_runs` SET `status` = 'needs_attention', `outcome` = 'nothing_done' WHERE `status` = 'blocked';--> statement-breakpoint
UPDATE `pulse_runs` SET `status` = 'needs_attention', `outcome` = 'partial' WHERE `status` = 'completed' AND `refused_tools` IS NOT NULL AND `refused_tools` <> '[]';
