-- The erasure journal in the database (DOR-2566). Each finished erasure adds one row, by id
-- only, in the transaction that finishes it. A host pulls the rows through the host API with a
-- key holding `communities:erasure_journal`, stores them outside the server, and pipes them to
-- erasure:reapply after restoring a backup. `COMMUNITY_ERASURE_JOURNAL` stays an extra copy.
--
-- A restore rolls this table back too; that is why the host keeps the pulled copy. Each row
-- carries a random `nonce` that a read cursor names, so a cursor past the restored end, or
-- naming a row the restore replaced, answers 410 and the reader starts again from the start.
--
-- Rows are kept for COMMUNITY_ERASURE_JOURNAL_RETENTION_DAYS (created_at), as long as a backup
-- that could need them can exist, then pruned by the cleanup sweep.
--
-- Backout: revoke every key holding communities:erasure_journal first, then revert the code.
-- Older code writes no rows and never issues the scope, but it cannot list keys while one holds
-- a scope it does not know. This migration stays applied.

-- Read-only, and no other scope implies it. One more scope than before, so the ceiling grows
-- by one.
ALTER TABLE host_api_keys DROP CONSTRAINT host_api_keys_scopes;
ALTER TABLE host_api_keys ADD CONSTRAINT host_api_keys_scopes CHECK (
  cardinality(scopes) BETWEEN 1 AND 8
  AND scopes <@ ARRAY[
    'communities:read','communities:write','communities:lifecycle','communities:import',
    'communities:legal_hold','communities:takedown','communities:ownership',
    'communities:erasure_journal'
  ]::text[]
);

-- No foreign keys on purpose: a line must outlive the community and the account it names,
-- because re-applying it after a restore is the only thing that erases them again.
CREATE TABLE erasure_journal (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  community_id uuid,
  member_id uuid,
  user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT erasure_journal_record CHECK (
    (kind = 'member' AND community_id IS NOT NULL AND member_id IS NOT NULL AND user_id IS NULL)
    OR (kind = 'account' AND user_id IS NOT NULL AND community_id IS NULL AND member_id IS NULL)
  )
);

CREATE INDEX erasure_journal_created_idx ON erasure_journal (created_at);
