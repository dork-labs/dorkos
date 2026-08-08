/**
 * Migration 0059 — moving every person's room read cursor off the membership
 * row and onto `read_cursors` (team-room-home spec §D4, task 3.3).
 *
 * **Why this file exists at all.** 0059 changes no schema, so `db:generate`
 * writes nothing for it and `scripts/assert-migrations-current.sh` — which
 * compares the SCHEMA FILES against the snapshot — passes whatever the
 * statement says. Same situation as 0057's backfill, same answer: the gate is a
 * test that builds the old shape by running the repo's own migration history
 * and then asserts about rows.
 *
 * **What the backfill is FOR.** `room_members.last_read_seq` answered for a
 * person and an agent at once; it now answers only for the agent. Without this
 * statement, the release that splits them would reset every person's place in
 * every room to the top — rooms they had finished reading lighting up unread,
 * and the "New messages" rule sitting above the first message ever sent.
 *
 * @module db/tests/room-cursor-backfill-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '0059_burly_thanos';

/** Its index in the journal — the shape this test builds is everything below it. */
const IDX = 59;

type Raw = Database.Database;

/**
 * A database at the shape 0058 left: `read_cursors` exists and is empty, and
 * every person's place in a room is still on their membership row.
 *
 * Built by copying the migration folder minus 0059 and truncating the journal,
 * because `migrate()` applies everything the journal lists and there is no
 * "up to N" option — the same construction 0057's test uses, for the same
 * reason: a transcribed fixture is a second copy of the schema and it drifts.
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0058-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < IDX);

  // A renumbered 0059 would leave this asserting against a shape that already
  // includes it, and every expectation below would pass for the wrong reason.
  expect(before.map((e) => e.tag)).not.toContain(TAG);
  expect(journal.entries.map((e) => e.tag)).toContain(TAG);

  for (const entry of before) {
    copyFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: before })
  );

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('recursive_triggers = ON');
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return sqlite;
}

/**
 * Apply 0059 the way production does: through drizzle's own migrator, over the
 * repo's real migration folder.
 *
 * **Not `exec` on the file's text, and the difference is the point.**
 * `Database#exec` happily runs a chunk holding two statements; the migrator
 * PREPARES each one, and `prepare` takes exactly one. So a file that violates
 * the one-statement rule passes an `exec`-driven test and takes down every
 * startup.
 */
function applyMigration(raw: Raw): void {
  migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
}

/**
 * Run 0059's statement again by hand.
 *
 * The migrator will not run a migration twice — that is what
 * `__drizzle_migrations` is for — so the only way to ask "what would a second
 * run do" is to drive the statement directly.
 */
function replayBackfill(raw: Raw): void {
  raw.prepare(readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8')).run();
}

// --- Fixture -----------------------------------------------------------------

/** A stable instant, `minutes` after the fixture's epoch. */
function T(minutes: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, minutes, 0)).toISOString();
}

/** Insert an author row. */
function seedAuthor(raw: Raw, id: string, kind: string, naturalKey: string): void {
  raw
    .prepare(
      'INSERT INTO authors (id, kind, natural_key, display_name, created_at) VALUES (?,?,?,?,?)'
    )
    .run(id, kind, naturalKey, id, T(0));
}

/** Insert a channel. */
function seedRoom(raw: Raw, id: string): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, workspace_id, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(id, 'channel', id.toLowerCase(), id, null, null, 0, T(0), T(0));
}

/** Insert a membership sitting at `lastReadSeq`. */
function seedMember(raw: Raw, roomId: string, authorId: string, lastReadSeq: number): void {
  raw
    .prepare(
      'INSERT INTO room_members (room_id, author_id, response_mode, joined_at, joined_seq, last_read_seq) VALUES (?,?,?,?,?,?)'
    )
    .run(roomId, authorId, 'engaged', T(0), 0, lastReadSeq);
}

/**
 * The world this backfill has to survive.
 *
 * ```
 * C1  ana    local person, natural key 'local'      read to 7
 *     ben    local person, natural key 'user:acct'  read to 3
 *     bo     agent                                  shown to 9
 *     tel    external person (Telegram)             0, and always was
 * C2  ana                                           read to 0 — never opened it
 *     bo     agent                                  shown to 4
 * ```
 */
