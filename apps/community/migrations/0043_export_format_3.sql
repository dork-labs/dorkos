-- Export format 3 (specs/server-merge/03-agents-as-members.md, PR 3; DOR-2876).
--
-- Format 3 lists agents as members, with their kind and owner, and names a member as the author
-- of every message (0042 made both true of the data). It is built in background jobs as format
-- 2 was, so it takes the same shape: no single blob, any state. A job queued before this
-- release keeps `format_version` 2 and finishes in format 2, so the segments it already wrote
-- still match; every new job is 3.
--
-- Additive only: two checks widen, no row changes. An older release never queues format 3, and
-- 0042 already keeps one from starting here. Backout: revert the code, then put the two checks
-- back once no format 3 row is left (`exports:purge-v2` removes every format 2 and 3 export).

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE export_archives
  DROP CONSTRAINT export_archives_format_version,
  ADD CONSTRAINT export_archives_format_version CHECK (format_version IN (1, 2, 3)),
  DROP CONSTRAINT export_archives_version_one_ready,
  ADD CONSTRAINT export_archives_version_one_ready CHECK (format_version >= 2 OR state = 'ready');

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
