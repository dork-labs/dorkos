-- Record which connection grant enrolled each agent (DOR-2612).
--
-- A grant is one DorkOS installation. The Community used to find an agent by its owner and local
-- agent id only, and a local id is committed with the agent's files, so two installations of the
-- same person shared it: the second one's recover took the first one's agent over, and either
-- one's Disconnect removed it for both. From now on each agent row names its enrolling grant, a
-- request made with a grant sees, recovers, rotates and removes only the agents that grant
-- enrolled, and two installations enrolling the same local id get one agent each. A person in
-- the Community's own pages still removes any of their agents, and moderators what they could
-- before; that path never reads this column.
--
-- enrolled_by_grant_id is NULL for a legacy row: one enrolled before this migration whose grant
-- cannot be proven. A legacy row stays member-scoped, as every row was before, and the first
-- grant that recovers or rotates it adopts it. So does an orphaned row, whose enrolling grant was
-- revoked or deleted: revoking a grant leaves its agents running, and an installation that pairs
-- again under a new grant gets its agent, handle and channels back. Only a row whose enrolling
-- grant is still live is out of reach of the owner's other grants.
--
-- The backfill names a grant only where it is provable: the owner has only ever held one grant
-- with the enroll-agent scope in that community, revoked or not. Every enroll, recover and
-- rotate needs that scope, so that one grant made all of them. Anyone who held two stays NULL.
--
-- Uniqueness: one row per (grant, local id), and, for legacy rows only, one per (owner, local
-- id) as before. The old (owner, local id) index would forbid two installations their own rows.
-- An erased agent keeps a NULL local id, which never collides, as before.
--
-- No foreign key, on purpose. Member erasure deletes a person's grants while their agents keep
-- their local ids until the erasure finishes, and a key that set the column back to NULL there
-- would turn two installations' rows for one local id into two legacy rows, which the legacy
-- index forbids. A grant id is random and never reused, so a row naming a deleted grant is
-- orphaned, exactly like a revoked one: the owner's next grant can take it over. The routes set the
-- column only from the grant that authenticated the request, in the same community, and the
-- finished erasure clears it with the local id.
--
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on agents, the backfill reads connection_grants and
-- rewrites only agents rows with a local id, and each index build reads agents once. On the
-- seeded host of 0024 (500 agents, a few thousand grants) the file runs in milliseconds.
-- lock_timeout caps each lock wait at 30 seconds, for the reason 0027 gives: a pg_dump or a
-- console query holding agents must not make every later query queue behind this file.
-- On timeout the runner's single transaction rolls back and the next start retries.
--
-- Backout: older code runs against this schema but ignores the column. It finds agents by owner
-- and local id, which can now match one row per installation, and it would again let one
-- installation recover or remove another's agent. Revert the code with that understood; the
-- rows stay valid for it. This migration stays applied.

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE agents ADD COLUMN enrolled_by_grant_id uuid;

UPDATE agents a SET enrolled_by_grant_id = only_grant.id
FROM (
  SELECT (array_agg(g.id))[1] AS id, g.member_id, g.community_id
  FROM connection_grants g
  WHERE 'enroll-agent' = ANY(g.scopes)
  GROUP BY g.member_id, g.community_id
  HAVING count(*) = 1
) only_grant
WHERE a.owner_member_id = only_grant.member_id
  AND a.community_id = only_grant.community_id
  AND a.local_agent_id IS NOT NULL;

-- A grant always belongs to the agent's owner, in the agent's community. With no key to prove
-- it, prove it here once for every row the backfill named.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agents a JOIN connection_grants g ON g.id = a.enrolled_by_grant_id
    WHERE g.member_id <> a.owner_member_id OR g.community_id <> a.community_id
  ) THEN
    RAISE EXCEPTION 'enrolling-grant migration: a backfilled grant is not its agent''s owner''s';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'agents_owner_local_id_unique'
  ) THEN
    RAISE EXCEPTION 'enrolling-grant migration: agents_owner_local_id_unique is missing';
  END IF;
END $$;

-- A grant belongs to one owner, so (grant, local id) also keeps one row per owner and grant.
CREATE UNIQUE INDEX agents_grant_local_id_unique ON agents(enrolled_by_grant_id, local_agent_id)
  WHERE enrolled_by_grant_id IS NOT NULL;
CREATE UNIQUE INDEX agents_owner_local_id_legacy_unique ON agents(owner_member_id, local_agent_id)
  WHERE enrolled_by_grant_id IS NULL;
DROP INDEX agents_owner_local_id_unique;

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