function seedWorld(raw: Raw): void {
  seedAuthor(raw, 'ana', 'human', 'local');
  seedAuthor(raw, 'ben', 'human', 'user:acct');
  seedAuthor(raw, 'bo', 'agent', '/agents/bo');
  seedAuthor(raw, 'tel', 'human', 'platform:telegram:main:4242');

  seedRoom(raw, 'C1');
  seedMember(raw, 'C1', 'ana', 7);
  seedMember(raw, 'C1', 'ben', 3);
  seedMember(raw, 'C1', 'bo', 9);
  seedMember(raw, 'C1', 'tel', 0);

  seedRoom(raw, 'C2');
  seedMember(raw, 'C2', 'ana', 0);
  seedMember(raw, 'C2', 'bo', 4);
}

/** Every user-side cursor, as `user:thread` to `last_read_seq`. */
function cursors(raw: Raw): Record<string, number> {
  const rows = raw
    .prepare(
      'SELECT user_id, thread_kind, thread_id, last_read_seq FROM read_cursors ORDER BY user_id, thread_id'
    )
    .all() as { user_id: string; thread_kind: string; thread_id: string; last_read_seq: number }[];
  return Object.fromEntries(
    rows.map((r) => [`${r.user_id}:${r.thread_kind}:${r.thread_id}`, r.last_read_seq])
  );
}

/** Every membership cursor, as `room:author` to `last_read_seq`. */
function memberships(raw: Raw): Record<string, number> {
  const rows = raw
    .prepare(
      'SELECT room_id, author_id, last_read_seq FROM room_members ORDER BY room_id, author_id'
    )
    .all() as { room_id: string; author_id: string; last_read_seq: number }[];
  return Object.fromEntries(rows.map((r) => [`${r.room_id}:${r.author_id}`, r.last_read_seq]));
}

// --- Tests -------------------------------------------------------------------

describe('0059 — room read cursors move to the people table', () => {
  it('carries every local person forward, and nobody else', () => {
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    expect(cursors(raw)).toEqual({
      // Both local people keep exactly where they were, per room.
      'ana:room:C1': 7,
      'ben:room:C1': 3,
      // Not `ana:room:C2`: a cursor of 0 says nothing that an absent row does
      // not already say, and every read path treats absence as 0.
      // Not `bo:…`: an agent's cursor is what it has been SHOWN, and that stays
      // on the membership row for the ambient loop to advance.
      // Not `tel:…`: a person on Telegram has never read anything here.
    });
  });

  it('leaves every agent cursor exactly where RP3 left it', () => {
    // The one way to break the ambient participation loop from here: an agent
    // whose "already shown" mark moved would either replay a room's history or
    // skip the backlog it was meant to catch up on.
    const raw = databaseAtOldShape();
    seedWorld(raw);
    const before = memberships(raw);

    applyMigration(raw);

    expect(memberships(raw)).toEqual(before);
    expect(memberships(raw)['C1:bo']).toBe(9);
    expect(memberships(raw)['C2:bo']).toBe(4);
  });

  it('stamps every row it writes with a real ISO-8601 instant', () => {
    // The column is read back as `ReadCursor.updatedAt` and handed to a client,
    // so a SQLite-shaped `2026-08-01 00:00:00` would be a second timestamp
    // format on a field that promises one.
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    const rows = raw.prepare('SELECT updated_at FROM read_cursors').all() as {
      updated_at: string;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at);
    }
  });

  it('is idempotent — a replay cannot walk back a cursor that has moved since', () => {
    // The hazard `ON CONFLICT DO NOTHING` closes, built rather than argued: a
    // person reads further AFTER the upgrade, so the live cursor is ahead of the
    // membership column this statement reads. A re-run that overwrote would put
    // them back where they were at upgrade time and re-light rooms they have
    // since finished.
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    raw
      .prepare(
        "UPDATE read_cursors SET last_read_seq = 42 WHERE user_id = 'ana' AND thread_id = 'C1'"
      )
      .run();

    replayBackfill(raw);

    expect(cursors(raw)).toEqual({ 'ana:room:C1': 42, 'ben:room:C1': 3 });
  });

  it('picks up a person who was never in a room at upgrade time on a later run', () => {
    // The complement of the case above: `DO NOTHING` must not mean "write once
    // and never again". A membership that appears after the statement first ran
    // is still copied when it runs again, which is what makes a repaired or
    // re-run upgrade converge rather than freeze.
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    seedRoom(raw, 'C3');
    seedMember(raw, 'C3', 'ana', 5);
    replayBackfill(raw);

    expect(cursors(raw)['ana:room:C3']).toBe(5);
  });
});
