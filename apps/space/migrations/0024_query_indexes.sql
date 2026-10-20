-- Indexes chosen from an audit of every query the Community runs, measured on a seeded host
-- (one community of 1,000,000 messages, 5,000 members and 500 agents, beside 2,004 smaller
-- ones). Each index below serves a path that otherwise scanned a whole table or a whole
-- community once per row; each dropped index is the leading column of a unique index on the
-- same table, which serves every query it did.
--
-- Postgres does not index the referencing side of a foreign key. Deleting or changing a parent
-- row then scans the child table once per row, inside the deleting transaction: a community's
-- deletion, a member's erasure, and an account's erasure all delete parents in bulk.
--
-- This runs inside the migration transaction, so not CONCURRENTLY. At the measured scale the
-- whole file built in 0.28 seconds; the largest build is audit_events (240,000 rows).

-- Deleting a message cascades to its redaction rows through (community_id, entry_id), and no
-- index led with entry_id: each deleted message read its community's whole redaction feed.
-- Deleting 20,000 messages took 45 seconds; with this index, about 3.
CREATE INDEX entry_redactions_entry_idx ON entry_redactions(entry_id);

-- The export worker reads max(id), and id ranges, of one community's redaction feed. The old
-- (community_id) index returned every row of the community for that; (community_id, id)
-- answers it from one end of the range and still serves everything the old one did.
CREATE INDEX entry_redactions_community_id_idx ON entry_redactions(community_id, id);
DROP INDEX entry_redactions_community_idx;

-- Removing, erasing or deleting a member clears or checks these rows by member. Each was
-- reachable only through community_id (or not at all), so a member's removal read every
-- cursor, grant and pairing in the community, and deleting a community's members read each
-- table once per member.
CREATE INDEX read_cursors_member_idx ON read_cursors(member_id);
CREATE INDEX connection_grants_member_idx ON connection_grants(member_id);
CREATE INDEX connection_pairings_member_idx ON connection_pairings(member_id)
  WHERE member_id IS NOT NULL;
CREATE INDEX audit_events_actor_idx ON audit_events(actor_member_id)
  WHERE actor_member_id IS NOT NULL;

-- Revoking or deleting an agent clears its credentials and channel seats by agent.
CREATE INDEX agent_credentials_agent_idx ON agent_credentials(agent_id);
CREATE INDEX agent_channel_members_agent_idx ON agent_channel_members(agent_id);

-- "Your communities", account erasure and password recovery look a person up by account
-- across every community on the host, and deleting the account checks both tables.
CREATE INDEX members_user_idx ON members(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX invite_uses_user_idx ON invite_uses(user_id);

-- Deleting a channel checks attachments by channel; nothing led with channel_id. This takes
-- the place of attachments_community_idx, dropped below, so attachments keep their count.
CREATE INDEX attachments_channel_idx ON attachments(channel_id);

-- Each of these is the leading column of a unique (community_id, id) index on the same table,
-- which serves every query it served. Dropping entries_community_idx takes one index write off
-- every message posted.
DROP INDEX entries_community_idx;
DROP INDEX attachments_community_idx;
DROP INDEX channels_community_idx;
DROP INDEX export_archives_community_idx;
DROP INDEX pending_admissions_community_idx;
