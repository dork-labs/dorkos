-- The oldest release that may run on this database (specs/server-merge D10, DOR-2876).
--
-- `min_migration` is the lowest migration a running release must know. A release refuses to
-- start when it is higher than the newest migration that release knows (`migrate.ts`), so a
-- rollback past a one-way change stops with a plain message instead of running quietly on a
-- schema it does not understand. An additive migration never raises it: an older release still
-- runs on an additive change, so rolling the image back stays possible. A one-way migration
-- raises it to its own number, with
-- `UPDATE community_compatibility_floor SET min_migration=GREATEST(min_migration,<n>);`.
--
-- Starts at 0: nothing so far is one-way, so no release is refused. Releases from before this
-- file never read the table, so they are never refused either (OPERATIONS.md says so).
--
-- Additive only: one new single-row table. Backout: revert the code, then, if wanted,
-- `DROP TABLE community_compatibility_floor;`.

CREATE TABLE community_compatibility_floor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  min_migration integer NOT NULL CHECK (min_migration >= 0)
);
INSERT INTO community_compatibility_floor(min_migration) VALUES (0);
