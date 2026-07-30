/**
 * Migration 0039 — `engaged` becomes the channel default (room-participation
 * spec §9.4, §9.6).
 *
 * **Why this file exists at all.** 0039 rewrites a column that decides when
 * somebody's agents speak to them, and it writes rows a person will read. It
 * carries no DDL, so `db:check` — which compares the schema files against the
 * snapshot — sees an empty diff and passes whatever this file says. Nothing else
 * looks at it. Same situation as 0038, same answer: the gate is a test that
 * builds the old shape by running the repo's own migration history and then
 * asserts about rows.
 *
 * **What it must not do is as pinned as what it must.** The migration cannot
 * tell a seeded `mention-only` from a chosen one, so every assertion about what
 * it LEAVES ALONE — direct messages, non-`mention-only` values, human
 * memberships — is load-bearing rather than incidental.
 *
 * @module db/tests/engaged-channel-default-migration
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
const TAG = '0039_engaged_channel_default';

/** Its index in the journal — the shape this test builds is everything below it. */
const IDX = 39;

/** The exact words the room says. Changing the copy has to change this line. */
const NOTICE_TEXT =
  'Agents in this channel now stay in the conversation for a few minutes after you talk to them, instead of needing an @mention every time. You can change this per agent in Members.';

type Raw = Database.Database;

/** The statements of 0039, in file order — exactly as the migrator splits them. */
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
 * A database at the shape 0038 left — every migration before 0039 applied, and
 * 0039 itself not.
 *
 * Built by copying the migration folder minus 0039 and truncating the journal,
 * because `migrate()` applies everything the journal lists and there is no
 * "up to N" option. The same construction 0038's test uses, for the same reason:
 * a transcribed fixture is a second copy of the schema and it drifts.
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0038-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < IDX);

  // A renumbered 0039 would leave this asserting against a shape that already
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
 * Apply 0039 the way production does: through drizzle's own migrator, over the
 * repo's real migration folder.
 *
 * **Not `exec` per chunk, and the difference is the point.** `Database#exec`
 * happily runs a chunk holding two statements; the migrator PREPARES each one,
 * and `prepare` takes exactly one. So a file that violates the one-statement
 * rule passes an `exec`-driven test and takes down every startup. Driving the
 * real migrator means the rule is enforced by execution rather than asserted in
 * a comment.
 *
 * The connection already carries `__drizzle_migrations` rows for 0000-0038
 * (see {@link databaseAtOldShape}), so this applies exactly what an upgrading
 * install applies: 0039, and the index swap in 0040 behind it.
 */
function applyMigration(raw: Raw): void {
  migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
}

/**
 * Apply 0039's statements again by hand, one prepared statement per chunk.
 *
 * The migrator will not run a migration twice — that is what
 * `__drizzle_migrations` is for — so the only way to ask "what would a second
 * run do" is to drive the statements directly. Prepared rather than `exec`ed,
 * so this path holds the same one-statement rule the migrator does.
 */
function applyStatementsAgain(raw: Raw): void {
  for (const chunk of migrationStatements()) raw.prepare(chunk).run();
}

// --- Fixture -----------------------------------------------------------------

/** Insert an author row of the given kind. */
function seedAuthor(raw: Raw, id: string, kind: string, naturalKey: string): void {
  raw
    .prepare(
      'INSERT INTO authors (id, kind, natural_key, display_name, emoji, color, created_at) VALUES (?,?,?,?,?,?,?)'
    )
    .run(id, kind, naturalKey, id, null, null, '2026-07-01T00:00:00Z');
}

/** Insert a room. */
function seedRoom(
  raw: Raw,
  r: { id: string; kind: string; archived?: boolean; lastActivityAt?: string }
): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, workspace_id, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      r.id,
      r.kind,
      r.kind === 'channel' ? r.id.toLowerCase() : null,
      r.id,
      null,
      null,
      r.archived ? 1 : 0,
      '2026-07-01T00:00:00Z',
      r.lastActivityAt ?? '2026-07-01T00:00:00Z'
    );
}

/** Insert a post. */
function seedEntry(raw: Raw, e: { roomId: string; seq: number; id: string; author: string }): void {
  raw
    .prepare(
      'INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, mentions, session_id, cascade_root, cascade_depth, parent_entry_id, thread_root_entry_id, signature, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      e.roomId,
      e.seq,
      e.id,
      e.author,
      'post',
      JSON.stringify({ text: e.id }),
      '[]',
      null,
      e.id,
      0,
      null,
      null,
      null,
      '2026-07-02T10:00:00Z'
    );
}

