CREATE TABLE communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE session (
  id text PRIMARY KEY,
  "expiresAt" timestamp NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session("userId");
CREATE TABLE account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  scope text,
  password text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX account_user_idx ON account("userId");
CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  user_id text NOT NULL UNIQUE REFERENCES "user"(id),
  display_name text NOT NULL,
  handle text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX one_active_owner ON members(community_id) WHERE role = 'owner' AND active;
CREATE UNIQUE INDEX members_handle_unique ON members(community_id,handle);
CREATE INDEX members_community_active_idx ON members(community_id, active);

CREATE TABLE bootstrap_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  issuer_member_id uuid NOT NULL REFERENCES members(id),
  channel_id uuid,
  token_hash text NOT NULL UNIQUE,
  seat_limit integer NOT NULL CHECK (seat_limit BETWEEN 1 AND 100),
  use_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invite_uses (
  invite_id uuid NOT NULL REFERENCES invites(id),
  user_id text NOT NULL REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invite_id,user_id)
);
CREATE TABLE pending_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id uuid NOT NULL REFERENCES invites(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE connection_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verifier_hash text NOT NULL,
  member_id uuid REFERENCES members(id),
  code_hash text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE connection_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id),
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  name text NOT NULL,
  description text,
  visibility text NOT NULL CHECK (visibility IN ('public','private')),
  archived boolean NOT NULL DEFAULT false,
  last_seq bigint NOT NULL DEFAULT 0,
  epoch integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE invites ADD CONSTRAINT invites_channel_fk FOREIGN KEY (channel_id) REFERENCES channels(id);
CREATE INDEX channels_community_idx ON channels(community_id);
CREATE TABLE channel_members (
  channel_id uuid NOT NULL REFERENCES channels(id),
  member_id uuid NOT NULL REFERENCES members(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id,member_id)
);
CREATE INDEX channel_members_member_idx ON channel_members(member_id);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  owner_member_id uuid NOT NULL REFERENCES members(id),
  display_name text NOT NULL,
  handle text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX agents_owner_active_idx ON agents(owner_member_id,active);
CREATE UNIQUE INDEX agents_handle_unique ON agents(community_id,handle);
CREATE TABLE community_handles (
  community_id uuid NOT NULL REFERENCES communities(id),
  handle text NOT NULL,
  member_id uuid REFERENCES members(id),
  agent_id uuid REFERENCES agents(id),
  PRIMARY KEY (community_id,handle),
  CHECK ((member_id IS NULL) <> (agent_id IS NULL)),
  UNIQUE(member_id),
  UNIQUE(agent_id)
);
CREATE TABLE agent_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE agent_channel_members (
  channel_id uuid NOT NULL REFERENCES channels(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id,agent_id)
);

CREATE TABLE entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id),
  seq bigint NOT NULL,
  author_member_id uuid NOT NULL REFERENCES members(id),
  author_display_name text NOT NULL,
  text text NOT NULL,
  parent_entry_id uuid REFERENCES entries(id),
  thread_root_entry_id uuid REFERENCES entries(id),
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel_id,seq),
  UNIQUE(author_member_id,channel_id,idempotency_key)
);
CREATE INDEX entries_thread_idx ON entries(channel_id,thread_root_entry_id,seq);
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id),
  uploader_member_id uuid NOT NULL REFERENCES members(id),
  entry_id uuid REFERENCES entries(id),
  blob_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  checksum text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_entry_idx ON attachments(entry_id);
CREATE TABLE read_cursors (
  channel_id uuid NOT NULL REFERENCES channels(id),
  member_id uuid NOT NULL REFERENCES members(id),
  seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id,member_id)
);
CREATE TABLE owner_quota_windows (
  owner_member_id uuid NOT NULL REFERENCES members(id),
  window_start timestamptz NOT NULL,
  post_count integer NOT NULL DEFAULT 0,
  upload_bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_member_id,window_start)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  actor_member_id uuid REFERENCES members(id),
  action text NOT NULL,
  subject_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_community_created_idx ON audit_events(community_id,created_at);
