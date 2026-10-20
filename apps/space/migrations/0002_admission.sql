ALTER TABLE connection_pairings ADD COLUMN install_name text NOT NULL DEFAULT 'Local install';
ALTER TABLE connection_pairings ADD COLUMN scopes text[] NOT NULL DEFAULT ARRAY['read']::text[];
ALTER TABLE connection_pairings ADD COLUMN approved_at timestamptz;
ALTER TABLE connection_pairings ADD COLUMN polled_at timestamptz;
ALTER TABLE connection_pairings ADD COLUMN cancelled_at timestamptz;
ALTER TABLE connection_grants ADD COLUMN install_name text NOT NULL DEFAULT 'Local install';

ALTER TABLE agents ADD COLUMN local_agent_id text;
CREATE UNIQUE INDEX agents_owner_local_id_unique ON agents(owner_member_id,local_agent_id);

ALTER TABLE entries ALTER COLUMN author_member_id DROP NOT NULL;
ALTER TABLE entries ADD COLUMN author_agent_id uuid REFERENCES agents(id);
ALTER TABLE entries ADD CONSTRAINT entries_exactly_one_author CHECK ((author_member_id IS NULL) <> (author_agent_id IS NULL));
CREATE UNIQUE INDEX entries_agent_key_unique ON entries(author_agent_id,channel_id,idempotency_key) WHERE author_agent_id IS NOT NULL;

ALTER TABLE attachments ALTER COLUMN uploader_member_id DROP NOT NULL;
ALTER TABLE attachments ADD COLUMN uploader_agent_id uuid REFERENCES agents(id);
ALTER TABLE attachments ADD CONSTRAINT attachments_exactly_one_uploader CHECK ((uploader_member_id IS NULL) <> (uploader_agent_id IS NULL));
