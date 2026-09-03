/**
 * Migration 0085 — "one DM per member set", and the backfill that makes it
 * survivable on an install that already has duplicates (DOR-1616).
 *
 * **Why this file exists at all.** `db:generate` wrote 0085's `ALTER TABLE` and
 * its `CREATE UNIQUE INDEX`; the `UPDATE` between them is hand-written, and
 * `scripts/assert-migrations-current.sh` compares the SCHEMA FILES against the
 * snapshot, so it cannot see a statement about rows. This is the only gate on
 * it — the same situation 0061's and 0057's backfills are in, and the same
 * answer.
 *
 * **What it has to prove, and why each half matters.** Without the backfill the
 * index would guard nothing: every DM on every existing install would carry a
 * NULL key, so the first time somebody re-opened a conversation they already
 * had they would get a second one beside it. With an UNCONDITIONAL backfill the
 * `CREATE UNIQUE INDEX` would abort on any install that already holds duplicate
 * DMs — which is reachable today, and is exactly the install the fix is for —
 * bricking the upgrade for the people who need it most. So the statement keys
 * ONE room per member set, chosen by the order `RoomStore.findDmByMemberSet`
 * itself used to resolve those duplicates by.
 *
 * @module db/tests/dm-member-key-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { canonicalDmMemberKey } from '../schema/rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '0085_milky_black_queen';

/** Its index in the journal — the shape this test builds is everything below it. */
const IDX = 85;

type Raw = Database.Database;

/**
 * A database at the shape 0084 left: `rooms` has no `dm_member_key`, so a DM's
 * member set is a fact about `room_members` and nothing can constrain it.
 *
 * Built by copying the migration folder minus 0085 and truncating the journal,
 * because `migrate()` applies everything the journal lists and there is no
 * "up to N" option — the construction 0061's test uses, for the same reason: a
 * transcribed fixture is a second copy of the schema and it drifts.
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0084-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < IDX);

  // A renumbered 0085 would leave this asserting against a shape that already
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
 * Apply 0085 the way production does: through drizzle's own migrator, over the
 * repo's real migration folder.
 *
 * **Not `exec` on the file's text, and the difference is the point.**
 * `Database#exec` happily runs a chunk holding two statements; the migrator
 * PREPARES each one, and `prepare` takes exactly one. So a file that violates
 * the one-statement rule passes an `exec`-driven test and takes down every
 * startup — which matters more here than usual, since this file was edited by
 * hand after generation.
 */
function applyMigration(raw: Raw): void {
  migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
}

// --- Fixture -----------------------------------------------------------------

/** Insert an author row. */
function seedAuthor(raw: Raw, id: string): void {
  raw
    .prepare(
      'INSERT INTO authors (id, kind, natural_key, display_name, created_at) VALUES (?,?,?,?,?)'
    )
    .run(id, id === 'ME' ? 'human' : 'agent', `/authors/${id}`, id, '2026-01-01T00:00:00.000Z');
}

/**
 * Insert a room and its whole roster.
 *
 * @param raw - The database.
 * @param id - The room id, which is also its title so a failure names itself.
 * @param opts.kind - `'dm'` unless said otherwise.
 * @param opts.members - The roster.
 * @param opts.archived - Whether it is put away.
 * @param opts.createdAt - What the duplicate tie-break reads.
 * @param opts.bridge - Give it a `room_bridges` row, making it a projection of
 *   a platform chat rather than a conversation of its own.
 */
