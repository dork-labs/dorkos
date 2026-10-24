-- A person's DorkOS app can manage a space for them, with their consent (DOR-3005).
--
-- An owner or admin who pairs their app and ticks the consent line on the approval page gets a
-- second credential beside the connection grant: one row here, with its own token, revocable on
-- its own. It is never one more scope on the grant: the grant's `read`/`post`/`enroll-agent`
-- token keeps exactly what it had, and only this token reaches the routes an owner or admin
-- manages the space through, under the same role checks as their browser on every call.
--
-- It lives only as long as its grant: `grant_id` is the connection it was issued with, and a
-- check refuses this token once that grant is revoked, so every path that revokes a grant
-- (disconnect, removal, archive, account clean-out) ends it too. Deleting the grant deletes it.
--
-- Additive: an older release never reads this table, and its grant deletions cascade here. The
-- compatibility floor stays at 46. Backout: revert the code; the table can stay or be dropped.

CREATE TABLE connection_administer_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  member_id uuid NOT NULL,
  grant_id uuid NOT NULL UNIQUE REFERENCES connection_grants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT connection_administer_grants_member_tenant_fk
    FOREIGN KEY (community_id, member_id) REFERENCES members(community_id, id)
);
CREATE INDEX connection_administer_grants_community_idx
  ON connection_administer_grants(community_id);
CREATE INDEX connection_administer_grants_member_idx ON connection_administer_grants(member_id);
