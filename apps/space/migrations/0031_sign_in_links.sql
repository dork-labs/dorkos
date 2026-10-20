-- Link a matching account on a trusted, verified sign-in, or with its password
-- (specs/community-sign-in-linking; ADR 261004-200411; DOR-2709).
--
-- A Google, GitHub or single sign-on sign-in whose email matches an existing account is no
-- longer refused. Unless the host trusts its single sign-on issuer, the sign-in is held here, as
-- a single-use pending link, until the person proves the matched account's own password on the
-- same page. Only the hash of the browser's token is stored. A row expires after 10 minutes; the
-- account's erasure deletes its rows with it.
--
-- One identity, one account: a unique key on (providerId, accountId) means two sign-ins racing
-- to link the same outside identity cannot both win. Better Auth already looks identities up by
-- that pair, so a database with duplicates is already ambiguous; the migration stops and names
-- the problem rather than picking one.
--
-- Backout: revert the code first (older code ignores the table and never writes this notice
-- kind). The unique key and the table can stay; this migration stays applied.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM account GROUP BY "providerId","accountId" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Two or more account rows share one sign-in (the same providerId and accountId).',
      HINT = 'Find them with: SELECT "providerId","accountId",array_agg("userId") FROM account GROUP BY 1,2 HAVING count(*)>1; then delete the extra rows and run the migration again.';
  END IF;
END $$;

CREATE UNIQUE INDEX account_provider_account_key ON account("providerId","accountId");

-- The transaction that last cleared every way into the account (password recovery, or a trusted
-- sign-in taking over a never-confirmed account). A sign-in request that began before that
-- transaction committed may have checked a password or link the clean-out removed, so the
-- session it makes is refused and deleted (sign-in/request-start.ts).
ALTER TABLE "user" ADD COLUMN access_cleared_xid xid8;

CREATE TABLE pending_sign_in_links (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (provider_id IN ('google','github','oidc')),
  account_id text NOT NULL CHECK (char_length(account_id) BETWEEN 1 AND 255),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_sign_in_links_user_idx ON pending_sign_in_links(user_id);
CREATE INDEX pending_sign_in_links_expires_idx ON pending_sign_in_links(expires_at);

-- One more kind of notice: a sign-in was linked to the account.
ALTER TABLE notice_outbox DROP CONSTRAINT notice_outbox_kind_check;
ALTER TABLE notice_outbox ADD CONSTRAINT notice_outbox_kind_check CHECK (kind IN (
  'owner_replacement.notice',
  'owner_replacement.reminder',
  'owner_replacement.claim_reissued',
  'owner_replacement.ended',
  'owner_replacement.completed',
  'account.sign_in_linked'
));
