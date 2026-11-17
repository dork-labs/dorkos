.bail on
-- Stop DorkOS and back up the database. Refuse later migrations or any retained launch constraint.
BEGIN IMMEDIATE;
CREATE TEMP TABLE recovery_down_guard (ok INTEGER CHECK(ok = 1));
INSERT INTO recovery_down_guard SELECT CASE WHEN MAX(created_at) = 1794919158693 THEN 1 ELSE 0 END FROM __drizzle_migrations;
INSERT INTO recovery_down_guard SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM room_seat_launch_requirements;
INSERT INTO recovery_down_guard SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM session_metadata WHERE required_launch_id IS NOT NULL;
ALTER TABLE session_metadata DROP COLUMN required_launch_id;
DROP TABLE room_seat_launch_requirements;
DELETE FROM __drizzle_migrations WHERE created_at = 1794919158693;
DROP TABLE recovery_down_guard;
COMMIT;
