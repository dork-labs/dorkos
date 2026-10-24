-- HAND-WRITTEN data migration (DOR-3203). `last_turn_held` (DOR-3037) arrived
-- empty on every chat that ran before it, and an empty record was read as held:
-- after the 0.124.1 upgrade, every such chat woken on its own (an approval's
-- answer, a wake after the restart) was clamped to the runtime's default, and
-- asked on every step. An empty record now reads as not held; this settles the
-- old rows to say so. A chat recorded as held (1) keeps its hold.
UPDATE `session_metadata` SET `last_turn_held` = 0 WHERE `last_turn_held` IS NULL;
