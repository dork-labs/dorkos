-- Agents become members of their space, and every message has one author (specs/server-merge
-- D3, step 2, DOR-2876; design note specs/server-merge/03-agents-as-members.md, PR 2).
--
-- Each agent gets a `members` row with the agent's own id: kind 'agent', its owner's membership
-- in `owner_member_id`, no account and no handle (the handle stays in `agents` and
-- `community_handles`), the plain member role. A trigger on `agents` writes that row when an
-- agent is added and keeps its name and standing in step after, so every path that writes
-- agents (enrolment, removal, erasure, the importers) keeps it without knowing about it, as
-- 0007's mention trigger did for its change of shape. Every agent message then gets
-- `author_member_id` = `author_agent_id`, and the one-author check becomes: the member is always
-- set, and an agent author is that same member. Apps parse nothing new: an agent's id was
-- already its `memberId` on the wire, and `author_agent_id` stays filled.
--
-- ONE-WAY (D10). An older release would count agents as people and refuse agent posts, so this
-- raises the compatibility floor (0041) to 42 and no release that knows less will start. The
-- way back is the host's point-in-time restore, never an older image.
--
-- Order matters: `members` has a deferred owner trigger, and once rows are inserted into it no
-- later statement here may alter it ("pending trigger events"), so the agent rows go in after
-- every change to `members` (0040 made them all).
--
-- Cost: one insert per agent, then one update per agent message, inside the boot transaction
-- with `entries` locked. On a laptop 300,000 agent messages took about 9 seconds (design note).

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

-- Refuse before changing anything if the data cannot take the new shape.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents a JOIN members m ON m.id = a.id) THEN
    RAISE EXCEPTION 'Agents as members (0042): an agent id is already a member id. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM agents a JOIN members o ON o.id = a.owner_member_id
    WHERE o.kind <> 'person'
  ) THEN
    RAISE EXCEPTION 'Agents as members (0042): an agent is owned by an agent. Nothing was changed.';
  END IF;
END $$;

-- One member row per agent. An erased owner's agents were turned into husks with them, so an
-- inactive agent of an erased owner is erased too; an imported owner's agents were imported.
INSERT INTO members(id, community_id, user_id, display_name, handle, role, active, created_at,
  removed_at, erased_at, origin, kind, owner_member_id)
SELECT a.id, a.community_id, NULL, a.display_name, NULL, 'member', a.active, a.created_at,
  a.revoked_at, CASE WHEN NOT a.active THEN owner.erased_at END, owner.origin, 'agent',
  a.owner_member_id
FROM agents a
JOIN members owner ON owner.id = a.owner_member_id AND owner.community_id = a.community_id;

ALTER TABLE agents ADD CONSTRAINT agents_member_fk FOREIGN KEY (community_id, id)
  REFERENCES members(community_id, id);

-- The agent's member row follows the agent. A new agent gets one before it is written (the key
-- above needs it first); a rename, removal or return copies over. An agent never changes owner
-- or space, and only a person owns one. The row takes its owner's `origin`: an imported person's
-- agent is imported with them, and an owner who adopted an imported space keeps 'imported', so
-- agents they enrol later are 'imported' too. Harmless: nothing reads `origin` on an agent row. Availability reports (`runs_on`, `last_seen_at`) are
-- not watched, so they write nothing here. Erasure stamps `erased_at` itself.
CREATE FUNCTION keep_agent_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_origin text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT origin INTO owner_origin FROM members
    WHERE id = NEW.owner_member_id AND community_id = NEW.community_id AND kind = 'person';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An agent''s owner must be a person in the same space.';
    END IF;
    INSERT INTO members(id, community_id, user_id, display_name, handle, role, active,
      created_at, removed_at, origin, kind, owner_member_id)
    VALUES (NEW.id, NEW.community_id, NULL, NEW.display_name, NULL, 'member', NEW.active,
      NEW.created_at, NEW.revoked_at, owner_origin, 'agent', NEW.owner_member_id);
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.community_id <> OLD.community_id
     OR NEW.owner_member_id <> OLD.owner_member_id THEN
    RAISE EXCEPTION 'An agent keeps its id, its space and its owner.';
  END IF;
  UPDATE members SET display_name = NEW.display_name, active = NEW.active,
    removed_at = NEW.revoked_at
  WHERE id = NEW.id AND community_id = NEW.community_id AND kind = 'agent';
  RETURN NULL;
END $$;
CREATE TRIGGER agents_member_insert BEFORE INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION keep_agent_member();
CREATE TRIGGER agents_member_update
  AFTER UPDATE OF id, community_id, owner_member_id, display_name, active, revoked_at ON agents
  FOR EACH ROW EXECUTE FUNCTION keep_agent_member();

-- Every message has one author: a member. An agent's message names the agent's own member row,
-- and still names the agent, so apps from before this change read it as an agent's.
ALTER TABLE entries DROP CONSTRAINT entries_exactly_one_author;
UPDATE entries SET author_member_id = author_agent_id
WHERE author_member_id IS NULL AND author_agent_id IS NOT NULL;
ALTER TABLE entries ADD CONSTRAINT entries_one_author CHECK (
  author_member_id IS NOT NULL
  AND (author_agent_id IS NULL OR author_agent_id = author_member_id)
);
-- The check above is valid, so this does not read the table again.
ALTER TABLE entries ALTER COLUMN author_member_id SET NOT NULL;

-- One-way: no release that knows less than this may start on it (0041).
UPDATE community_compatibility_floor SET min_migration = GREATEST(min_migration, 42);

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