function seedRoom(
  raw: Raw,
  id: string,
  opts: {
    kind?: 'dm' | 'channel';
    members?: readonly string[];
    archived?: boolean;
    createdAt?: string;
    bridge?: string;
  } = {}
): void {
  const kind = opts.kind ?? 'dm';
  const createdAt = opts.createdAt ?? '2026-01-01T00:00:00.000Z';
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, archived, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      kind,
      kind === 'channel' ? id.toLowerCase() : null,
      id,
      null,
      opts.archived ? 1 : 0,
      createdAt,
      createdAt
    );
  for (const authorId of opts.members ?? []) {
    raw
      .prepare(
        'INSERT INTO room_members (room_id, author_id, response_mode, joined_at, joined_seq, last_read_seq) VALUES (?,?,?,?,?,?)'
      )
      .run(id, authorId, 'engaged', createdAt, 0, 0);
  }
  if (opts.bridge) {
    raw
      .prepare(
        'INSERT INTO room_bridges (room_id, adapter_id, chat_id, channel_type, platform_chat_type, binding_id, visibility, deliver_notices, last_delivered_seq, last_activity_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        'tg-main',
        opts.bridge,
        null,
        'private',
        `binding-${opts.bridge}`,
        'unknown',
        1,
        0,
        createdAt,
        createdAt
      );
  }
}

/**
 * The world this backfill has to survive — every shape that can be in `rooms`
 * when the upgrade lands.
 *
 * ```
 * DM_LIVE_OLD   dm       ME+ANA        live,     2026-01-02  ─┐ three rooms, one
 * DM_LIVE_NEW   dm       ME+ANA        live,     2026-01-03   │ member set: only
 * DM_ARCHIVED   dm       ME+ANA        archived, 2025-01-01  ─┘ the first is keyed
 * DM_TRIO       dm       ME+ANA+KAI    live                     unique, keyed
 * DM_EMPTY      dm       (nobody)      live                     no set to key by
 * DM_BRIDGED    dm       ME+ANA        live, bridged            identity is the bridge
 * CHANNEL       channel  ME+ANA        live                     identity is #slug
 * ```
 */
function seedWorld(raw: Raw): void {
  for (const id of ['ME', 'ANA', 'KAI']) seedAuthor(raw, id);

  seedRoom(raw, 'DM_LIVE_OLD', { members: ['ME', 'ANA'], createdAt: '2026-01-02T00:00:00.000Z' });
  seedRoom(raw, 'DM_LIVE_NEW', { members: ['ME', 'ANA'], createdAt: '2026-01-03T00:00:00.000Z' });
  seedRoom(raw, 'DM_ARCHIVED', {
    members: ['ME', 'ANA'],
    archived: true,
    createdAt: '2025-01-01T00:00:00.000Z',
  });
  seedRoom(raw, 'DM_TRIO', { members: ['ME', 'ANA', 'KAI'] });
  seedRoom(raw, 'DM_EMPTY', {});
  seedRoom(raw, 'DM_BRIDGED', { members: ['ME', 'ANA'], bridge: '555' });
  seedRoom(raw, 'CHANNEL', { kind: 'channel', members: ['ME', 'ANA'] });
}

/** Every room's stored key, by room id. */
function keys(raw: Raw): Record<string, string | null> {
  const rows = raw.prepare('SELECT id, dm_member_key FROM rooms ORDER BY id').all() as {
    id: string;
    dm_member_key: string | null;
  }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.dm_member_key]));
}

/** Open a DM directly, the way a second writer would. */
function insertDm(raw: Raw, id: string, key: string | null): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, archived, dm_member_key, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(id, 'dm', null, id, null, 0, key, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
}

// --- Tests -------------------------------------------------------------------

