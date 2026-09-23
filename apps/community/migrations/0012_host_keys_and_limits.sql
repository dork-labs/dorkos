-- Host API keys: host-owned machine credentials for host routes only. The
-- secret is never stored; only its SHA-256 hash, in a unique column. The
-- display prefix is not unique and is never used for lookup.
CREATE TABLE host_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  prefix text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  issued_via text NOT NULL,
  issued_by_user_id text REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id text REFERENCES "user"(id),
  CONSTRAINT host_api_keys_label CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 80),
  CONSTRAINT host_api_keys_prefix CHECK (prefix ~ '^dkh_[A-Za-z0-9_-]{6}$'),
  CONSTRAINT host_api_keys_secret_hash CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT host_api_keys_scopes CHECK (
    cardinality(scopes) BETWEEN 1 AND 4
    AND scopes <@ ARRAY['communities:read','communities:write','communities:lifecycle','communities:import']::text[]
  ),
  CONSTRAINT host_api_keys_issuer CHECK (
    (issued_via = 'browser' AND issued_by_user_id IS NOT NULL)
    OR (issued_via = 'command' AND issued_by_user_id IS NULL)
  ),
  CONSTRAINT host_api_keys_revoker CHECK (revoked_by_user_id IS NULL OR revoked_at IS NOT NULL)
);
CREATE INDEX host_api_keys_created_idx ON host_api_keys(created_at DESC, id);

-- Every host audit row names its actor: a person, a key, or the offline command.
-- Rows written before this migration were all by a person and keep that meaning
-- through the default; old code that writes only actor_user_id still satisfies
-- the check. A key action also names the key it acted on.
ALTER TABLE host_audit_events
  ADD COLUMN actor_kind text NOT NULL DEFAULT 'person',
  ADD COLUMN actor_api_key_id uuid REFERENCES host_api_keys(id),
  ADD COLUMN subject_api_key_id uuid REFERENCES host_api_keys(id),
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD CONSTRAINT host_audit_events_actor_kind CHECK (actor_kind IN ('person','api_key','offline')),
  ADD CONSTRAINT host_audit_events_actor CHECK (
    (actor_kind = 'person') = (actor_user_id IS NOT NULL)
    AND (actor_kind = 'api_key') = (actor_api_key_id IS NOT NULL)
  );

ALTER TABLE community_creation_receipts
  ALTER COLUMN operator_user_id DROP NOT NULL,
  ADD COLUMN operator_api_key_id uuid REFERENCES host_api_keys(id),
  ADD CONSTRAINT community_creation_receipts_operator CHECK (
    num_nonnulls(operator_user_id, operator_api_key_id) = 1
  );

ALTER TABLE bootstrap_grants
  ADD COLUMN revoked_by_api_key_id uuid REFERENCES host_api_keys(id),
  DROP CONSTRAINT bootstrap_grants_revocation,
  ADD CONSTRAINT bootstrap_grants_revocation CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_by_api_key_id IS NULL)
    OR (revoked_at IS NOT NULL AND num_nonnulls(revoked_by, revoked_by_api_key_id) = 1)
  );

-- Host-set limits. A community without a row has no limit.
CREATE TABLE community_limits (
  community_id uuid PRIMARY KEY REFERENCES communities(id),
  max_active_members integer CHECK (max_active_members BETWEEN 1 AND 1000000),
  max_storage_bytes bigint CHECK (max_storage_bytes >= 0),
  limits_version integer NOT NULL DEFAULT 1 CHECK (limits_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_limit_overrides (
  community_id uuid NOT NULL,
  member_id uuid NOT NULL,
  agents_per_member integer NOT NULL CHECK (agents_per_member BETWEEN 1 AND 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, member_id),
  CONSTRAINT member_limit_overrides_member_tenant_fk
    FOREIGN KEY (community_id, member_id) REFERENCES members(community_id, id)
);

CREATE INDEX managed_blobs_community_usage_idx
  ON managed_blobs(community_id, state, purpose) INCLUDE (byte_size);
CREATE INDEX entries_community_created_idx ON entries(community_id, created_at DESC);
