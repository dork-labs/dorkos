-- Members get a kind: a person, or an agent (specs/server-merge D3, step 2, DOR-2876; design
-- note specs/server-merge/03-agents-as-members.md, PR 1).
--
-- This file only prepares the shape. It adds `kind` (default 'person', so every existing row is
-- a person) and `owner_member_id`, and the checks an agent row must pass: an owner who is not
-- itself, no account, no handle (the agent keeps its handle in `agents` and
-- `community_handles`), the plain member role, and no mute or rules acceptance of its own (its
-- owner's cover it). No agent row is written here; the next step's migration writes them and
-- backfills message authors, and that one is forward-only.
--
-- Additive only (D10): v0.117.0 runs on this schema unchanged. Its inserts name no kind and get
-- 'person'; every person it writes has a handle and no owner, so both checks pass; and it reads
-- no column added here. `migrate.integration.test.ts` replays its member statements.
--
-- Locks: ADD COLUMN with a constant default only changes the catalog. The checks and the foreign
-- key read members once under the same ACCESS EXCLUSIVE lock, and the index swap builds one
-- index; members holds one row per person per space, so the file runs in milliseconds.
-- lock_timeout caps the lock wait at 30 seconds, as 0027 explains.
--
-- Backout: revert the code; older code ignores both columns. Then, if wanted, drop the two
-- indexes, the three constraints and the two columns, put back `members_community_active_idx`,
-- the old `members_user_presence` and `handle NOT NULL`.

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE members
  ADD COLUMN kind text NOT NULL DEFAULT 'person',
  ADD COLUMN owner_member_id uuid,
  ADD CONSTRAINT members_kind CHECK (kind IN ('person', 'agent')),
  ADD CONSTRAINT members_agent_shape CHECK (
    (kind = 'person' AND owner_member_id IS NULL AND handle IS NOT NULL)
    OR (kind = 'agent' AND owner_member_id IS NOT NULL AND owner_member_id <> id
        AND user_id IS NULL AND handle IS NULL AND role = 'member'
        AND muted_until IS NULL AND rules_accepted_version = 0)
  ),
  ADD CONSTRAINT members_owner_tenant_fk FOREIGN KEY (community_id, owner_member_id)
    REFERENCES members(community_id, id),
  ALTER COLUMN handle DROP NOT NULL;

-- An agent has no account of its own; every other row keeps the 0013 rule.
ALTER TABLE members DROP CONSTRAINT members_user_presence;
ALTER TABLE members ADD CONSTRAINT members_user_presence CHECK (
  kind = 'agent' OR user_id IS NOT NULL OR erased_at IS NOT NULL
  OR (origin = 'imported' AND NOT active)
);

-- Counts and lists now filter by kind; the owner key gets the index every foreign key gets.
CREATE INDEX members_community_kind_active_idx ON members(community_id, kind, active);
DROP INDEX members_community_active_idx;
CREATE INDEX members_owner_idx ON members(owner_member_id) WHERE owner_member_id IS NOT NULL;

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
