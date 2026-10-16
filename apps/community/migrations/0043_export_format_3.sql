-- Export format 3 (specs/server-merge/03-agents-as-members.md, PR 3; DOR-2876).
--
-- Format 3 lists agents as members, with their kind and owner, and names a member as the author
-- of every message (0042 made both true of the data). It is built in background jobs as format
-- 2 was, so it takes the same shape: no single blob, any state. A job queued before this
-- release keeps `format_version` 2 and finishes in format 2, so the segments it already wrote
-- still match; every new job is 3.
--
-- It also gives 0042's agent trigger SQL error codes: an owner who is not a person in the same
-- space is a foreign-key refusal (23503), and a change of an agent's id, space or owner a check
-- refusal (23514). The import reads a 22xxx or 23xxx refusal as an export that cannot be right
-- (`IMPORT_ARCHIVE_INVALID`), as it did for an outside owner before 0042, where the plain error
-- read as a storage failure. The function is otherwise the same.
--
-- Additive only: two checks widen, no row changes. An older release never queues format 3, and
-- 0042 already keeps one from starting here. Backout: revert the code, then put the two checks
-- back once no format 3 row is left (`exports:purge-v2` removes every format 2 and 3 export).
-- A takedown that already stored its record with `manifestVersion` 3 makes older code, which
-- parses only 2, throw on that record: release or re-run such takedowns before rolling back.

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE export_archives
  DROP CONSTRAINT export_archives_format_version,
  ADD CONSTRAINT export_archives_format_version CHECK (format_version IN (1, 2, 3)),
  DROP CONSTRAINT export_archives_version_one_ready,
  ADD CONSTRAINT export_archives_version_one_ready CHECK (format_version >= 2 OR state = 'ready');

CREATE OR REPLACE FUNCTION keep_agent_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_origin text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT origin INTO owner_origin FROM members
    WHERE id = NEW.owner_member_id AND community_id = NEW.community_id AND kind = 'person';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An agent''s owner must be a person in the same space.'
        USING ERRCODE = '23503';
    END IF;
    INSERT INTO members(id, community_id, user_id, display_name, handle, role, active,
      created_at, removed_at, origin, kind, owner_member_id)
    VALUES (NEW.id, NEW.community_id, NULL, NEW.display_name, NULL, 'member', NEW.active,
      NEW.created_at, NEW.revoked_at, owner_origin, 'agent', NEW.owner_member_id);
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.community_id <> OLD.community_id
     OR NEW.owner_member_id <> OLD.owner_member_id THEN
    RAISE EXCEPTION 'An agent keeps its id, its space and its owner.' USING ERRCODE = '23514';
  END IF;
  UPDATE members SET display_name = NEW.display_name, active = NEW.active,
    removed_at = NEW.revoked_at
  WHERE id = NEW.id AND community_id = NEW.community_id AND kind = 'agent';
  RETURN NULL;
END $$;

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
