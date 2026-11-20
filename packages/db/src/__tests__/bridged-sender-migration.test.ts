/**
 * The DOR-4593 migration: every chat that exists before `bridged_sender` is recorded as a
 * stranger's for good, so no later turn can vouch for words nobody recorded the sender of. Only a
 * chat started after the migration begins with no record.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../index.js';

/** The journal index of the migration under test, found by its tag so a renumber cannot hide it. */
const MIGRATION_IDX = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../drizzle/meta/_journal.json', import.meta.url)),
      'utf8'
    )
  ) as { entries: { idx: number; tag: string }[] }
).entries.find((entry) => entry.tag.endsWith('_dor4593_bridged_sender'))!.idx;

describe('the bridged-sender migration (DOR-4593)', () => {
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

  /** A chat's row, as a launch leaves it. */
  function chat(id: string, launchOrigin: string) {
    db.$client
      .prepare(
        `INSERT INTO session_metadata (session_id, runtime, launch_origin, created_at)
         VALUES (?, 'claude-code', ?, '2026-11-01T00:00:00.000Z')`
      )
      .run(id, launchOrigin);
  }

  function senderOf(id: string): string | null {
    return (
      db.$client
        .prepare('SELECT bridged_sender AS sender FROM session_metadata WHERE session_id = ?')
        .get(id) as { sender: string | null }
    ).sender;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'bridged-sender-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('records every chat that existed before it as a stranger’s', () => {
    migrateThrough(MIGRATION_IDX - 1);
    chat('per-user-telegram', 'relay-binding');
    chat('owner-dm', 'relay-binding');
    chat('app-chat', 'interactive');
    migrateThrough(MIGRATION_IDX);
    expect(senderOf('per-user-telegram')).toBe('stranger');
    expect(senderOf('owner-dm')).toBe('stranger');
    expect(senderOf('app-chat')).toBe('stranger');
  });

  it('leaves a chat started after it with no record', () => {
    migrateThrough(MIGRATION_IDX);
    chat('new-telegram', 'relay-binding');
    expect(senderOf('new-telegram')).toBeNull();
  });
});
