-- A host operator can create a space under a reserved short name (DOR-2848), for example the
-- host's own official space. Until now every reserved name was refused on every path.
--
-- Only names that no page or route owns can be given out this way: the few built-in names that
-- are reserved so no community can pose as the host, and any name the host added to its own
-- list. One row per name given out, kept as the record of who gave it, to which space, and why.
-- It is also what lets the address open the space: a reserved name a space holds without a row
-- here (one that became reserved after the space took it) still opens nothing.
--
-- The row belongs to the space's hold on the name: it names the same name and space as its
-- community_short_names row and goes when that row does (the name released, the space abandoned
-- or deleted), as the space's other host records do.
--
-- Backout: revoke every key holding communities:reserved_names, then revert the code. Older
-- code ignores this table, so a space given a reserved name stops opening at that address
-- (it still opens at /c/<id>), and older code cannot list keys while one holds a scope it does
-- not know. This migration stays applied.

-- One more scope than before, so the ceiling grows by one.
ALTER TABLE host_api_keys DROP CONSTRAINT host_api_keys_scopes;
ALTER TABLE host_api_keys ADD CONSTRAINT host_api_keys_scopes CHECK (
  cardinality(scopes) BETWEEN 1 AND 10
  AND scopes <@ ARRAY[
    'communities:read','communities:write','communities:lifecycle','communities:import',
    'communities:legal_hold','communities:takedown','communities:ownership',
    'communities:erasure_journal','accounts:close','communities:reserved_names'
  ]::text[]
);

-- What the grant's foreign key points at. short_name is already the key, so this is unique too.
ALTER TABLE community_short_names
  ADD CONSTRAINT community_short_names_name_community UNIQUE (short_name, community_id);

CREATE TABLE reserved_name_grants (
  short_name text PRIMARY KEY,
  community_id uuid NOT NULL,
  -- Why the host gave the name out, in the operator's words. Required.
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 200),
  granted_by_host_actor text NOT NULL
    CHECK (granted_by_host_actor ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (short_name, community_id)
    REFERENCES community_short_names(short_name, community_id) ON DELETE CASCADE
);
