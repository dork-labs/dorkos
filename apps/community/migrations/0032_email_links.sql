-- Mailed reset, sign-in and confirmation links (specs/spaces-email; ADR 261005-102035; DOR-2710).
--
-- A person asks for a link; the request is recorded the same way for every address (one row,
-- never a read of "user"), and the mail worker's resolver decides later whether it becomes mail.
-- The address is stored as a keyed hash; its plain text is kept only until the resolver reads
-- it, and never more than an hour (the prune drops a request still pending then, mail on or
-- off). A link's token is 256 random bits, stored only as its SHA-256; it is single-use,
-- short-lived, replaced by a newer link of the same kind, and deleted when the account's access
-- is cleared. Both tables cascade with "user", so an account erasure and
-- release-unverified-account still delete an account that has rows here.
--
-- Account-level notices belong to no community, so notice_outbox.community_id becomes nullable
-- for the three new kinds only.
--
-- Backout: revert the code first. Older code ignores both tables, never writes the new notice
-- kinds, and never reads a NULL community_id it did not write. The migration stays applied.

CREATE TABLE email_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('password_reset','sign_in','email_confirmation')),
  -- Keyed hash of the lower-cased address (HMAC-SHA256 with the auth secret). Counts per address.
  email_hash text NOT NULL CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  -- The typed address, held only until the resolver reads it (seconds), then set to NULL.
  email text CHECK (email IS NULL OR char_length(email) <= 320),
  -- Known for a signed-in resend or a link-screen request; NULL for an anonymous reset request.
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  -- sign_in only: the hash of the pending link this browser held when it asked.
  pending_link_hash text CHECK (pending_link_hash IS NULL OR pending_link_hash ~ '^[a-f0-9]{64}$'),
  -- throttled is set by the resolver: eligible, but over the address's or the host's mail cap.
  state text NOT NULL CHECK (state IN ('pending','throttled','queued','dropped')),
  outbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT email_link_requests_shape CHECK (
    (kind = 'password_reset' AND user_id IS NULL AND pending_link_hash IS NULL)
    OR (kind = 'sign_in' AND user_id IS NOT NULL AND pending_link_hash IS NOT NULL AND email IS NULL)
    OR (kind = 'email_confirmation' AND user_id IS NOT NULL AND pending_link_hash IS NULL AND email IS NULL)
  ),
  CONSTRAINT email_link_requests_resolved CHECK (
    (state = 'pending' AND resolved_at IS NULL)
    OR (state <> 'pending' AND resolved_at IS NOT NULL AND email IS NULL)
  )
);
CREATE INDEX email_link_requests_due_idx ON email_link_requests(created_at) WHERE state = 'pending';
CREATE INDEX email_link_requests_email_idx ON email_link_requests(email_hash, created_at);
CREATE INDEX email_link_requests_user_idx ON email_link_requests(user_id, created_at);
CREATE INDEX email_link_requests_created_idx ON email_link_requests(created_at);

CREATE TABLE email_link_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('password_reset','sign_in','email_confirmation')),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  -- The keyed hash of the address the link was sent to; a changed address kills the link.
  email_hash text NOT NULL CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  -- password_reset: the hash of the password hash at mint, or 'none'; any change kills the link.
  password_fingerprint text,
  -- sign_in: the pending link the asking browser held, copied from the request.
  pending_link_hash text CHECK (pending_link_hash IS NULL OR pending_link_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_link_tokens_shape CHECK (
    (kind = 'password_reset') = (password_fingerprint IS NOT NULL)
    AND (kind = 'sign_in') = (pending_link_hash IS NOT NULL)
  ),
  CONSTRAINT email_link_tokens_one_end CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);
CREATE INDEX email_link_tokens_user_idx ON email_link_tokens(user_id, kind);
CREATE INDEX email_link_tokens_expires_idx ON email_link_tokens(expires_at);

-- Account-level notices belong to no community.
ALTER TABLE notice_outbox ALTER COLUMN community_id DROP NOT NULL;
ALTER TABLE notice_outbox DROP CONSTRAINT notice_outbox_kind_check;
ALTER TABLE notice_outbox ADD CONSTRAINT notice_outbox_kind_check CHECK (kind IN (
  'owner_replacement.notice',
  'owner_replacement.reminder',
  'owner_replacement.claim_reissued',
  'owner_replacement.ended',
  'owner_replacement.completed',
  'account.sign_in_linked',
  'account.password_reset',
  'account.sign_in_link',
  'account.email_confirmation'
));
ALTER TABLE notice_outbox ADD CONSTRAINT notice_outbox_community_shape CHECK (
  community_id IS NOT NULL
  OR kind IN ('account.password_reset','account.sign_in_link','account.email_confirmation')
);
