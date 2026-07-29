/**
 * Migration 0038 — a thread stops being a child room (ADR 260728-022013).
 *
 * **Why this file is heavier than the schema change it guards.** 0038 is the
 * only migration in this repo that rewrites rows a person wrote, and the values
 * it rewrites — `room_entries.seq` — are the same values stored in every
 * `room_members.last_read_seq` and handed out as the SSE resume cursor. Getting
 * it wrong does not throw; it silently points every read cursor in the install
 * at a different message. `db:check` cannot see any of this: it compares the
 * schema files against the snapshot, so the entire hand-written half of 0038 is
 * invisible to it. This file is the only gate.
 *
 * **The old shape is built by running the repo's own migrations 0000-0037**,
 * not by transcribing the DDL into the test. A transcription is a second copy
 * of the schema that drifts, and a seeded shape the product never actually had
 * certifies nothing — so the fixture derives from history and the assertions
 * are about rows.
 *
 * @module db/tests/thread-retirement-migration
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
const TAG = '0038_loose_stepford_cuckoos';

type Raw = Database.Database;

/** The statements of 0038, in file order — exactly as the migrator splits them. */
function migrationStatements(): string[] {
  return readFileSync(path.join(DRIZZLE_DIR, `${TAG}.sql`), 'utf-8').split(
    '--> statement-breakpoint'
  );
}

/** What a chunk carries once its comments are gone. */
function withoutComments(chunk: string): string {
  return chunk.replace(/--[^\n]*/g, '').trim();
}

/**
 * The data half — everything before the generated DDL tail.
 *
 * Matched against the SQL with comments stripped, because this file discusses
 * its own DDL in prose and a raw substring test picks the header up too.
 */
function dataStatements(): string[] {
  return migrationStatements().filter((s) => {
    const sql = withoutComments(s);
    return !sql.startsWith('DROP INDEX') && !sql.startsWith('ALTER TABLE');
  });
}

/**
 * A database at the shape 0037 left — every migration before 0038 applied, and
 * 0038 itself not.
 *
 * Built by copying the migration folder minus 0038 and truncating the journal,
 * because `migrate()` applies everything the journal lists and there is no
 * "up to N" option.
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0037-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < 38);

  // If 0038 is ever renumbered this test would silently start asserting against
  // a shape that already includes it, and every assertion below would pass for
  // the wrong reason.
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

/** Apply 0038 to an already-seeded database, statement by statement. */
function applyMigration(raw: Raw): void {
  for (const statement of migrationStatements()) raw.exec(statement);
}

// --- Fixture -----------------------------------------------------------------

const ROOM_COLS =
  'id, kind, parent_id, slug, title, topic, workspace_id, root_entry_id, archived, created_at, last_activity_at';
const ENTRY_COLS =
  'room_id, seq, id, author_id, kind, body, mentions, session_id, cascade_root, cascade_depth, parent_entry_id, thread_root_entry_id, signature, created_at';

