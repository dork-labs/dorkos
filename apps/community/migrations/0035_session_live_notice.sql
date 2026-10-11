-- Ending a sign-in session tells live streams in the same transaction (DOR-2830).
--
-- A live stream trusts its last access check until a notice says its access may have changed.
-- That is safe only because Postgres delivers notices in commit order: a notice sent in the
-- transaction that ends access reaches the stream before any message posted after it. Better
-- Auth deletes session rows in transactions of its own and calls the app only after they commit,
-- so a notice sent from there could arrive after a message posted in between, and that message
-- would reach a stream whose sign-in had already ended. This trigger sends the `user` notice
-- from inside every transaction that deletes a session, whoever runs it. Postgres delivers one
-- copy of identical notices from one transaction, so deleting many sessions of one account
-- sends one.
--
-- Backout: revert the code first; older code sends the same notice itself after the commit.
-- Then `DROP TRIGGER session_live_notice ON session; DROP FUNCTION notify_session_ended();`.

-- 'community_live' is LIVE_NOTICE_CHANNEL in src/live/notices.ts; rename both together.
CREATE OR REPLACE FUNCTION notify_session_ended() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('community_live', json_build_object('k', 'user', 'u', OLD."userId")::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER session_live_notice
  AFTER DELETE ON session
  FOR EACH ROW EXECUTE FUNCTION notify_session_ended();
