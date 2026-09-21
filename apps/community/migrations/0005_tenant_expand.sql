ALTER TABLE communities ADD COLUMN lifecycle text NOT NULL DEFAULT 'active';
ALTER TABLE communities ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1;
ALTER TABLE communities ADD CONSTRAINT communities_lifecycle CHECK (lifecycle IN ('pending_owner','active','suspended'));
ALTER TABLE communities ADD CONSTRAINT communities_lifecycle_version CHECK (lifecycle_version > 0);

CREATE TABLE host_operators (
  user_id text PRIMARY KEY REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

ALTER TABLE bootstrap_grants ADD COLUMN purpose text NOT NULL DEFAULT 'first_install';
ALTER TABLE bootstrap_grants ADD COLUMN community_id uuid REFERENCES communities(id);
ALTER TABLE bootstrap_grants ADD CONSTRAINT bootstrap_grants_purpose_tenant CHECK (
  (purpose = 'first_install' AND community_id IS NULL)
  OR (purpose = 'owner_claim' AND community_id IS NOT NULL)
);
CREATE INDEX bootstrap_grants_community_idx ON bootstrap_grants(community_id);

CREATE UNIQUE INDEX members_community_id_unique ON members(community_id,id);
CREATE UNIQUE INDEX members_community_user_unique ON members(community_id,user_id);
CREATE UNIQUE INDEX invites_community_id_unique ON invites(community_id,id);
CREATE UNIQUE INDEX channels_community_id_unique ON channels(community_id,id);
CREATE UNIQUE INDEX agents_community_id_unique ON agents(community_id,id);

ALTER TABLE invite_uses ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX invite_uses_community_idx ON invite_uses(community_id);
ALTER TABLE pending_admissions ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX pending_admissions_community_idx ON pending_admissions(community_id);
ALTER TABLE connection_pairings ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX connection_pairings_community_idx ON connection_pairings(community_id);
ALTER TABLE connection_grants ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX connection_grants_community_idx ON connection_grants(community_id);
ALTER TABLE channel_members ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX channel_members_community_idx ON channel_members(community_id);
ALTER TABLE agent_credentials ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX agent_credentials_community_idx ON agent_credentials(community_id);
ALTER TABLE agent_channel_members ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX agent_channel_members_community_idx ON agent_channel_members(community_id);
ALTER TABLE entries ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX entries_community_idx ON entries(community_id);
CREATE UNIQUE INDEX entries_community_id_unique ON entries(community_id,id);
ALTER TABLE attachments ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX attachments_community_idx ON attachments(community_id);
CREATE UNIQUE INDEX attachments_community_id_unique ON attachments(community_id,id);
ALTER TABLE export_archives ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX export_archives_community_idx ON export_archives(community_id);
CREATE UNIQUE INDEX export_archives_community_id_unique ON export_archives(community_id,id);
ALTER TABLE read_cursors ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX read_cursors_community_idx ON read_cursors(community_id);
ALTER TABLE owner_quota_windows ADD COLUMN community_id uuid REFERENCES communities(id);
CREATE INDEX owner_quota_windows_community_idx ON owner_quota_windows(community_id);

CREATE TABLE managed_blobs (
  blob_key text PRIMARY KEY CHECK (blob_key ~ '^[a-f0-9]{64}$'),
  community_id uuid NOT NULL REFERENCES communities(id),
  purpose text NOT NULL CHECK (purpose IN ('attachment','export')),
  community_lifecycle_version integer NOT NULL CHECK (community_lifecycle_version > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','stored','committed','pending_delete')),
  byte_size bigint,
  checksum text,
  created_at timestamptz NOT NULL DEFAULT now(),
  stored_at timestamptz,
  committed_at timestamptz,
  CONSTRAINT managed_blobs_stored_metadata CHECK (
    (state = 'reserved' AND byte_size IS NULL AND checksum IS NULL AND stored_at IS NULL)
    OR (state IN ('stored','committed') AND byte_size IS NOT NULL AND byte_size > 0 AND checksum IS NOT NULL AND stored_at IS NOT NULL)
    OR (
      state = 'pending_delete'
      AND (
        (byte_size IS NULL AND checksum IS NULL AND stored_at IS NULL)
        OR (byte_size IS NOT NULL AND byte_size > 0 AND checksum IS NOT NULL AND stored_at IS NOT NULL)
      )
    )
  ),
  CONSTRAINT managed_blobs_commit_timestamp CHECK (
    (state <> 'committed' OR committed_at IS NOT NULL)
    AND (committed_at IS NULL OR state IN ('committed','pending_delete'))
  ),
  CONSTRAINT managed_blobs_community_key_unique UNIQUE (community_id,blob_key)
);
CREATE INDEX managed_blobs_community_state_idx ON managed_blobs(community_id,state,created_at);
