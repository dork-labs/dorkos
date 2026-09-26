-- Removing one message or file (specs/community-single-item-delete). A removed entry keeps its
-- row, id, sequence, thread links, and author; its text becomes a fixed sentence. These two
-- columns say that it was removed and by what kind of remover (never the person). `host` is
-- allowed now so the host takedown needs no second change to this check.
-- Old code ignores both columns: a removed entry reads as an ordinary entry with the tombstone
-- text.
ALTER TABLE entries
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by text,
  ADD CONSTRAINT entries_removed_by CHECK (removed_by IN ('author','moderator','host')),
  ADD CONSTRAINT entries_removed_pair CHECK ((removed_at IS NULL) = (removed_by IS NULL));