/** Insert a membership. */
function seedMember(raw: Raw, roomId: string, authorId: string, responseMode: string): void {
  raw
    .prepare(
      'INSERT INTO room_members (room_id, author_id, response_mode, joined_at, last_read_seq) VALUES (?,?,?,?,?)'
    )
    .run(roomId, authorId, responseMode, '2026-07-01T00:00:00Z', 0);
}

/**
 * The world this migration has to survive.
 *
 * ```
 * C1  channel, 2 entries   — ana mention-only, bo always, the operator
 * C2  channel, 0 entries   — ana mention-only                (empty room)
 * C3  channel, 1 entry     — ana silent, bo direct-only      (nothing to widen)
 * C4  channel, archived    — ana mention-only                (moves, stays quiet)
 * C5  channel, 1 entry     — the OPERATOR is mention-only    (inert, not an agent)
 * D1  dm                   — ana mention-only                (never touched)
 * ```
 *
 * C3 and C5 are the two ways a channel can look affected and not be, and both
 * are the reason the notice is scoped rather than written per channel.
 */
function seedWorld(raw: Raw): void {
  seedAuthor(raw, 'ana', 'agent', '/agents/ana');
  seedAuthor(raw, 'bo', 'agent', '/agents/bo');
  seedAuthor(raw, 'me', 'human', 'local');

  seedRoom(raw, { id: 'C1', kind: 'channel' });
  seedEntry(raw, { roomId: 'C1', seq: 1, id: 'c1e1', author: 'me' });
  seedEntry(raw, { roomId: 'C1', seq: 2, id: 'c1e2', author: 'ana' });
  seedMember(raw, 'C1', 'ana', 'mention-only');
  seedMember(raw, 'C1', 'bo', 'always');
  seedMember(raw, 'C1', 'me', 'always');

  seedRoom(raw, { id: 'C2', kind: 'channel' });
  seedMember(raw, 'C2', 'ana', 'mention-only');

  seedRoom(raw, { id: 'C3', kind: 'channel' });
  seedEntry(raw, { roomId: 'C3', seq: 1, id: 'c3e1', author: 'me' });
  seedMember(raw, 'C3', 'ana', 'silent');
  seedMember(raw, 'C3', 'bo', 'direct-only');

  seedRoom(raw, { id: 'C4', kind: 'channel', archived: true });
  seedMember(raw, 'C4', 'ana', 'mention-only');

  seedRoom(raw, { id: 'C5', kind: 'channel' });
  seedEntry(raw, { roomId: 'C5', seq: 1, id: 'c5e1', author: 'me' });
  seedMember(raw, 'C5', 'me', 'mention-only');

  seedRoom(raw, { id: 'D1', kind: 'dm' });
  seedMember(raw, 'D1', 'ana', 'mention-only');
}

/** Every membership, as `room:author` to `responseMode`. */
function modes(raw: Raw): Record<string, string> {
  const rows = raw
    .prepare(
      'SELECT room_id, author_id, response_mode FROM room_members ORDER BY room_id, author_id'
    )
    .all() as { room_id: string; author_id: string; response_mode: string }[];
  return Object.fromEntries(rows.map((r) => [`${r.room_id}:${r.author_id}`, r.response_mode]));
}

/** Every notice this migration wrote, oldest room first. */
function notices(raw: Raw): {
  room_id: string;
  seq: number;
  id: string;
  author_id: string;
  kind: string;
  body: string;
  cascade_root: string;
  cascade_depth: number;
  parent_entry_id: string | null;
  thread_root_entry_id: string | null;
  created_at: string;
}[] {
  return raw
    .prepare(
      "SELECT room_id, seq, id, author_id, kind, body, cascade_root, cascade_depth, parent_entry_id, thread_root_entry_id, created_at FROM room_entries WHERE kind = 'notice' ORDER BY room_id"
    )
    .all() as ReturnType<typeof notices>;
}

// --- Tests -------------------------------------------------------------------