describe('0085 — one DM per member set', () => {
  it('keys exactly one room per member set, and never fails on an install that has duplicates', () => {
    // The brick test. An unconditional backfill would write `ANA,ME` onto three
    // rows here and the `CREATE UNIQUE INDEX` would abort, taking down every
    // startup on precisely the installs this migration is for.
    const raw = databaseAtOldShape();
    seedWorld(raw);

    applyMigration(raw);

    expect(keys(raw)).toEqual({
      // Live before archived, oldest first — `findDmByMemberSet`'s own order, so
      // the room a fresh open resolves to is the room it already resolved to.
      DM_LIVE_OLD: 'ANA,ME',
      DM_LIVE_NEW: null,
      DM_ARCHIVED: null,
      DM_TRIO: 'ANA,KAI,ME',
      // No roster is no member set. `findDmByMemberSet([])` has always answered
      // null, so this room was already unreachable that way.
      DM_EMPTY: null,
      // A bridged private chat's roster is byte-identical to the operator's own
      // DM with that agent; inside the dedupe it would be handed back as one.
      DM_BRIDGED: null,
      // A channel is identified by `#slug`, and `rooms_channel_slug_unique` is
      // already its constraint.
      CHANNEL: null,
    });
  });

  it('prefers a LIVE duplicate even when the archived one is older and sorts first', () => {
    // Named so that every order the statement could have fallen back on — id,
    // insertion, `created_at` alone — points at the archived room. Only
    // `ORDER BY archived, created_at` produces this answer, and it has to,
    // because archiving is reversible and a keyed archived room would be the one
    // a re-open un-archives while the live conversation sat beside it unreachable.
    const raw = databaseAtOldShape();
    for (const id of ['ME', 'ANA']) seedAuthor(raw, id);
    seedRoom(raw, 'AAA_ARCHIVED', {
      members: ['ME', 'ANA'],
      archived: true,
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    seedRoom(raw, 'ZZZ_LIVE', { members: ['ME', 'ANA'], createdAt: '2026-01-01T00:00:00.000Z' });

    applyMigration(raw);

    expect(keys(raw)).toEqual({ AAA_ARCHIVED: null, ZZZ_LIVE: 'ANA,ME' });
  });

  it('writes the same string `canonicalDmMemberKey` would', () => {
    // The drift pin. The key is spelled twice — once as SQL in the backfill and
    // once as TypeScript for every write after it — and the two have to agree
    // byte for byte or the backfill is worse than useless: every re-open of an
    // existing conversation would miss its own room and mint a second one.
    // `group_concat`'s separator, its explicit `ORDER BY`, and JavaScript's
    // default sort are all being compared here at once.
    const raw = databaseAtOldShape();
    for (const id of ['ME', 'ANA', 'KAI']) seedAuthor(raw, id);
    seedRoom(raw, 'PAIR', { members: ['ME', 'ANA'] });
    // Inserted deliberately out of order, so a statement that concatenated in
    // roster order rather than sorted order would produce `ME,KAI,ANA`.
    seedRoom(raw, 'TRIO', { members: ['ME', 'KAI', 'ANA'] });

    applyMigration(raw);

    expect(keys(raw)).toEqual({
      PAIR: canonicalDmMemberKey(['ANA', 'ME']),
      TRIO: canonicalDmMemberKey(['ME', 'KAI', 'ANA']),
    });
    // And the same set named in any order is the same key, which is what makes
    // the lookup order-independent.
    expect(keys(raw).TRIO).toBe(canonicalDmMemberKey(['KAI', 'ANA', 'ME']));
  });

  it('leaves the index refusing a second DM for a keyed member set', () => {
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    expect(() => insertDm(raw, 'DM_RACE', 'ANA,ME')).toThrow(
      /UNIQUE constraint failed: rooms\.dm_member_key/
    );
    expect(() => insertDm(raw, 'DM_TRIO_RACE', 'ANA,KAI,ME')).toThrow(
      /UNIQUE constraint failed: rooms\.dm_member_key/
    );
  });

  it('leaves the index PARTIAL, so every NULL-key room still coexists', () => {
    // The half that makes the migration's choice survivable. If the index
    // treated NULLs as one value, the duplicates it deliberately left alone —
    // and every bridged chat — would have been unable to sit in the table beside
    // each other at all.
    const raw = databaseAtOldShape();
    seedWorld(raw);
    applyMigration(raw);

    expect(() => insertDm(raw, 'DM_UNKEYED_1', null)).not.toThrow();
    expect(() => insertDm(raw, 'DM_UNKEYED_2', null)).not.toThrow();
    expect(() => insertDm(raw, 'DM_OTHER', 'KAI,ME')).not.toThrow();
  });

  it('keys nothing on an install that has no rooms at all', () => {
    // A fresh install takes 0085 with an empty table, and a statement that
    // depended on finding something would fail the very first boot.
    const raw = databaseAtOldShape();
    applyMigration(raw);
    expect(keys(raw)).toEqual({});
  });
});
