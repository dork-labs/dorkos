-- Watch-only spam and rule checks on new posts (specs/official-community-space D15; DOR-2777).
--
-- A background worker reads each new message after it committed, runs the built-in rules, then
-- the decision models the host armed, and records one `decision.*` audit row per rung. Nothing is
-- hidden, held or removed: a check that leans toward spam or a broken rule only files a report
-- with `source='check'` into the moderation queue (0034).
--
-- `audit_events.decision` holds the rung's record (use case, rung, pinned model id, policy hash,
-- a keyed hash of the exact input, the answers as neutral codes, confidence, latency, cost). It
-- never copies the message and keeps no words a model wrote. It is set on `decision.*` rows only.
--
-- The rung-0 row is also the claim: one per message on this host, so two replicas never check
-- (and never pay for) the same message twice. Imported rows keep `origin='imported'` and are left
-- out of it.
--
-- `entries_created_idx` lets the worker find the last few minutes of messages across every space
-- without reading them all.
--
-- Locks: the column is new and NULL everywhere, so its check is added NOT VALID: it holds every
-- new row and never scans the old ones. The four indexes are built inside the migration
-- transaction, so writes to `audit_events` and new posts wait while they build. They are small
-- (one key each, three of them partial over rows that do not exist yet); `entries_created_idx` is
-- the only full one and builds at about the rate 0024 measured (its whole file in 0.28 seconds on
-- 240,000 audit rows), a second or two per million messages. Run it in a quiet hour on a big host.
--
-- Backout: revert the code first. Older code ignores the column, and posts are unaffected either
-- way. The migration stays applied.

ALTER TABLE audit_events
  ADD COLUMN decision jsonb,
  ADD CONSTRAINT audit_events_decision_shape CHECK (
    decision IS NULL
    OR (action LIKE 'decision.%' AND jsonb_typeof(decision) = 'object'
      AND octet_length(decision::text) <= 4096)
  ) NOT VALID;

CREATE UNIQUE INDEX audit_events_decision_claim ON audit_events(community_id, subject_id)
  WHERE action = 'decision.rung0' AND origin = 'native';
CREATE INDEX audit_events_decision_subject_idx ON audit_events(community_id, subject_id)
  WHERE action LIKE 'decision.%';
CREATE INDEX audit_events_decision_created_idx ON audit_events(created_at)
  WHERE action LIKE 'decision.%';

CREATE INDEX entries_created_idx ON entries(created_at);