describe('0039 — engaged becomes the channel default', () => {
  describe('what it rewrites', () => {
    it('moves every agent channel membership off mention-only and touches nothing else', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      expect(modes(raw)).toEqual({
        // Widened: an agent, in a live channel, sitting on the old seed.
        'C1:ana': 'engaged',
        'C2:ana': 'engaged',
        // ARCHIVED, so it does not move. An archived room refuses its own voice,
        // so it cannot be told — and a widening nobody can be told about is the
        // one thing this migration must not do. Was widened and was told are the
        // same set, by construction (statement 6 reads the notice plan).
        'C4:ana': 'mention-only',
        // A value somebody could have chosen. The column has no provenance, so
        // the only safe rule is to leave every non-`mention-only` value alone.
        'C1:bo': 'always',
        'C1:me': 'always',
        'C3:ana': 'silent',
        'C3:bo': 'direct-only',
        // A human is never auto-triggered, so this value is inert and stays.
        'C5:me': 'mention-only',
        // A direct message seeds from the manifest and is out of scope entirely.
        'D1:ana': 'mention-only',
      });
    });

    /**
     * The invariant the whole migration is shaped around, asserted as a set
     * comparison rather than as a list of room ids — a hand-written list passes
     * for the wrong reason the moment the fixture grows a room.
     *
     * "Absence is never consent" cashes out as: nothing widened without being
     * told. An archived channel is the case that makes it bite, because it is
     * the one room that cannot receive a notice.
     */
    it('widens exactly the rooms it told, and no others', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      const before = modes(raw);
      applyMigration(raw);
      const after = modes(raw);

      const widened = Object.keys(after)
        .filter((key) => before[key] !== after[key])
        .map((key) => key.split(':')[0]);
      expect([...new Set(widened)].sort()).toEqual(
        notices(raw)
          .map((n) => n.room_id)
          .sort()
      );
    });

    it('leaves an archived channel exactly as it was, because it cannot be told', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      expect(modes(raw)['C4:ana']).toBe('mention-only');
      // Not merely un-noticed: untouched. `postNotice` refuses an archived room
      // (ROOM_ARCHIVED), so a widening here could never be announced anywhere.
      expect(notices(raw).map((n) => n.room_id)).not.toContain('C4');
    });

    it('leaves a database with no rooms in it completely alone', () => {
      const raw = databaseAtOldShape();
      applyMigration(raw);

      expect(raw.prepare('SELECT COUNT(*) AS n FROM room_entries').get()).toEqual({ n: 0 });
      // No affected room means no notice, which means no reason to mint the
      // system author. An install that has never opened a room must not gain one.
      expect(raw.prepare('SELECT COUNT(*) AS n FROM authors').get()).toEqual({ n: 0 });
    });
  });

  describe('the notice', () => {
    it('writes exactly one per widened room, and none anywhere else', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      // C3 had nothing to widen, C5's only `mention-only` row is a person's, C4
      // is archived and refuses its own voice, D1 is a direct message.
      expect(notices(raw).map((n) => n.room_id)).toEqual(['C1', 'C2']);
    });

    it('says what changed, in the room’s own voice, under its own code', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      for (const notice of notices(raw)) {
        expect(JSON.parse(notice.body)).toEqual({
          text: NOTICE_TEXT,
          notice: 'addressing_changed',
        });
      }
    });

    it('lands as a well-formed top-level entry the log can already render', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      const system = raw
        .prepare("SELECT id FROM authors WHERE kind = 'system' AND natural_key = 'system'")
        .get() as { id: string };
      const [c1, c2] = notices(raw);

      // Appended, never inserted: C1 already held two entries, C2 none.
      expect(c1!.seq).toBe(3);
      expect(c2!.seq).toBe(1);
      for (const notice of [c1!, c2!]) {
        expect(notice.author_id).toBe(system.id);
        expect(notice.kind).toBe('notice');
        // Its own cascade root at depth 0 — it answers no exchange, which is
        // what `postNotice` writes for a notice with no cascade behind it.
        expect(notice.cascade_root).toBe(notice.id);
        expect(notice.cascade_depth).toBe(0);
        // Top level, so everyone in the channel reads it.
        expect(notice.parent_entry_id).toBeNull();
        expect(notice.thread_root_entry_id).toBeNull();
        // A real ULID: 26 Crockford base32 characters, timestamp half first.
        expect(notice.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(decodeUlidTime(notice.id)).toBe(Date.parse(notice.created_at));
      }
      // One event, one instant. Both rows share it.
      expect(c1!.created_at).toBe(c2!.created_at);
      expect(c1!.id).not.toBe(c2!.id);
    });

    it('mints the system author only when the install has never had one', () => {
      const fresh = databaseAtOldShape();
      seedWorld(fresh);
      applyMigration(fresh);
      expect(
        fresh.prepare("SELECT COUNT(*) AS n FROM authors WHERE kind = 'system'").get()
      ).toEqual({ n: 1 });

      const existing = databaseAtOldShape();
      seedWorld(existing);
      seedAuthor(existing, 'sys-already-here', 'system', 'system');
      applyMigration(existing);

      // Reused, not duplicated — a second system author would split the room's
      // own voice across two identities.
      expect(existing.prepare("SELECT id FROM authors WHERE kind = 'system'").all()).toEqual([
        { id: 'sys-already-here' },
      ]);
      for (const notice of notices(existing)) {
        expect(notice.author_id).toBe('sys-already-here');
      }
    });

    it('stops a widened room being listed as quiet while holding an entry nobody has seen', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      const activity = Object.fromEntries(
        (
          raw.prepare('SELECT id, last_activity_at FROM rooms ORDER BY id').all() as {
            id: string;
            last_activity_at: string;
          }[]
        ).map((r) => [r.id, r.last_activity_at])
      );
      const stamped = notices(raw)[0]!.created_at;

      expect(activity.C1).toBe(stamped);
      expect(activity.C2).toBe(stamped);
      // Nothing was written into these, so nothing about them changed.
      expect(activity.C3).toBe('2026-07-01T00:00:00Z');
      expect(activity.C4).toBe('2026-07-01T00:00:00Z');
      expect(activity.C5).toBe('2026-07-01T00:00:00Z');
      expect(activity.D1).toBe('2026-07-01T00:00:00Z');
    });
  });

  describe('the shape of the file', () => {
    it('gives the migrator exactly one statement per chunk, no more and no less', () => {
      // drizzle's migrator splits on the breakpoint marker and PREPARES each
      // chunk. `prepare` refuses both ways: a comment-only chunk throws "The
      // supplied SQL string contains no statements" and a two-statement chunk
      // throws "contains more than one statement" — either one takes down every
      // startup and every test in this package. This file is comment-heavy by
      // necessity, so the rule is asserted against the real verb rather than
      // against a regex that only sees one half of it.
      for (const chunk of migrationStatements()) {
        expect(withoutComments(chunk)).not.toBe('');
      }
      // And the verb itself, in order, because a later chunk reads a temp table
      // an earlier one creates and cannot be prepared on its own.
      const raw = databaseAtOldShape();
      seedWorld(raw);
      expect(() => applyStatementsAgain(raw)).not.toThrow();
    });

    it('leaves the connection no temp table to trip over', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_temp_master WHERE name IN ('engaged_default_plan','engaged_default_stamp')"
          )
          .all()
      ).toEqual([]);
    });
  });

  describe('idempotency', () => {
    it('changes nothing the second time it runs', () => {
      const raw = databaseAtOldShape();
      seedWorld(raw);
      applyMigration(raw);

      const entries = raw.prepare('SELECT * FROM room_entries ORDER BY room_id, seq').all();
      const members = raw.prepare('SELECT * FROM room_members ORDER BY room_id, author_id').all();
      const rooms = raw.prepare('SELECT * FROM rooms ORDER BY id').all();
      const authors = raw.prepare('SELECT * FROM authors ORDER BY id').all();

      // `__drizzle_migrations` means this never happens in production, which is
      // exactly why the migrator cannot be used to ask the question: it would
      // decline and prove nothing. The failure this guards against is a second
      // notice in every room, which a person reads as the change happening
      // twice.
      applyStatementsAgain(raw);

      expect(raw.prepare('SELECT * FROM room_entries ORDER BY room_id, seq').all()).toEqual(
        entries
      );
      expect(raw.prepare('SELECT * FROM room_members ORDER BY room_id, author_id').all()).toEqual(
        members
      );
      expect(raw.prepare('SELECT * FROM rooms ORDER BY id').all()).toEqual(rooms);
      expect(raw.prepare('SELECT * FROM authors ORDER BY id').all()).toEqual(authors);
    });
  });
});

/** The milliseconds a ULID's first ten characters encode. */
function decodeUlidTime(id: string): number {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let ms = 0;
  for (const char of id.slice(0, 10)) ms = ms * 32 + alphabet.indexOf(char);
  return ms;
}