/** Insert a room at the OLD shape. */
function seedRoom(
  raw: Raw,
  r: {
    id: string;
    kind: string;
    parentId?: string | null;
    slug?: string | null;
    rootEntryId?: string | null;
  }
): void {
  raw
    .prepare(`INSERT INTO rooms (${ROOM_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      r.id,
      r.kind,
      r.parentId ?? null,
      r.slug ?? null,
      r.id,
      null,
      null,
      r.rootEntryId ?? null,
      0,
      '2026-07-01T00:00:00Z',
      '2026-07-01T00:00:00Z'
    );
}

/** Insert an entry at the OLD shape — thread pointers null, as a child-room thread's entries were. */
function seedEntry(
  raw: Raw,
  e: { roomId: string; seq: number; id: string; createdAt: string; author?: string }
): void {
  raw
    .prepare(`INSERT INTO room_entries (${ENTRY_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      e.roomId,
      e.seq,
      e.id,
      e.author ?? 'author-ana',
      'post',
      JSON.stringify({ text: e.id }),
      '[]',
      null,
      e.id,
      0,
      null,
      null,
      null,
      e.createdAt
    );
}

/** Insert a membership with a read cursor. */
function seedMember(raw: Raw, roomId: string, authorId: string, lastReadSeq: number): void {
  raw
    .prepare(
      'INSERT INTO room_members (room_id, author_id, response_mode, joined_at, last_read_seq) VALUES (?,?,?,?,?)'
    )
    .run(roomId, authorId, 'mention-only', '2026-07-01T00:00:00Z', lastReadSeq);
}

/**
 * The world this migration has to survive, seeded at the old shape.
 *
 * ```
 * P1  channel, entries 1..3           <- the interesting parent
 *  |- T1  thread on entry e2, entries t1a t1b
 *  |- T2  thread on entry e3, entry t2a
 * P2  channel, entries 1..2, NO threads      <- must come out untouched
 * P3  channel, entry 1, one EMPTY thread T4  <- a thread that moves nothing
 * P4  channel, entry n1
 *  |- TOUT  thread on n1, entry tout1
 *      |- TIN  thread on tout1 — a thread OF a thread
 * P5  channel, entry p5a
 *  |- TA, TB  two threads whose entries collide on `created_at`
 * D1  dm, no entries
 * T3  thread whose parent does not exist, entry t3a
 * ```
 *
 * `created_at` interleaves T1 and T2 so the appended order is provably
 * chronological ACROSS threads and not merely thread-by-thread — and `t1a` and
 * `t2a` deliberately COLLIDE at 10:05, so the plan's tie-breakers are load
 * bearing rather than decorative.
 */
function seedWorld(raw: Raw): void {
  seedRoom(raw, { id: 'P1', kind: 'channel', slug: 'general' });
  seedEntry(raw, { roomId: 'P1', seq: 1, id: 'e1', createdAt: '2026-07-02T10:00:00Z' });
  seedEntry(raw, { roomId: 'P1', seq: 2, id: 'e2', createdAt: '2026-07-02T10:01:00Z' });
  seedEntry(raw, { roomId: 'P1', seq: 3, id: 'e3', createdAt: '2026-07-02T10:02:00Z' });

  // T2 IS SEEDED BEFORE T1, AND THAT IS LOAD-BEARING — do not tidy it.
  //
  // `t2a` and `t1a` share a `created_at` deliberately: timestamps collide, two
  // rooms can be written in the same second, and with only `ORDER BY created_at`
  // the plan's window function has no defined order for that pair. But a tie is
  // not enough to CATCH the missing tie-breakers. The join walks `rooms` in
  // insertion order, so if the room seeded first is also the one the `room_id`
  // tie-breaker would put first, the broken ordering and the correct one agree
  // and the mutation is invisible. Measured: with T1 seeded first, stripping the
  // tie-breakers leaves all 55 tests green.
  //
  // Seeding T2 first makes the two disagree — the tie-breaker puts T1's entry
  // ahead, the scan order puts T2's — so `ORDER BY e.created_at` alone reverses
  // this pair and the append assertion goes red.
  seedRoom(raw, { id: 'T2', kind: 'thread', parentId: 'P1', rootEntryId: 'e3' });
  seedEntry(raw, { roomId: 'T2', seq: 1, id: 't2a', createdAt: '2026-07-02T10:05:00Z' });

  seedRoom(raw, { id: 'T1', kind: 'thread', parentId: 'P1', rootEntryId: 'e2' });
  seedEntry(raw, { roomId: 'T1', seq: 1, id: 't1a', createdAt: '2026-07-02T10:05:00Z' });
  seedEntry(raw, { roomId: 'T1', seq: 2, id: 't1b', createdAt: '2026-07-02T10:07:00Z' });

  seedRoom(raw, { id: 'P2', kind: 'channel', slug: 'quiet' });
  seedEntry(raw, { roomId: 'P2', seq: 1, id: 'q1', createdAt: '2026-07-02T11:00:00Z' });
  seedEntry(raw, { roomId: 'P2', seq: 2, id: 'q2', createdAt: '2026-07-02T11:01:00Z' });

  seedRoom(raw, { id: 'P3', kind: 'channel', slug: 'sparse' });
  seedEntry(raw, { roomId: 'P3', seq: 1, id: 's1', createdAt: '2026-07-02T12:00:00Z' });
  seedRoom(raw, { id: 'T4', kind: 'thread', parentId: 'P3', rootEntryId: 's1' });

  // A thread OF a thread — the other half of statement 1's eligibility join,
  // and the case statement 4's own comment names. Unreachable through the API
  // (one level was refused at the service boundary), but the guard that handles
  // it is invisible without a row that exercises it: dropping
  // `AND p.kind <> 'thread'` passes every other test in this file while moving
  // TIN's entries into TOUT, which statement 9 then deletes out from under them.
  seedRoom(raw, { id: 'P4', kind: 'channel', slug: 'nested' });
  seedEntry(raw, { roomId: 'P4', seq: 1, id: 'n1', createdAt: '2026-07-02T13:30:00Z' });
  seedRoom(raw, { id: 'TOUT', kind: 'thread', parentId: 'P4', rootEntryId: 'n1' });
  seedEntry(raw, { roomId: 'TOUT', seq: 1, id: 'tout1', createdAt: '2026-07-02T13:35:00Z' });
  seedRoom(raw, { id: 'TIN', kind: 'thread', parentId: 'TOUT', rootEntryId: 'tout1' });
  seedEntry(raw, { roomId: 'TIN', seq: 1, id: 'tin1', createdAt: '2026-07-02T13:40:00Z' });
  seedEntry(raw, { roomId: 'TIN', seq: 2, id: 'tin2', createdAt: '2026-07-02T13:41:00Z' });

  // The SECOND colliding pair, seeded in the OPPOSITE arrangement to P1's, so
  // the tie-breaker is pinned by a mechanism rather than by the "do not tidy it"
  // comment above. P1 seeds the larger room id first, so its tie-break disagrees
  // with the scan order; P5 seeds the smaller one first, so its tie-break agrees.
  // Whichever direction the planner walks `rooms`, exactly one of the two pairs
  // disagrees with it — so a rename, or a plan change, cannot make BOTH blind at
  // once the way one pair alone can.
  seedRoom(raw, { id: 'P5', kind: 'channel', slug: 'ties' });
  seedEntry(raw, { roomId: 'P5', seq: 1, id: 'p5a', createdAt: '2026-07-02T14:00:00Z' });
  seedRoom(raw, { id: 'TA', kind: 'thread', parentId: 'P5', rootEntryId: 'p5a' });
  seedEntry(raw, { roomId: 'TA', seq: 1, id: 'ta1', createdAt: '2026-07-02T14:05:00Z' });
  seedRoom(raw, { id: 'TB', kind: 'thread', parentId: 'P5', rootEntryId: 'p5a' });
  seedEntry(raw, { roomId: 'TB', seq: 1, id: 'tb1', createdAt: '2026-07-02T14:05:00Z' });

  seedRoom(raw, { id: 'D1', kind: 'dm' });

  seedRoom(raw, { id: 'T3', kind: 'thread', parentId: 'no-such-room', rootEntryId: 'gone' });
  seedEntry(raw, { roomId: 'T3', seq: 1, id: 't3a', createdAt: '2026-07-02T13:00:00Z' });

  // Cursors on P1. Every one of these is a different answer.
  seedMember(raw, 'P1', 'alice', 3); // caught up everywhere
  seedMember(raw, 'P1', 'bob', 3); // caught up in P1, behind in T1
  seedMember(raw, 'P1', 'carol', 1); // behind in P1
  seedMember(raw, 'P1', 'dave', 0); // has read nothing
  seedMember(raw, 'P1', 'erin', 3); // caught up in P1, never in either thread
  seedMember(raw, 'T1', 'alice', 2);
  seedMember(raw, 'T2', 'alice', 1);
  seedMember(raw, 'T1', 'bob', 0);
  seedMember(raw, 'T2', 'bob', 1);
  seedMember(raw, 'T1', 'carol', 0);
  seedMember(raw, 'T2', 'carol', 0);

  seedMember(raw, 'P2', 'frank', 1);
  seedMember(raw, 'P3', 'gita', 1);
  seedMember(raw, 'T4', 'gita', 0);
  seedMember(raw, 'T3', 'alice', 0);
}

/** `(roomId, seq)` of every entry, ordered — the shape of the whole log. */
function entriesOf(raw: Raw, roomId: string) {
  return raw
    .prepare(
      'SELECT id, seq, parent_entry_id, thread_root_entry_id FROM room_entries WHERE room_id = ? ORDER BY seq'
    )
    .all(roomId) as {
    id: string;
    seq: number;
    parent_entry_id: string | null;
    thread_root_entry_id: string | null;
  }[];
}

/** One member's read cursor. */
function cursorOf(raw: Raw, roomId: string, authorId: string): number | undefined {
  const row = raw
    .prepare('SELECT last_read_seq FROM room_members WHERE room_id = ? AND author_id = ?')
    .get(roomId, authorId) as { last_read_seq: number } | undefined;
  return row?.last_read_seq;
}

/** What the sidebar badge would draw: entries above the cursor. */
function unreadOf(raw: Raw, roomId: string, authorId: string): number {
  const row = raw
    .prepare(
      `SELECT COUNT(*) AS n FROM room_entries
       WHERE room_id = ? AND seq > (SELECT last_read_seq FROM room_members WHERE room_id = ? AND author_id = ?)`
    )
    .get(roomId, roomId, authorId) as { n: number };
  return row.n;
}

// --- Tests -------------------------------------------------------------------

describe('0038 — retiring the thread room', () => {
  describe('moving entries into the parent', () => {
    it("appends them above the parent's existing log and renumbers nothing that was already there", () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      const before = entriesOf(raw, 'P1');

      applyMigration(raw);

      // The three entries P1 already had keep the exact seqs every stored read
      // cursor and every SSE resume token was minted against. This is the
      // assertion the whole migration is shaped around: interleaving by
      // timestamp would have made t1a seq 4 and pushed nothing, but slotting a
      // reply next to the message it answers would have moved e3 from 3 to 4.
      expect(before.map((e) => [e.id, e.seq])).toEqual([
        ['e1', 1],
        ['e2', 2],
        ['e3', 3],
      ]);
      expect(
        entriesOf(raw, 'P1')
          .slice(0, 3)
          .map((e) => [e.id, e.seq])
      ).toEqual([
        ['e1', 1],
        ['e2', 2],
        ['e3', 3],
      ]);

      // ...and the moved ones land after it, in chronological order ACROSS both
      // threads: t1a and t2a tie at 10:05 and are separated by the room-id
      // tie-breaker ('T1' < 'T2'), then t1b at 10:07.
      expect(entriesOf(raw, 'P1').map((e) => [e.id, e.seq])).toEqual([
        ['e1', 1],
        ['e2', 2],
        ['e3', 3],
        ['t1a', 4],
        ['t2a', 5],
        ['t1b', 6],
      ]);
    });

    it('orders two entries that share a timestamp, so the plan is total', () => {
      // `ORDER BY created_at` alone is not a total order, and a window function
      // over a partial one has no defined answer. `(created_at, room_id, seq)`
      // IS total, because `(room_id, seq)` is the primary key: two rows sharing
      // the first two must differ in the third.
      //
      // What makes this test able to fail is the FIXTURE, not the pragma below:
      // `seedWorld` seeds T2 before T1 so the scan order and the tie-breaker
      // disagree on the colliding pair. `reverse_unordered_selects` is an extra
      // plan stressor and was measured NOT to flip this plan on its own — it is
      // here because it costs nothing, not because it is what discriminates.
      const seqs = [1, 2, 3].map(() => {
        const raw = databaseAtOldShape();
        seedWorld(raw);
        raw.pragma('reverse_unordered_selects = ON');
        applyMigration(raw);
        return entriesOf(raw, 'P1').map((e) => `${e.id}:${e.seq}`);
      });

      expect(seqs[0]).toEqual(['e1:1', 'e2:2', 'e3:3', 't1a:4', 't2a:5', 't1b:6']);
      // Same answer with the scan order deliberately inverted, three times over.
      expect(seqs[1]).toEqual(seqs[0]);
      expect(seqs[2]).toEqual(seqs[0]);

      // ...and the pair seeded the other way round, which is what makes this
      // hold under a plan change rather than only under this plan. `TA` sorts
      // before `TB`, so the tie-breaker puts `ta1` first however `rooms` is
      // walked.
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);
      expect(entriesOf(raw, 'P5').map((e) => `${e.id}:${e.seq}`)).toEqual([
        'p5a:1',
        'ta1:2',
        'tb1:3',
      ]);
    });

    it('points each moved reply back at the message it was answering', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      const byId = new Map(entriesOf(raw, 'P1').map((e) => [e.id, e]));
      // Without this the migration would drop three old replies into #general
      // as brand new top-level messages with nothing connecting them to
      // anything — the reader's first sight of the upgrade.
      expect(byId.get('t1a')).toMatchObject({ parent_entry_id: 'e2', thread_root_entry_id: 'e2' });
      expect(byId.get('t1b')).toMatchObject({ parent_entry_id: 'e2', thread_root_entry_id: 'e2' });
      expect(byId.get('t2a')).toMatchObject({ parent_entry_id: 'e3', thread_root_entry_id: 'e3' });
      // The roots stay top-level, so `countThreadReplies` counts answers and
      // not the opening message.
      expect(byId.get('e2')).toMatchObject({ parent_entry_id: null, thread_root_entry_id: null });
    });

    it('leaves no thread room, and no row still calling itself one', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      expect(raw.prepare("SELECT id FROM rooms WHERE kind = 'thread'").all()).toEqual([]);
      expect(
        raw.prepare("SELECT id FROM rooms WHERE id IN ('T1','T2','T4','TOUT','TA','TB')").all()
      ).toEqual([]);
    });
  });

  describe('read cursors', () => {
    it('advances only the members who had nothing unread anywhere, and moves nobody else', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      // alice: at P1's old end (3) AND had read both threads out. Nothing was
      // unread for her before, so nothing may be unread after.
      expect(cursorOf(raw, 'P1', 'alice')).toBe(6);
      expect(unreadOf(raw, 'P1', 'alice')).toBe(0);

      // erin: at P1's old end and never a member of either thread, so she never
      // had a badge for them either. Inventing one now is the phantom badge.
      expect(cursorOf(raw, 'P1', 'erin')).toBe(6);
      expect(unreadOf(raw, 'P1', 'erin')).toBe(0);

      // bob: at P1's old end but had NOT read T1. That is a real "you missed
      // this", and raising his cursor would delete it with no way to get it
      // back. He keeps the cursor he had.
      expect(cursorOf(raw, 'P1', 'bob')).toBe(3);
      expect(unreadOf(raw, 'P1', 'bob')).toBe(3);

      // carol and dave were behind before and are behind after, by exactly the
      // same messages plus the ones that moved. No cursor is ever lowered and
      // none is raised past something unread.
      expect(cursorOf(raw, 'P1', 'carol')).toBe(1);
      expect(cursorOf(raw, 'P1', 'dave')).toBe(0);
      expect(unreadOf(raw, 'P1', 'carol')).toBe(5);
      expect(unreadOf(raw, 'P1', 'dave')).toBe(6);
    });

    it('repairs a cursor that was already past the end of its room', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      // Nothing legitimate writes this: `setReadCursor` is monotonic but does
      // not clamp, so a client could store a seq beyond the log. It is the one
      // cursor this migration moves DOWN, and calling that out matters because
      // the rule everywhere else is "never raise past something unread".
      raw
        .prepare(
          "UPDATE room_members SET last_read_seq = 99 WHERE room_id = 'P1' AND author_id = 'erin'"
        )
        .run();

      applyMigration(raw);

      // Down from 99 to the room's real end. It pointed at no entry before and
      // points at the newest one after, so nothing readable was lost.
      expect(cursorOf(raw, 'P1', 'erin')).toBe(6);
      expect(unreadOf(raw, 'P1', 'erin')).toBe(0);
    });

    it('never lets a cursor exceed the room it points into', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      const overshoot = raw
        .prepare(
          `SELECT m.room_id, m.author_id FROM room_members m
           WHERE m.last_read_seq > (SELECT COALESCE(MAX(e.seq), 0) FROM room_entries e WHERE e.room_id = m.room_id)`
        )
        .all();
      expect(overshoot).toEqual([]);
    });

    it("drops the thread rooms' own cursors, which have nothing left to point at", () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      expect(
        raw.prepare("SELECT room_id FROM room_members WHERE room_id IN ('T1','T2','T4')").all()
      ).toEqual([]);
    });
  });

  describe('the common install', () => {
    it('is inert for a room with no threads under it', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      const entriesBefore = entriesOf(raw, 'P2');

      applyMigration(raw);

      // P2 is what almost every room in every install looks like. Nothing about
      // it may move: not a seq, not a pointer, not a cursor.
      expect(entriesOf(raw, 'P2')).toEqual(entriesBefore);
      expect(cursorOf(raw, 'P2', 'frank')).toBe(1);
    });

    it('leaves a parent alone when its thread turns out to be empty, and still retires the room', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      // T4 had no entries, so P3 receives nothing and gita's cursor has no
      // reason to move — but T4 itself still goes.
      expect(entriesOf(raw, 'P3').map((e) => [e.id, e.seq])).toEqual([['s1', 1]]);
      expect(cursorOf(raw, 'P3', 'gita')).toBe(1);
      expect(raw.prepare("SELECT id FROM rooms WHERE id = 'T4'").all()).toEqual([]);
    });

    it('runs clean on a database with rooms but no threads at all', () => {
      const raw = databaseAtOldShape();
      seedRoom(raw, { id: 'only', kind: 'channel', slug: 'only' });
      seedEntry(raw, { roomId: 'only', seq: 1, id: 'x1', createdAt: '2026-07-02T10:00:00Z' });
      seedMember(raw, 'only', 'alice', 1);

      expect(() => applyMigration(raw)).not.toThrow();
      expect(entriesOf(raw, 'only').map((e) => [e.id, e.seq])).toEqual([['x1', 1]]);
      expect(cursorOf(raw, 'only', 'alice')).toBe(1);
    });

    it('runs clean on an empty database', () => {
      const raw = databaseAtOldShape();
      expect(() => applyMigration(raw)).not.toThrow();
      expect(raw.prepare('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 0 });
    });
  });

  describe('what hangs off a retiring room', () => {
    it("drops the room's session bindings and keeps the parent's", () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      const insert = raw.prepare(
        'INSERT INTO room_sessions (room_id, author_id, session_id, created_at) VALUES (?,?,?,?)'
      );
      insert.run('T1', 'agent-bo', 'sess-in-thread', '2026-07-02T10:05:00Z');
      insert.run('P1', 'agent-bo', 'sess-in-channel', '2026-07-02T10:00:00Z');

      applyMigration(raw);

      // The binding goes because its room does; the runtime-owned session it
      // pointed at is not ours to delete and is untouched here by construction
      // — this table holds a pointer, not the session.
      expect(
        raw.prepare('SELECT room_id, session_id FROM room_sessions ORDER BY room_id').all()
      ).toEqual([{ room_id: 'P1', session_id: 'sess-in-channel' }]);
    });

    it('clears the message index for the rooms that disappear and only those', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      const msg = raw.prepare(
        'INSERT INTO messages (source_id, origin_key, ordinal, role, created_at, body) VALUES (?,?,?,?,?,?)'
      );
      msg.run('rooms', 'T1', 1, 'user', null, 'said inside the thread');
      msg.run('rooms', 'P1', 1, 'user', null, 'said in the channel');
      msg.run('rooms', 'P2', 1, 'user', null, 'said in the quiet channel');
      msg.run('claude-code', 'T1', 1, 'user', null, 'a session that merely shares an id');
      const src = raw.prepare(
        'INSERT INTO search_sources (source_id, origin_key, last_ordinal, last_indexed_at) VALUES (?,?,?,?)'
      );
      src.run('rooms', 'T1', 2, '2026-07-02T10:10:00Z');
      src.run('rooms', 'P1', 3, '2026-07-02T10:10:00Z');
      src.run('rooms', 'P2', 2, '2026-07-02T10:10:00Z');

      applyMigration(raw);

      // T1's indexed copies would otherwise keep answering searches under a room
      // id that no longer resolves, and no watermark would ever revisit them.
      expect(
        raw
          .prepare('SELECT source_id, origin_key FROM messages ORDER BY source_id, origin_key')
          .all()
      ).toEqual([
        { source_id: 'claude-code', origin_key: 'T1' },
        { source_id: 'rooms', origin_key: 'P1' },
        { source_id: 'rooms', origin_key: 'P2' },
      ]);
      // P1 and P2 keep their watermarks: P1's appended entries sit above its
      // `last_ordinal`, so the next sweep picks them up without a rebuild.
      expect(
        raw.prepare('SELECT origin_key, last_ordinal FROM search_sources ORDER BY origin_key').all()
      ).toEqual([
        { origin_key: 'P1', last_ordinal: 3 },
        { origin_key: 'P2', last_ordinal: 2 },
      ]);
      // The FTS5 index is external-content, so it holds no copy of its own and
      // only the AFTER DELETE trigger can retract the text. A DELETE that
      // bypassed it would leave `MATCH` answering for a message that is gone.
      expect(
        raw
          .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'thread'")
          .get()
      ).toEqual({ n: 0 });
      expect(
        raw
          .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'channel'")
          .get()
      ).toEqual({ n: 2 });
    });

    it('leaves every surviving entry in a room that still exists', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      // The general form of the failure a thread-of-a-thread produces: an entry
      // whose `room_id` names a row statement 9 deleted. Nothing throws when it
      // happens — `room_entries` has no foreign key to `rooms` — so it is only
      // ever found by asking.
      const orphans = raw
        .prepare(
          'SELECT e.room_id, e.id FROM room_entries e WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = e.room_id) ORDER BY e.room_id, e.seq'
        )
        .all();
      expect(orphans).toEqual([]);
    });

    it('refuses to merge a thread whose parent is itself a thread', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      // TOUT hangs off a channel, so it merges normally and its reply points at
      // the message it answered.
      expect(entriesOf(raw, 'P4').map((e) => [e.id, e.seq])).toEqual([
        ['n1', 1],
        ['tout1', 2],
      ]);
      expect(entriesOf(raw, 'P4')[1]).toMatchObject({ thread_root_entry_id: 'n1' });

      // TIN hangs off TOUT, which is retiring, so there is no room for its
      // entries to land in. It keeps them at their own seqs and becomes an
      // archived channel — the same answer statement 4 gives a missing parent.
      // Moving them into TOUT instead would strand them: statement 9 deletes
      // TOUT, and `room_entries` has no foreign key to say so.
      expect(raw.prepare("SELECT kind, archived FROM rooms WHERE id = 'TIN'").get()).toEqual({
        kind: 'channel',
        archived: 1,
      });
      expect(entriesOf(raw, 'TIN').map((e) => [e.id, e.seq])).toEqual([
        ['tin1', 1],
        ['tin2', 2],
      ]);
    });

    it('keeps a thread whose parent is gone, as an archived channel rather than a deletion', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      // Unreachable through the API, but the failure mode if it happens is
      // losing somebody's messages to a column drop. It keeps its log at its own
      // seqs and stays out of the sidebar.
      expect(raw.prepare("SELECT kind, archived FROM rooms WHERE id = 'T3'").get()).toEqual({
        kind: 'channel',
        archived: 1,
      });
      expect(entriesOf(raw, 'T3').map((e) => [e.id, e.seq])).toEqual([['t3a', 1]]);
      expect(cursorOf(raw, 'T3', 'alice')).toBe(0);
    });
  });

  describe('the schema half', () => {
    it('drops both columns and the index', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      const columns = (raw.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map(
        (c) => c.name
      );
      expect(columns).not.toContain('parent_id');
      expect(columns).not.toContain('root_entry_id');
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rooms_parent_id'"
          )
          .all()
      ).toEqual([]);
      // The channel-slug index is on the same table and must survive the drop.
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='rooms_channel_slug_unique'"
          )
          .all()
      ).toEqual([{ name: 'rooms_channel_slug_unique' }]);
    });

    it('needs the DROP INDEX to come first, which is why the order is pinned and not assumed', () => {
      // SQLite refuses `DROP COLUMN` on an indexed column. This repo had never
      // emitted a `DROP INDEX` before 0038, so drizzle-kit's ordering was
      // checked rather than trusted — and this is the check. Reordering the two
      // statements has to fail, or the file's ordering comment is decoration.
      const raw = databaseAtOldShape();
      expect(() => raw.exec('ALTER TABLE `rooms` DROP COLUMN `parent_id`')).toThrow(
        /idx_rooms_parent_id/
      );

      const statements = migrationStatements();
      const dropIndex = statements.findIndex((s) => s.includes('DROP INDEX'));
      const dropColumn = statements.findIndex((s) => s.includes('DROP COLUMN `parent_id`'));
      expect(dropIndex).toBeGreaterThanOrEqual(0);
      expect(dropIndex).toBeLessThan(dropColumn);
    });

    it('carries no comment-only chunk, which the migrator cannot run', () => {
      // Found the hard way: drizzle's migrator splits on the breakpoint marker
      // and PREPARES each chunk, so a free-standing comment block throws "The
      // supplied SQL string contains no statements" and takes down every
      // startup and every test in this package — not just this migration. This
      // file is comment-heavy by necessity, so the rule needs an assertion
      // rather than a convention.
      for (const chunk of migrationStatements()) {
        expect(withoutComments(chunk)).not.toBe('');
      }
    });

    it('leaves the connection no temp table to trip over', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      // The plan is scaffolding. Left behind it would outlive the migration on
      // a long-lived connection and collide with the next run.
      expect(
        raw
          .prepare("SELECT name FROM sqlite_temp_master WHERE name = 'thread_retirement_plan'")
          .all()
      ).toEqual([]);
    });
  });

  describe('idempotency', () => {
    it('changes nothing the second time the data half runs', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);

      // The data statements only — the DDL half is journal-guarded in
      // production and refuses loudly on its own, asserted below.
      const dataOnly = dataStatements();
      for (const s of dataOnly) raw.exec(s);
      const entries = entriesOf(raw, 'P1');
      const cursors = raw.prepare('SELECT * FROM room_members ORDER BY room_id, author_id').all();
      const rooms = raw.prepare('SELECT * FROM rooms ORDER BY id').all();

      for (const s of dataOnly) raw.exec(s);

      expect(entriesOf(raw, 'P1')).toEqual(entries);
      expect(raw.prepare('SELECT * FROM room_members ORDER BY room_id, author_id').all()).toEqual(
        cursors
      );
      expect(raw.prepare('SELECT * FROM rooms ORDER BY id').all()).toEqual(rooms);
    });

    it('refuses the second full run rather than corrupting anything', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);
      const entries = entriesOf(raw, 'P1');

      // `__drizzle_migrations` means this never happens in production. If it
      // somehow did, SQLite refusing to drop an absent index is the loud,
      // harmless outcome — the alternative worth guarding against is a data
      // statement that quietly runs a second time and moves rows twice.
      expect(() => applyMigration(raw)).toThrow();
      expect(entriesOf(raw, 'P1')).toEqual(entries);
    });
  });
});
