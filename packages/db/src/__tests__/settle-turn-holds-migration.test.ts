/**
 * Upgrade to 0168 (DOR-3203): every chat that ran before `last_turn_held`
 * existed is recorded as not held, and a chat recorded as held keeps its hold.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

describe('0168 settle turn holds migration', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  /** Migrate up to and including one journal index, no further. */
  function migrateThrough(lastIdx: number) {
    const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= lastIdx);
    for (const entry of journal.entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
    migrate(db, { migrationsFolder: directory });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'settle-turn-holds-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
    migrateThrough(167);
  });

  afterEach(() => {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function chat(id: string, held: 0 | 1 | null) {
    db.$client
      .prepare(
        'INSERT INTO session_metadata (session_id, created_at, last_turn_held) VALUES (?, ?, ?)'
      )
      .run(id, '2026-10-20T12:00:00.000Z', held);
  }

  function heldOf(id: string) {
    return (
      db.$client
        .prepare('SELECT last_turn_held AS held FROM session_metadata WHERE session_id = ?')
        .get(id) as { held: number | null }
    ).held;
  }

  it('records a chat with no hold as not held, and keeps every recorded answer', () => {
    chat('before-the-column', null);
    chat('held-by-a-stranger', 1);
    chat('not-held', 0);

    migrateThrough(168);

    expect(heldOf('before-the-column')).toBe(0);
    expect(heldOf('held-by-a-stranger')).toBe(1);
    expect(heldOf('not-held')).toBe(0);
  });

  it('a later upgrade clears every hold the old rules wrote (DOR-3440)', () => {
    chat('held-by-a-stranger', 1);

    runMigrations(db);

    expect(heldOf('held-by-a-stranger')).toBe(0);
  });
});
