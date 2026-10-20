-- Optional outbound mail (specs/community-owner-replacement, "Mail delivery"; ADR 260929-012845;
-- DOR-2537). A durable outbox: a notice is queued in the same transaction as the change that
-- causes it, and a worker sends it later, outside any transaction, only when the host has set
-- COMMUNITY_SMTP_URL and COMMUNITY_MAIL_FROM.
--
-- No address is ever stored. The worker reads "user".email when it sends, so erasing an account
-- leaves no address behind here. recipient_user_id deliberately has no foreign key: erasing an
-- account deletes its "user" row, and a queued notice to it must stay behind to fail as
-- RECIPIENT_UNAVAILABLE rather than block the erasure or vanish unexplained. last_error_class is
-- a fixed code, never the mail server's reply, which can echo the address.
--
-- Backout: unset the two mail settings and revert the code; the table is then ignored. This
-- migration stays applied.

CREATE TABLE notice_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  kind text NOT NULL CHECK (kind IN (
    'owner_replacement.notice',
    'owner_replacement.reminder',
    'owner_replacement.claim_reissued',
    'owner_replacement.ended',
    'owner_replacement.completed'
  )),
  subject_id uuid NOT NULL,
  recipient_user_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  accepted_at timestamptz,
  failed_at timestamptz,
  last_error_class text CHECK (
    last_error_class IS NULL OR last_error_class ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A pending message is due at a time; a resolved one is never sent again and holds no lease.
  CONSTRAINT notice_outbox_state_shape CHECK (
    (state = 'pending' AND next_attempt_at IS NOT NULL
      AND accepted_at IS NULL AND failed_at IS NULL)
    OR (state = 'accepted' AND accepted_at IS NOT NULL AND failed_at IS NULL
      AND next_attempt_at IS NULL AND lease_until IS NULL AND last_error_class IS NULL)
    OR (state = 'failed' AND failed_at IS NOT NULL AND accepted_at IS NULL
      AND next_attempt_at IS NULL AND lease_until IS NULL AND last_error_class IS NOT NULL)
  )
);

CREATE INDEX notice_outbox_due_idx ON notice_outbox(state, next_attempt_at);
CREATE INDEX notice_outbox_community_idx ON notice_outbox(community_id);
CREATE INDEX notice_outbox_subject_idx ON notice_outbox(subject_id);
