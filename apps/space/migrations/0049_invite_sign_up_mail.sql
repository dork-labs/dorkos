-- The mail an invitation's sign-up sends (DOR-2730).
--
-- An invitation's sign-up answers the same for a new and a taken address, and mails the address:
-- a new or never-confirmed account gets the reset link that finishes it, and a confirmed account
-- gets a plain notice ("Sign in to <space>") that carries no link token. This adds that notice as
-- a request kind and a notice kind, `existing_account` / `account.existing_account`, and records
-- on the request which space the invitation was for, so both mails can name it.
--
-- community_id is set only by an invitation's sign-up: on a `password_reset` request it may be
-- set or not (an anonymous reset has none), on an `existing_account` request it is required, and
-- the other kinds never carry one. Like a reset, an `existing_account` request names its address
-- only by hash and typed address, never an account, and is resolved by the mail worker.
--
-- Locks: ACCESS EXCLUSIVE on email_link_requests and notice_outbox while their checks are
-- replaced and revalidated. Both tables are small: requests are resolved in seconds and pruned
-- daily, and accepted notices are pruned too. lock_timeout caps the wait, as in 0027.
--
-- Additive: older releases never write the new kind or the column and run unchanged on this
-- schema, so the compatibility floor stays at 46.
-- Backout: revert the code first. An older mail worker cannot resolve an `existing_account`
-- request and would retry it at the head of its queue until the hourly prune drops it, so after
-- reverting, run `DELETE FROM email_link_requests WHERE kind='existing_account' AND state='pending'`.
-- The migration stays applied.

SELECT set_config('community_migration.lock_timeout', current_setting('lock_timeout'), true);
SET LOCAL lock_timeout = '30s';

ALTER TABLE email_link_requests
  ADD COLUMN community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  DROP CONSTRAINT email_link_requests_kind_check,
  ADD CONSTRAINT email_link_requests_kind_check CHECK (
    kind IN ('password_reset','sign_in','email_confirmation','existing_account')
  ),
  DROP CONSTRAINT email_link_requests_shape,
  ADD CONSTRAINT email_link_requests_shape CHECK (
    (kind = 'password_reset' AND user_id IS NULL AND pending_link_hash IS NULL)
    OR (kind = 'existing_account' AND user_id IS NULL AND pending_link_hash IS NULL
        AND community_id IS NOT NULL)
    OR (kind = 'sign_in' AND user_id IS NOT NULL AND pending_link_hash IS NOT NULL
        AND email IS NULL AND community_id IS NULL)
    OR (kind = 'email_confirmation' AND user_id IS NOT NULL AND pending_link_hash IS NULL
        AND email IS NULL AND community_id IS NULL)
  );
-- A space's deletion finds its requests by this, not by a scan.
CREATE INDEX email_link_requests_community_idx ON email_link_requests(community_id)
  WHERE community_id IS NOT NULL;

ALTER TABLE notice_outbox
  DROP CONSTRAINT notice_outbox_kind_check,
  ADD CONSTRAINT notice_outbox_kind_check CHECK (kind IN (
    'owner_replacement.notice',
    'owner_replacement.reminder',
    'owner_replacement.claim_reissued',
    'owner_replacement.ended',
    'owner_replacement.completed',
    'account.sign_in_linked',
    'account.password_reset',
    'account.sign_in_link',
    'account.email_confirmation',
    'account.existing_account'
  )),
  DROP CONSTRAINT notice_outbox_community_shape,
  ADD CONSTRAINT notice_outbox_community_shape CHECK (
    community_id IS NOT NULL
    OR kind IN (
      'account.password_reset','account.sign_in_link','account.email_confirmation',
      'account.existing_account'
    )
  );

SELECT set_config('lock_timeout', current_setting('community_migration.lock_timeout'), true);
