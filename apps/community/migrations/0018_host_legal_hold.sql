-- Host legal hold (specs/community-host-operator-api, "Legal hold"; ADR 260924-215422;
-- DOR-2299). A flag, independent of the lifecycle, that stops every permanent deletion of a
-- community until the host releases it: the tenant deletion worker never purges a community
-- under a legal hold, and the host's own deletion and abandon routes refuse. Owners are not told.
--
-- Only the new host key scope communities:legal_hold (or a host person) sets or releases it.
--
-- Backout: release every legal hold first (DELETE /host/communities/:id/legal-hold). Code that
-- predates this migration ignores the columns. The trigger below still refuses to delete a
-- legally held community's row, which rolls back the older worker's final step, but that worker
-- deletes files before it gets there. This migration stays applied.

ALTER TABLE communities
  ADD COLUMN legal_hold_at timestamptz,
  ADD COLUMN legal_hold_by_host_actor text,
  ADD COLUMN legal_hold_reference text,
  ADD CONSTRAINT communities_legal_hold CHECK (
    (legal_hold_at IS NULL) = (legal_hold_by_host_actor IS NULL)
    AND (legal_hold_by_host_actor IS NULL
      OR legal_hold_by_host_actor ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$')
    AND (legal_hold_reference IS NULL
      OR (legal_hold_at IS NOT NULL AND char_length(legal_hold_reference) BETWEEN 1 AND 200))
  );

ALTER TABLE host_api_keys DROP CONSTRAINT host_api_keys_scopes;
ALTER TABLE host_api_keys ADD CONSTRAINT host_api_keys_scopes CHECK (
  cardinality(scopes) BETWEEN 1 AND 5
  AND scopes <@ ARRAY[
    'communities:read','communities:write','communities:lifecycle','communities:import',
    'communities:legal_hold'
  ]::text[]
);

-- The last line of defence: no path, including code older than this migration after a
-- rollback, can delete a legally held community's row. Deleting a tenant happens in one
-- transaction that ends with this row, so the refusal rolls back the whole purge of rows.
CREATE FUNCTION refuse_legally_held_community_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'community is under a legal hold' USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER communities_legal_hold_delete
  BEFORE DELETE ON communities
  FOR EACH ROW WHEN (OLD.legal_hold_at IS NOT NULL)
  EXECUTE FUNCTION refuse_legally_held_community_delete();
