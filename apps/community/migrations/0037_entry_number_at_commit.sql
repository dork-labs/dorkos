-- A new message takes its channel's next sequence number as its transaction commits (DOR-2837).
--
-- Numbers have to commit in order: a reader that saw message n + 1 before message n would page
-- past n for good, and live streams rely on notices arriving in number order. So whoever holds
-- the next number holds the channel row until it commits. When the app took the number with an
-- UPDATE of its own, it held the row for a round trip to the app and back before its COMMIT;
-- above a few thousand open streams the app is busy enough that this round trip is where posts
-- queued. A post now inserts its message with a provisional negative number from
-- `entries_unnumbered_seq`, and this deferred trigger gives it the real number, and sends its
-- `entry` notice, inside the COMMIT itself: the row is held for the commit and nothing else.
--
-- Only an insert with a negative number is renumbered. Imports and restores write the numbers
-- they carry, and a provisional number is never visible outside its own transaction.
--
-- Backout: revert the code first; older code inserts real numbers, which this trigger leaves
-- alone. Then `DROP TRIGGER entries_number_at_commit ON entries;
-- DROP FUNCTION number_entry_at_commit(); DROP SEQUENCE entries_unnumbered_seq;`.

CREATE SEQUENCE entries_unnumbered_seq;

-- 'community_live' is LIVE_NOTICE_CHANNEL in src/live/notices.ts; rename both together. The
-- notice is the `entry` shape of LiveNoticeSchema there.
CREATE OR REPLACE FUNCTION number_entry_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assigned bigint;
BEGIN
  UPDATE channels SET last_seq = last_seq + 1 WHERE id = NEW.channel_id RETURNING last_seq INTO assigned;
  UPDATE entries SET seq = assigned WHERE id = NEW.id;
  PERFORM pg_notify(
    'community_live',
    json_build_object('k', 'entry', 'c', NEW.community_id, 'ch', NEW.channel_id, 's', assigned)::text
  );
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_number_at_commit
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.seq < 0)
  EXECUTE FUNCTION number_entry_at_commit();
