-- A host can close someone else's account (DOR-2557): for example a person under the host's
-- minimum age, or by legal order. Until now account erasure was the person's own request only.
--
-- A closure ends the person's access at once (sessions deleted, sign-in refused, connection
-- grants and agent credentials revoked) and schedules the account's ordinary erasure, after the
-- same 72-hour window a person's own request has, so a mistaken closure can be cancelled. If the
-- person had already asked to delete their account, the closure joins that request instead of
-- making a second one (`person_requested`), and cancelling the closure leaves their request
-- waiting as they asked.
--
-- One row per closure. user_id has no foreign key on purpose: the row outlives the account, so
-- the host can read that the closure finished and replay its idempotency key, until the cleanup
-- sweep deletes it 30 days after it ends, like the erasure request it points at.
--
-- Backout: cancel every open closure and revoke every key holding accounts:close first, then
-- revert the code. Older code would let a closed person sign in again, and cannot list keys while
-- one holds a scope it does not know. This migration stays applied.

-- One more scope than before, so the ceiling grows by one.
ALTER TABLE host_api_keys DROP CONSTRAINT host_api_keys_scopes;
ALTER TABLE host_api_keys ADD CONSTRAINT host_api_keys_scopes CHECK (
  cardinality(scopes) BETWEEN 1 AND 9
  AND scopes <@ ARRAY[
    'communities:read','communities:write','communities:lifecycle','communities:import',
    'communities:legal_hold','communities:takedown','communities:ownership',
    'communities:erasure_journal','accounts:close'
  ]::text[]
);

CREATE TABLE account_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  -- The account erasure this closure waits on. Cleared when the cleanup sweep deletes it.
  erasure_request_id uuid REFERENCES erasure_requests(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','cancelled','completed')),
  reason text NOT NULL CHECK (reason IN ('under_minimum_age','legal_order','other')),
  -- The host's own pointer to its record of why. Never free text about the person.
  reference text CHECK (reference ~ '^[A-Za-z0-9 ._#-]{1,80}$'),
  person_requested boolean NOT NULL,
  requested_by_host_actor text NOT NULL
    CHECK (requested_by_host_actor ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT account_closures_other_reference CHECK (reason <> 'other' OR reference IS NOT NULL),
  CONSTRAINT account_closures_state_times CHECK (
    (state = 'closed' AND cancelled_at IS NULL AND completed_at IS NULL)
    OR (state = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
  )
);

-- One open closure per account, and one closure per actor and idempotency key.
CREATE UNIQUE INDEX account_closures_open_unique ON account_closures(user_id) WHERE state = 'closed';
CREATE UNIQUE INDEX account_closures_idempotency_unique
  ON account_closures(requested_by_host_actor, idempotency_key);
CREATE INDEX account_closures_user_idx ON account_closures(user_id, created_at);
CREATE INDEX account_closures_erasure_idx ON account_closures(erasure_request_id);

-- A host audit row for a closure names the closure, never the account: once the closure record
-- is cleaned up, the audit says a closure happened and who did it, but no longer whose.
ALTER TABLE host_audit_events ADD COLUMN subject_account_closure_id uuid;
