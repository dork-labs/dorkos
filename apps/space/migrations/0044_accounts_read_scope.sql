-- The accounts:read host key scope (DOR-2954): list the spaces an account belongs to, found by
-- its single sign-on identity, so the host's account service can show a person their spaces. No
-- other scope implies it, accounts:close included.
--
-- Additive only: the scope check widens by one name, and the ceiling grows by one so a key can
-- still hold every scope once. No row changes.
--
-- Backout: revoke every key holding accounts:read, then revert the code. Older code cannot list
-- keys while one holds a scope it does not know. This migration stays applied.
ALTER TABLE host_api_keys DROP CONSTRAINT host_api_keys_scopes;
ALTER TABLE host_api_keys ADD CONSTRAINT host_api_keys_scopes CHECK (
  cardinality(scopes) BETWEEN 1 AND 11
  AND scopes <@ ARRAY[
    'communities:read','communities:write','communities:lifecycle','communities:import',
    'communities:legal_hold','communities:takedown','communities:ownership',
    'communities:erasure_journal','accounts:close','communities:reserved_names','accounts:read'
  ]::text[]
);
