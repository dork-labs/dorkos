/**
 * Migration 0057 — the ambient window's two columns, and the backfill that makes
 * one of them true on an install that already has rooms (room-participation spec
 * §8.3).
 *
 * **Why this file exists at all.** `db:generate` writes the two `ALTER TABLE`
 * statements and stops; the backfill under them is hand-written, and
 * `scripts/assert-migrations-current.sh` compares the SCHEMA FILES against the
 * snapshot, so it cannot see the backfill and passes whatever it says. Same
 * situation as 0038 and 0039, same answer: the gate is a test that builds the
 * old shape by running the repo's own migration history and then asserts about
 * rows.
 *
 * **What the backfill is FOR.** `joined_seq` defaults to 0, and 0 means "was in
 * this room before its first message". Left at the default, every membership
 * that predates this migration would claim to have been present for the whole
 * log — and the first ambient turn after RP3 ships would replay a channel's
 * entire history to an agent that joined it yesterday.
 *
 * @module db/tests/ambient-pending-migration
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
const TAG = '0057_tidy_sphinx';

/** Its index in the journal — the shape this test builds is everything below it. */
const IDX = 57;

type Raw = Database.Database;

/** The statements of 0057, in file order — exactly as the migrator splits them. */
function migrationStatements(): string[] {
  return readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8').split(
    '--> statement-breakpoint'
  );
}

/**
 * A database at the shape 0056 left — every migration before 0057 applied, and
 * 0057 itself not.
 *
 * Built by copying the migration folder minus 0057 and truncating the journal,
 * because `migrate()` applies everything the journal lists and there is no
 * "up to N" option. The same construction 0038's and 0039's tests use, for the
 * same reason: a transcribed fixture is a second copy of the schema and it
 * drifts.
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0056-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < IDX);

  // A renumbered 0057 would leave this asserting against a shape that already
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
 * Apply 0057 the way production does: through drizzle's own migrator, over the
 * repo's real migration folder.
 *
 * **Not `exec` per chunk, and the difference is the point.** `Database#exec`
 * happily runs a chunk holding two statements; the migrator PREPARES each one,
 * and `prepare` takes exactly one. So a file that violates the one-statement
 * rule passes an `exec`-driven test and takes down every startup.
 */
function applyMigration(raw: Raw): void {
  migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
}

/**
 * Apply 0057's backfill again by hand, one prepared statement per chunk.
 *
 * The migrator will not run a migration twice — that is what
 * `__drizzle_migrations` is for — so the only way to ask "what would a second
 * run do" is to drive the statement directly. The two `ALTER`s above it would
 * throw `duplicate column name`, which is itself the answer for those, so only
 * the backfill is replayed here.
 */
function replayBackfill(raw: Raw): void {
  const chunks = migrationStatements();
  raw.prepare(chunks[chunks.length - 1]).run();
}

// --- Fixture -----------------------------------------------------------------

/** Insert a room. */
function seedRoom(raw: Raw, id: string, kind = 'channel'): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, workspace_id, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(id, kind, kind === 'channel' ? id.toLowerCase() : null, id, null, null, 0, T(0), T(0));
}

/** A stable instant, `minutes` after the fixture's epoch. */
function T(minutes: number): string {
  return new Date(Date.UTC(2026, 6, 1, 0, minutes, 0)).toISOString();
}

/** Insert a post at `seq`, stamped `minutes` after the epoch. */
function seedEntry(raw: Raw, roomId: string, seq: number, minutes: number): void {
  const id = `${roomId}-e${seq}`;
  raw
    .prepare(
      'INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, mentions, session_id, cascade_root, cascade_depth, parent_entry_id, thread_root_entry_id, signature, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      roomId,
      seq,
      id,
      'me',
      'post',
      JSON.stringify({ text: id }),
      '[]',
      null,
      id,
      0,
      null,
      null,
      null,
      T(minutes)
    );
}

/** Insert a membership that joined `minutes` after the epoch. */
function seedMember(raw: Raw, roomId: string, authorId: string, minutes: number): void {
  raw
    .prepare(
      'INSERT INTO room_members (room_id, author_id, response_mode, joined_at, last_read_seq) VALUES (?,?,?,?,?)'
    )
    .run(roomId, authorId, 'engaged', T(minutes), 0);
}

