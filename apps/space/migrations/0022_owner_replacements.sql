-- Owner replacement (specs/community-owner-replacement, "Data model" and "Scope and authority";
-- ADR 260929-012844; DOR-2538). A host may ask to make the account named in the request the
-- owner of a community whose owner has left. The owner is told, waits out a notice period, and
-- can object at any point before completion; only the named account can then claim.
--
-- This migration only stores the requests and the object-only links, and adds the key scope
-- that starts one. It adds no audit actor kind: the host `system` actor (0019) and the tenant
-- `host` actor (0020) already exist.
--
-- Backout: cancel every open replacement and revoke every key holding communities:ownership
-- first, then revert the code. Code that predates this migration ignores both tables and never
-- issues the new scope, but it cannot list keys while one holds a scope it does not know. This
-- migration stays applied.

-- The host key scope that requests, lists, cancels, and reissues a replacement. No other scope
-- implies it, as none implies communities:legal_hold. One more scope than before, so the
-- ceiling grows by one.
ALTER TABLE host_api_keys DROP CONSTRAINT host_api_keys_scopes;
ALTER TABLE host_api_keys ADD CONSTRAINT host_api_keys_scopes CHECK (
  cardinality(scopes) BETWEEN 1 AND 7
  AND scopes <@ ARRAY[
    'communities:read','communities:write','communities:lifecycle','communities:import',
    'communities:legal_hold','communities:takedown','communities:ownership'
  ]::text[]
);

