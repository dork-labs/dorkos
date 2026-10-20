-- Mute, slow mode, reports, rules and display names (specs/official-community-space D6-D8;
-- DOR-2768).
--
-- Mute: `members.muted_until`. Until then the person and every agent they own cannot post. An
-- owner or admin sets and clears it; it ends on its own.
--
-- Slow mode: `channels.slow_mode_seconds` (0 is off). `channel_post_clocks` keeps when each
-- person last posted in a slow channel, by the human an agent's post counts as. It is rate
-- state, not history: exports leave it out, and an import starts with none.
--
-- Reports: one row per report of a message. `source` is who raised it: `member` (a member, at
-- most once per message) or `check` (an automated, watch-only check that names itself in
-- `check_name`, at most once per message and check; task 2.6 attaches those). Both kinds share
-- one queue, so a moderator resolves a check's hint exactly as a member's report: remove the
-- message, mute or ban its author, or dismiss. Resolving closes every open report of the message.
--
-- Rules: `communities.rules_text` (NULL is no rules) and `rules_version`, which grows with every
-- change, removal included. A member accepts the
-- current version before posting, recorded in `members.rules_accepted_version`; an agent posts
-- under its owner's acceptance. `communities.reserved_names` are display names no member may take.
--
-- Backout: revert the code first. Older code ignores every new column and table, so nobody is
-- muted, slowed or asked to accept rules. The migration stays applied.

ALTER TABLE members
  ADD COLUMN muted_until timestamptz,
  ADD COLUMN rules_accepted_version integer NOT NULL DEFAULT 0
    CHECK (rules_accepted_version >= 0);

ALTER TABLE channels
  ADD COLUMN slow_mode_seconds integer NOT NULL DEFAULT 0
    CHECK (slow_mode_seconds BETWEEN 0 AND 21600);

ALTER TABLE communities
  ADD COLUMN rules_text text CHECK (rules_text IS NULL OR char_length(rules_text) BETWEEN 1 AND 20000),
  ADD COLUMN rules_version integer NOT NULL DEFAULT 0 CHECK (rules_version >= 0),
  ADD COLUMN reserved_names text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(reserved_names) <= 200),
  -- Removing the rules keeps the version: it only ever grows, so an old acceptance never
  -- counts for new text.
  ADD CONSTRAINT communities_rules_shape CHECK (rules_text IS NULL OR rules_version > 0);

CREATE TABLE channel_post_clocks (
  community_id uuid NOT NULL REFERENCES communities(id),
  channel_id uuid NOT NULL,
  member_id uuid NOT NULL,
  posted_at timestamptz NOT NULL,
  PRIMARY KEY (channel_id, member_id),
  CONSTRAINT channel_post_clocks_channel_tenant_fk FOREIGN KEY (community_id, channel_id)
    REFERENCES channels(community_id, id),
  CONSTRAINT channel_post_clocks_member_tenant_fk FOREIGN KEY (community_id, member_id)
    REFERENCES members(community_id, id)
);
CREATE INDEX channel_post_clocks_community_idx ON channel_post_clocks(community_id);
CREATE INDEX channel_post_clocks_member_idx ON channel_post_clocks(member_id);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  entry_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'member' CHECK (source IN ('member','check')),
  reporter_member_id uuid,
  check_name text CHECK (check_name IS NULL OR check_name ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  reason text NOT NULL CHECK (reason IN ('spam','harassment','off_topic','illegal','other')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  action text CHECK (action IS NULL OR action IN ('remove','mute','ban')),
  resolver_member_id uuid,
  origin text NOT NULL DEFAULT 'native' CHECK (origin IN ('native','imported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT reports_source_shape CHECK (
    (source = 'member' AND check_name IS NULL)
    OR (source = 'check' AND reporter_member_id IS NULL AND check_name IS NOT NULL)
  ),
  CONSTRAINT reports_status_shape CHECK (
    (status = 'open' AND resolved_at IS NULL AND action IS NULL AND resolver_member_id IS NULL)
    OR (status = 'actioned' AND resolved_at IS NOT NULL AND action IS NOT NULL)
    OR (status = 'dismissed' AND resolved_at IS NOT NULL AND action IS NULL)
  ),
  CONSTRAINT reports_entry_tenant_fk FOREIGN KEY (community_id, entry_id)
    REFERENCES entries(community_id, id),
  CONSTRAINT reports_reporter_tenant_fk FOREIGN KEY (community_id, reporter_member_id)
    REFERENCES members(community_id, id),
  CONSTRAINT reports_resolver_tenant_fk FOREIGN KEY (community_id, resolver_member_id)
    REFERENCES members(community_id, id)
);
CREATE UNIQUE INDEX reports_community_id_unique ON reports(community_id, id);
CREATE UNIQUE INDEX reports_member_once ON reports(entry_id, reporter_member_id)
  WHERE source = 'member' AND reporter_member_id IS NOT NULL;
CREATE UNIQUE INDEX reports_check_once ON reports(entry_id, check_name) WHERE source = 'check';
CREATE INDEX reports_queue_idx ON reports(community_id, status, created_at);
CREATE INDEX reports_entry_idx ON reports(entry_id);
CREATE INDEX reports_reporter_idx ON reports(reporter_member_id) WHERE reporter_member_id IS NOT NULL;
CREATE INDEX reports_resolver_idx ON reports(resolver_member_id) WHERE resolver_member_id IS NOT NULL;
