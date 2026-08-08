-- MOVE EVERY PERSON'S ROOM READ CURSOR ONTO `read_cursors`, HAND-WRITTEN
-- (team-room-home spec §D4, task 3.3). `db:generate` writes nothing for this
-- migration — no schema changed — and `scripts/assert-migrations-current.sh`
-- compares the SCHEMA FILES against the snapshot, so it cannot see this
-- statement at all. packages/db/src/__tests__/room-cursor-backfill-migration.test.ts
-- is the only gate on it, the way 0057's backfill is gated by its own test.
--
-- WHY IT EXISTS. `room_members.last_read_seq` used to answer for BOTH a person
-- and an agent. It now answers only for the agent — it is what the ambient
-- participation loop has SHOWN a member (room-participation spec §8.3) — and
-- where a PERSON has read is `read_cursors`. Without this statement every
-- person on this install would open the cockpit with their place in every room
-- reset to the top: rooms they had finished reading would light up unread, and
-- the "New messages" rule would sit above the first message ever sent.
--
-- WHY IT IS A MIGRATION OF ITS OWN RATHER THAN AN EDIT TO 0058. The migrator
-- decides what to apply by comparing journal timestamps against
-- `__drizzle_migrations`, not by hashing the files, so a statement added to a
-- migration that has already run on a database is silently never applied there.
-- Every install that took 0058 with the release this ships in would have kept
-- an empty table.
--
-- WHO IS COPIED. People, and only local ones: `kind = 'human'` with a
-- natural key that is not `platform:…`. An external author is a person on
-- Telegram whose messages this install holds (chats-as-channels §9) — they have
-- never read anything here, their cursor has always been 0, and minting read
-- state for somebody who cannot log in would be inventing it. Agents are left
-- exactly where they are: their cursor is the membership column and stays there.
-- A cursor of 0 is skipped because it says nothing that absence does not
-- already say, and every read path treats a missing row as 0.
--
-- WHY IT IS IDEMPOTENT, STRUCTURALLY. `ON CONFLICT DO NOTHING` on the table's
-- own primary key `(user_id, thread_kind, thread_id)`. A second run finds every
-- row it would write already there and writes nothing — including the case that
-- matters, a person who has read further SINCE the upgrade: their live cursor is
-- ahead of the membership column this reads, and a re-run must never walk it
-- back. `DO NOTHING` rather than `DO UPDATE … MAX(…)` for exactly that reason:
-- the cheaper statement is also the safer one here.
INSERT INTO read_cursors (user_id, thread_kind, thread_id, last_read_seq, updated_at)
SELECT m.author_id,
       'room',
       m.room_id,
       m.last_read_seq,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM room_members m
JOIN authors a ON a.id = m.author_id
WHERE a.kind = 'human'
  AND a.natural_key NOT LIKE 'platform:%'
  AND m.last_read_seq > 0
ON CONFLICT DO NOTHING;