-- One request to replace one community's owner. Open states: notifying, waiting, claimable.
-- A closed request never reopens. Host-plane reads never return a member id, the OIDC subject,
-- or anything from inside the community; those columns are here for the tenant plane and the
-- claim. The claim token is stored only as its hash, and only while the request is open.
CREATE TABLE owner_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  state text NOT NULL DEFAULT 'notifying' CHECK (state IN (
    'notifying','waiting','claimable',
    'completed','objected','withdrawn','superseded','expired'
  )),
  reason text NOT NULL CHECK (reason IN ('owner_left_group','owner_unreachable','other')),
  -- The host's own pointer (a ticket or case number). No `:` or `/`, so it never reads as a link.
  reference text CHECK (reference ~ '^[A-Za-z0-9 ._#-]{1,80}$'),
  -- Whether the request names an account. Kept after the request closes, for the host's list.
  claimant_named boolean NOT NULL,
  -- The account named in the request: the host's configured OIDC issuer when the request was
  -- made, and the subject that issuer gives this host. Both or neither. They identify a person,
  -- so they live only as long as the request: whatever closes it clears them.
  claimant_oidc_issuer text CHECK (char_length(claimant_oidc_issuer) BETWEEN 1 AND 2048),
  claimant_oidc_subject text CHECK (char_length(claimant_oidc_subject) BETWEEN 1 AND 255),
  claim_token_hash text UNIQUE CHECK (claim_token_hash ~ '^[a-f0-9]{64}$'),
  claim_reissued_at timestamptz,
  requested_by_host_actor text NOT NULL
    CHECK (requested_by_host_actor ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  -- Either one forces the long wait.
  after_objection boolean NOT NULL,
  after_withdrawal boolean NOT NULL,
  -- Why a withdrawn request was withdrawn: the host cancelled it, suspended the community, or
  -- started deleting it. Set on exactly the withdrawn requests.
  withdrawn_cause text CHECK (withdrawn_cause IN ('cancelled','suspended','deletion')),
  prior_owner_member_id uuid NOT NULL,
  new_owner_member_id uuid,
  notice_state text NOT NULL DEFAULT 'pending'
    CHECK (notice_state IN ('pending','accepted','failed')),
  notice_resolved_at timestamptz,
  -- Whether the owner's address was marked verified when the notice was sent.
  verified_address boolean,
  claimable_after timestamptz,
  reminder_queued_at timestamptz,
  claim_expires_at timestamptz,
  requested_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT owner_replacements_claimant
    CHECK ((claimant_oidc_issuer IS NULL) = (claimant_oidc_subject IS NULL)),
  -- An open request carries the named account exactly when it names one. A closed one may have
  -- had it cleared, but never gains one it did not name.
  CONSTRAINT owner_replacements_claimant_named CHECK (
    (claimant_named OR claimant_oidc_issuer IS NULL)
    AND (state NOT IN ('notifying','waiting','claimable')
      OR (claimant_oidc_issuer IS NOT NULL) = claimant_named)
  ),
  CONSTRAINT owner_replacements_withdrawn_cause
    CHECK ((state = 'withdrawn') = (withdrawn_cause IS NOT NULL)),
  CONSTRAINT owner_replacements_notice
    CHECK ((notice_state = 'pending') = (notice_resolved_at IS NULL)),
  -- The wait starts when the notice resolves, so a request only leaves `notifying` after that.
  CONSTRAINT owner_replacements_waiting CHECK (
    state NOT IN ('waiting','claimable','completed','expired') OR notice_state <> 'pending'
  ),
  -- No date before the notice resolves; a request closed before then keeps it null.
  CONSTRAINT owner_replacements_claimable_after CHECK (
    (state <> 'notifying' OR claimable_after IS NULL)
    AND (state NOT IN ('waiting','claimable','completed','expired') OR claimable_after IS NOT NULL)
  ),
  -- The claim window opens with `claimable`; completion and expiry only come from there.
  CONSTRAINT owner_replacements_claim_window CHECK (
    (state NOT IN ('notifying','waiting') OR claim_expires_at IS NULL)
    AND (state NOT IN ('claimable','completed','expired') OR claim_expires_at IS NOT NULL)
    AND (claim_expires_at IS NULL
      OR (claimable_after IS NOT NULL AND claim_expires_at > claimable_after))
  ),
  CONSTRAINT owner_replacements_reminder
    CHECK (reminder_queued_at IS NULL OR claimable_after IS NOT NULL),
  CONSTRAINT owner_replacements_ended CHECK (
    (state IN ('completed','objected','withdrawn','superseded','expired')) = (ended_at IS NOT NULL)
  ),
  CONSTRAINT owner_replacements_new_owner
    CHECK ((state = 'completed') = (new_owner_member_id IS NOT NULL)),
  -- An open request always has exactly one live claim token; a closed one has none.
  CONSTRAINT owner_replacements_claim_token
    CHECK ((state IN ('notifying','waiting','claimable')) = (claim_token_hash IS NOT NULL)),
  CONSTRAINT owner_replacements_prior_owner_tenant_fk FOREIGN KEY (community_id, prior_owner_member_id)
    REFERENCES members(community_id, id),
  CONSTRAINT owner_replacements_new_owner_tenant_fk FOREIGN KEY (community_id, new_owner_member_id)
    REFERENCES members(community_id, id)
);
-- The target of the object tokens' tenant-bound foreign key.
CREATE UNIQUE INDEX owner_replacements_community_id_unique ON owner_replacements(community_id, id);
-- Idempotency is scoped to the community and the requesting host actor: the same key in another
-- community, or from another actor, is its own request.
CREATE UNIQUE INDEX owner_replacements_idempotency
  ON owner_replacements(community_id, requested_by_host_actor, idempotency_key);
-- At most one open request per community.
CREATE UNIQUE INDEX owner_replacements_open_unique ON owner_replacements(community_id)
  WHERE state IN ('notifying','waiting','claimable');
-- The cooling-off check: the community's most recent objection.
CREATE INDEX owner_replacements_objected_idx ON owner_replacements(community_id, ended_at DESC)
  WHERE state = 'objected';
-- The host's list, newest first.
CREATE INDEX owner_replacements_requested_idx
  ON owner_replacements(community_id, requested_at DESC, id DESC);

-- Object-only links. Each notice, reminder, or reissue send attempt mints its own token, stored
-- only as its hash; a failed attempt's token is never deleted, since a timeout may still have
-- delivered the message. A token can only object, and only while its request is open.
-- outbox_id has no foreign key on purpose: a sent message is deleted 30 days after it resolves,
-- while its token lives as long as the request.
CREATE TABLE owner_replacement_object_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replacement_id uuid NOT NULL,
  community_id uuid NOT NULL REFERENCES communities(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  outbox_id uuid,
  -- Set from the caller's clock, like every date the replacement rules compare.
  created_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT owner_replacement_object_tokens_tenant_fk FOREIGN KEY (community_id, replacement_id)
    REFERENCES owner_replacements(community_id, id) ON DELETE CASCADE
);
CREATE INDEX owner_replacement_object_tokens_replacement_idx
  ON owner_replacement_object_tokens(replacement_id);
