-- Open admission, auto-join channels and bans (specs/official-community-space D1, D3, D6; DOR-2764).
--
-- `open` admits anyone who signs in through the host's single sign-on service, with no
-- invitation. It never makes a password sign-up possible: the sign-up gate admits an open
-- sign-up only on the single sign-on callback, and the host can turn every open join off with
-- COMMUNITY_OPEN_ADMISSION=0.
--
-- `channels.auto_join` puts every newly admitted person (invitation, open join or owner claim)
-- in that channel. Only public, unarchived channels are joined this way.
--
-- A ban ends a membership and refuses every way back in for that account and for that email.
-- The email is never stored: `email_hash` is an HMAC-SHA256, keyed with the auth secret, of the
-- address normalised (lower case, no +tag, no dots in a Gmail address). Without the secret the
-- hash says nothing, and a new account on the same address still meets the ban. `member_id`
-- names the membership the ban ended, for the moderators' list. Erasing that membership clears
-- `user_id` and `reason` and keeps the keyed email, so erasing an account is not a way back in.
-- Only an email the account has confirmed is keyed: anyone can type another person's address
-- into a password sign-up. A ban on an account with no confirmed email holds by account alone.
-- An import restores a ban with `origin='imported'`. An owner export carries the confirmed email,
-- which the importing host keys again with its own secret, and the stored key, which only the
-- same host with the same auth secret can match. So a ban whose account is gone moves with the
-- space only within one host; on another host, or after the auth secret is rotated, it keeps its
-- record and keeps out no email.
--
-- Backout: revert the code first. Older code never reads `bans` or `auto_join`, and treats
-- `open` as an unknown policy only if a community was set to it; set every such community back
-- to 'invite_only' before reverting. The migration stays applied.

ALTER TABLE communities DROP CONSTRAINT communities_admission_policy;
ALTER TABLE communities ADD CONSTRAINT communities_admission_policy
  CHECK (admission_policy IN ('invite_only','closed','open'));

ALTER TABLE channels ADD COLUMN auto_join boolean NOT NULL DEFAULT false;

CREATE TABLE bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  member_id uuid,
  -- The banned account. Cleared when the account is deleted; the email key still holds.
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  email_hash text CHECK (email_hash IS NULL OR email_hash ~ '^[a-f0-9]{64}$'),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  actor_member_id uuid,
  lifted_by_member_id uuid,
  origin text NOT NULL DEFAULT 'native' CHECK (origin IN ('native','imported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  CONSTRAINT bans_lifted_shape CHECK (lifted_by_member_id IS NULL OR lifted_at IS NOT NULL),
  CONSTRAINT bans_member_tenant_fk FOREIGN KEY (community_id, member_id)
    REFERENCES members(community_id, id),
  CONSTRAINT bans_actor_tenant_fk FOREIGN KEY (community_id, actor_member_id)
    REFERENCES members(community_id, id),
  CONSTRAINT bans_lifted_by_tenant_fk FOREIGN KEY (community_id, lifted_by_member_id)
    REFERENCES members(community_id, id)
);
CREATE UNIQUE INDEX bans_community_id_unique ON bans(community_id, id);
-- One standing ban per membership.
CREATE UNIQUE INDEX bans_standing_member_unique ON bans(community_id, member_id)
  WHERE lifted_at IS NULL AND member_id IS NOT NULL;
CREATE INDEX bans_community_user_idx ON bans(community_id, user_id);
CREATE INDEX bans_community_email_idx ON bans(community_id, email_hash);
CREATE INDEX bans_user_idx ON bans(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX bans_member_idx ON bans(member_id) WHERE member_id IS NOT NULL;
CREATE INDEX bans_actor_idx ON bans(actor_member_id) WHERE actor_member_id IS NOT NULL;
CREATE INDEX bans_lifted_by_idx ON bans(lifted_by_member_id) WHERE lifted_by_member_id IS NOT NULL;
