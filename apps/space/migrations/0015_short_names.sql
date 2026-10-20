-- Community short names (specs/community-host-operator-api, P6; ADR 260923-121152). A short
-- name is a mutable address alias, never identity: credentials, links, and stored connections
-- keep the community UUID. The primary key makes a name unique across the host, retired names
-- included, so an old address can never be taken over by another community.
CREATE TABLE community_short_names (
  short_name text PRIMARY KEY
    CHECK (short_name ~ '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$'),
  community_id uuid NOT NULL REFERENCES communities(id),
  state text NOT NULL CHECK (state IN ('current','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT community_short_names_retired CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX community_short_names_one_current
  ON community_short_names(community_id) WHERE state = 'current';
CREATE INDEX community_short_names_community_idx ON community_short_names(community_id);

-- A released name, or one freed by deleting its community, is held back from reuse for a
-- cool-off. Only an HMAC of the name is kept, so no deleted community's name survives in
-- clear text; rotating the auth secret ends outstanding holds early.
CREATE TABLE released_short_names (
  name_hmac text PRIMARY KEY CHECK (name_hmac ~ '^[a-f0-9]{64}$'),
  available_at timestamptz NOT NULL
);
CREATE INDEX released_short_names_available_idx ON released_short_names(available_at);
