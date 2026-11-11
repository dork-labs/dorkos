-- Give every existing channel with agents in it a lead (DOR-2823): the agent
-- member that answers a person's message nobody else is answering.
--
-- 1. The agent member that answered people most in that channel in the last
--    14 days: its posts that reply directly to a person's message (cascade
--    depth 1 under a person's post). Ties go to the one that answered last.
-- 2. Otherwise the agent member a topic's "steward: <name>" names, by handle
--    or display name. That text was a convention people typed; nothing read it.
-- 3. Otherwise none.
--
-- Only channels, only where no lead is set (so #team keeps its default agent),
-- never a channel connected to an outside chat (its agent answers @mentions
-- only), and only ever an agent that is on the roster today.
UPDATE rooms SET fallback_seat_author_id = COALESCE(
  (
    SELECT e.author_id FROM room_entries e
    JOIN authors a ON a.id = e.author_id AND a.kind = 'agent'
    JOIN room_members m ON m.room_id = e.room_id AND m.author_id = e.author_id
    JOIN room_entries r ON r.room_id = e.room_id AND r.id = e.cascade_root
    JOIN authors ra ON ra.id = r.author_id AND ra.kind = 'human'
    WHERE e.room_id = rooms.id AND e.kind = 'post' AND e.cascade_depth = 1
      AND e.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
    GROUP BY e.author_id
    ORDER BY count(*) DESC, max(e.seq) DESC
    LIMIT 1
  ),
  (
    SELECT a.id FROM room_members m
    JOIN authors a ON a.id = m.author_id AND a.kind = 'agent'
    WHERE m.room_id = rooms.id
      AND instr(lower(rooms.topic), 'steward:') > 0
      AND EXISTS (
        SELECT 1 FROM (
          SELECT lower(trim(substr(rooms.topic, instr(lower(rooms.topic), 'steward:') + 8))) AS said,
                 lower(name.value) AS name
          FROM (SELECT a.handle AS value UNION ALL SELECT a.display_name) AS name
          WHERE name.value IS NOT NULL AND length(trim(name.value)) > 0
        )
        -- The name exactly, then the end of the topic or a character that cannot
        -- be part of a name: "steward: bo" never matches a member called "bobby".
        WHERE substr(said, 1, length(name)) = name
          AND (length(said) = length(name) OR substr(said, length(name) + 1, 1) NOT GLOB '[a-z0-9_-]')
      )
    ORDER BY length(coalesce(a.handle, a.display_name)) DESC
    LIMIT 1
  )
)
WHERE kind = 'channel'
  AND fallback_seat_author_id IS NULL
  AND id NOT IN (SELECT room_id FROM room_bridges);
