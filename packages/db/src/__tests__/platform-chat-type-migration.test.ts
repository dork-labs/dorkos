/**
 * Migration 0052 — `unclaimed_chats.platform_chat_type` (DOR-907).
 *
 * A purely additive, nullable column: it carries the RAW platform chat type a
 * sighting arrived as (`private`/`group`/`supergroup`/`channel`), so a binding
 * claimed from the row can tell a real group from a folded broadcast. This test
 * builds the database at the shape 0051 left, proves the column did not exist
 * there, applies the migration, and shows an old row reads NULL while a new row
 * round-trips a real value — the back-compat guarantee the bridge action leans
 * on (an old sighting with no type takes the conservative path).
 *
 * @module db/tests/platform-chat-type-migration
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
const TAG = '0052_ambitious_prism';
/** Its index in the journal — the shape this test builds is everything below it. */
const IDX = 52;

type Raw = Database.Database;

/** The column names of `unclaimed_chats`, as sqlite reports them. */
function columns(raw: Raw): string[] {
  return (raw.prepare('PRAGMA table_info(unclaimed_chats)').all() as { name: string }[]).map(
    (c) => c.name
  );
}

/**
 * A database at the shape 0051 left — every migration before 0052 applied, and
 * 0052 itself not. Built by copying the migration folder minus 0052 and
 * truncating the journal, the same construction the other migration tests use
 * (there is no "up to N" option on the migrator).
 */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-0051-'));
  mkdirSync(path.join(folder, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < IDX);

  // A renumbered 0052 would leave this asserting against a shape that already
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
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return sqlite;
}

/** Apply 0052 the way production does — the real migrator over the real folder. */
function applyMigration(raw: Raw): void {
  migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
}

/** Insert one `unclaimed_chats` row at the OLD shape (no platform_chat_type). */
function seedOldRow(raw: Raw, id: string, chatKind: string): void {
  raw
    .prepare(
      'INSERT INTO unclaimed_chats (id, adapter_id, chat_id, channel_type, chat_kind, sender_name, sender_id, chat_title, status, message_count, first_seen_at, last_seen_at, decided_at, decided_agent_id) ' +
        "VALUES (?,?,?,?,?,?,?,?, 'pending', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', NULL, NULL)"
    )
    .run(id, 'tg-bot', id, chatKind === 'group' ? 'group' : null, chatKind, null, null, null);
}

describe('0052 — unclaimed_chats.platform_chat_type (DOR-907)', () => {
  it('the column does not exist before the migration', () => {
    const raw = databaseAtOldShape();
    expect(columns(raw)).not.toContain('platform_chat_type');
  });

  it('adds a nullable platform_chat_type column and leaves existing rows NULL', () => {
    const raw = databaseAtOldShape();
    seedOldRow(raw, 'old-group', 'group');
    applyMigration(raw);

    expect(columns(raw)).toContain('platform_chat_type');
    // A pre-migration row survives with NULL — the "unknown type" the bridge
    // action falls back to its conservative DM-only rule for.
    const row = raw
      .prepare(
        "SELECT platform_chat_type AS t, chat_kind AS k FROM unclaimed_chats WHERE id = 'old-group'"
      )
      .get() as { t: string | null; k: string };
    expect(row.t).toBeNull();
    expect(row.k).toBe('group');
  });

  it('round-trips a written platform_chat_type value, distinct from the folded chat_kind', () => {
    const raw = databaseAtOldShape();
    applyMigration(raw);

    raw
      .prepare(
        'INSERT INTO unclaimed_chats (id, adapter_id, chat_id, channel_type, chat_kind, platform_chat_type, status, message_count, first_seen_at, last_seen_at) ' +
          "VALUES ('bc', 'tg-bot', 'bc', 'group', 'group', 'channel', 'pending', 1, '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z')"
      )
      .run();

    const row = raw
      .prepare(
        "SELECT platform_chat_type AS t, chat_kind AS k FROM unclaimed_chats WHERE id = 'bc'"
      )
      .get() as { t: string; k: string };
    // A broadcast: folded to `group` for routing, but the raw type survives.
    expect(row.t).toBe('channel');
    expect(row.k).toBe('group');
  });
});
