-- Reports of a member, not of one message (DOR-3624): a bad name or profile has no message to
-- report. Its own table, so every path that reads `reports` (which all join an entry) stays as it
-- is. A member reports another person once at a time; once resolved they may report them again.
-- A moderator resolves one by muting or banning the person, or by dismissing it.
--
-- reporter_member_id is NULL only for an import that left it out, as an owner export does for a
-- report about that owner. It is never the person reported.
--
-- Deletion: a space's deletion worker removes these rows before the members and the space they
-- reference; erasing a person keeps the record and clears the note (moderation/erasure.ts).
--
-- If this table ever enters an export, the person a report is about never learns who filed it.
--
-- Locks: only a new table, plus short share locks on the tables its keys reference.
--
-- Additive: older releases never read this table and run unchanged, so the compatibility floor
-- does not move.
-- Backout: revert the code first. Older code ignores the table, and the migration stays applied.

CREATE TABLE member_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id),
  subject_member_id uuid NOT NULL,
  reporter_member_id uuid,
  reason text NOT NULL CHECK (reason IN ('spam','harassment','off_topic','illegal','other')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  action text CHECK (action IS NULL OR action IN ('mute','ban')),
  resolver_member_id uuid,
  origin text NOT NULL DEFAULT 'native' CHECK (origin IN ('native','imported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT member_reports_not_self CHECK (reporter_member_id <> subject_member_id),
  CONSTRAINT member_reports_reporter_shape CHECK (
    reporter_member_id IS NOT NULL OR origin = 'imported'
  ),
  CONSTRAINT member_reports_status_shape CHECK (
    (status = 'open' AND resolved_at IS NULL AND action IS NULL AND resolver_member_id IS NULL)
    OR (status = 'actioned' AND resolved_at IS NOT NULL AND action IS NOT NULL)
    OR (status = 'dismissed' AND resolved_at IS NOT NULL AND action IS NULL)
  ),
  CONSTRAINT member_reports_subject_tenant_fk FOREIGN KEY (community_id, subject_member_id)
    REFERENCES members(community_id, id),
  CONSTRAINT member_reports_reporter_tenant_fk FOREIGN KEY (community_id, reporter_member_id)
    REFERENCES members(community_id, id),
  CONSTRAINT member_reports_resolver_tenant_fk FOREIGN KEY (community_id, resolver_member_id)
    REFERENCES members(community_id, id)
);
CREATE UNIQUE INDEX member_reports_community_id_unique ON member_reports(community_id, id);
CREATE UNIQUE INDEX member_reports_open_once ON member_reports(subject_member_id, reporter_member_id)
  WHERE status = 'open' AND reporter_member_id IS NOT NULL;
CREATE INDEX member_reports_queue_idx ON member_reports(community_id, status, created_at);
CREATE INDEX member_reports_subject_idx ON member_reports(subject_member_id);
CREATE INDEX member_reports_reporter_idx ON member_reports(reporter_member_id)
  WHERE reporter_member_id IS NOT NULL;
CREATE INDEX member_reports_resolver_idx ON member_reports(resolver_member_id)
  WHERE resolver_member_id IS NOT NULL;