/**
 * The world this backfill has to survive.
 *
 * ```
 * C1  4 entries at minutes 1,2,3,4
 *       founder  joined at minute 0  — before anything was said
 *       late     joined at minute 3  — while entry 3 was being written
 *       newest   joined at minute 9  — after everything
 * C2  no entries
 *       lonely   joined at minute 5
 * ```
 */
function seedWorld(raw: Raw): void {
  seedRoom(raw, 'C1');
  for (const seq of [1, 2, 3, 4]) seedEntry(raw, 'C1', seq, seq);
  seedMember(raw, 'C1', 'founder', 0);
  seedMember(raw, 'C1', 'late', 3);
  seedMember(raw, 'C1', 'newest', 9);

  seedRoom(raw, 'C2');
  seedMember(raw, 'C2', 'lonely', 5);
}

/** Every membership's floor, as `room:author` to `joined_seq`. */
function floors(raw: Raw): Record<string, number> {
  const rows = raw
    .prepare('SELECT room_id, author_id, joined_seq FROM room_members ORDER BY room_id, author_id')
    .all() as { room_id: string; author_id: string; joined_seq: number }[];
  return Object.fromEntries(rows.map((r) => [`${r.room_id}:${r.author_id}`, r.joined_seq]));
}

// --- Tests -------------------------------------------------------------------

describe('0057 — the ambient window columns', () => {
  it('gives every existing room the default cap', () => {
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    const rows = raw.prepare('SELECT id, ambient_max_entries FROM rooms ORDER BY id').all() as {
      id: string;
      ambient_max_entries: number;
    }[];
    // 30 is the number the hardcoded cap this replaces already used, so an
    // upgrade changes nothing about what any existing room shows.
    expect(rows).toEqual([
      { id: 'C1', ambient_max_entries: 30 },
      { id: 'C2', ambient_max_entries: 30 },
    ]);
  });

  it('backfills each membership floor from what was said before it joined', () => {
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    expect(floors(raw)).toEqual({
      // Joined before a word was said: nothing is behind them, and 0 is the
      // honest floor rather than the default standing in for one.
      'C1:founder': 0,
      // Joined at the instant entry 3 was written. The comparison is STRICT, so
      // an entry stamped at the join instant is on the inclusive side: you are in
      // the room from the moment you join it.
      'C1:late': 2,
      // Joined after everything: the whole log is behind them.
      'C1:newest': 4,
      // An empty room has nothing to be behind.
      'C2:lonely': 0,
    });
  });

  it('never puts a floor above the log, so nothing can hide a visible entry', () => {
    // The acceptance criterion, asserted as an invariant over every row rather
    // than as the four numbers above — a hand-written list stops discriminating
    // the moment the fixture grows a membership.
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    const rows = raw
      .prepare(
        `SELECT m.room_id, m.author_id, m.joined_seq,
                COALESCE((SELECT MAX(e.seq) FROM room_entries e WHERE e.room_id = m.room_id), 0) AS top
         FROM room_members m`
      )
      .all() as { room_id: string; author_id: string; joined_seq: number; top: number }[];
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.joined_seq).toBeLessThanOrEqual(row.top);
  });

  it('is idempotent — replaying it cannot walk a floor that has already been stamped', () => {
    // The hazard `WHERE joined_seq = 0` closes, built rather than argued: an
    // entry whose `seq` is higher than everything else and whose `created_at` is
    // OLDER than a member's join. Timestamps are the writer's, `seq` is the
    // room's, and the two do not have to agree — a bridge importing a chat's
    // backlog writes exactly this shape. A re-run that recomputed every row
    // would push both floors below FORWARD, past entries those members can see.
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    // Somebody joins after the upgrade and is stamped at the top of the log the
    // way `RoomStore.addMember` stamps them.
    seedMember(raw, 'C1', 'fresh', 12);
    raw.prepare("UPDATE room_members SET joined_seq = 4 WHERE author_id = 'fresh'").run();
    // And now the out-of-order entry lands: seq 5, stamped at minute 6.
    seedEntry(raw, 'C1', 5, 6);
    const before = floors(raw);

    replayBackfill(raw);

    expect(floors(raw)).toEqual(before);
    expect(floors(raw)['C1:fresh']).toBe(4);
    expect(floors(raw)['C1:newest']).toBe(4);
  });
});
