-- Where each agent runs, and when it was last there (specs/server-merge D4, step 3a, DOR-2877).
--
-- A space never runs an agent: the DorkOS app that enrolled it does, on a person's computer or
-- on an agent computer. That app now reports in for its agents every few minutes
-- (`POST /agents/availability`), and the space keeps the last report: `runs_on` says what kind
-- of computer runs the agent, and `last_seen_at` when it last said so. The member list reads
-- them as available, offline since a time, or unknown. An agent no app has reported for (every
-- row today, and every row an app from before this release enrolls) has both NULL and reads
-- unknown, never offline.
--
-- Additive only (D10): two nullable columns with no default, so adding them rewrites no row
-- and older code, which names its agents columns and never reads these, runs on the new schema
-- unchanged. The check allows NULL, so an older release's INSERT passes it.
--
-- Locks: ADD COLUMN without a default only changes the catalog, and the check reads agents
-- once under the same ACCESS EXCLUSIVE lock; on the seeded host of 0024 (500 agents) the file
-- runs in milliseconds. lock_timeout caps the lock wait at 30 seconds, as 0027 explains.
--
-- Backout: revert the code; older code ignores both columns. Then, if wanted,
-- `ALTER TABLE agents DROP COLUMN runs_on, DROP COLUMN last_seen_at;`. Nothing else reads them.

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE agents
  ADD COLUMN runs_on text,
  ADD COLUMN last_seen_at timestamptz,
  ADD CONSTRAINT agents_runs_on_check CHECK (runs_on IN ('computer', 'agent-computer'));

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
