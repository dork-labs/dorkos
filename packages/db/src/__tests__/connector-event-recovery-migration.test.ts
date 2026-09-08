/** Upgrade preserves immutable approved event scopes while adding private recovery scheduling. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

it('upgrades 0092 consent in place with nullable recovery timing and no changed decisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'event-recovery-upgrade-'));
  const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
  const db = createDb(':memory:');
  try {
    mkdirSync(join(directory, 'meta'));
    const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 92);
    for (const entry of journal.entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
    migrate(db, { migrationsFolder: directory });
    const decision = JSON.stringify([
      { scope: { filter: { label: 'Work' } }, manageExistingTriggers: false },
    ]);
    db.$client
      .prepare(
        'INSERT INTO connector_event_consent_commands (owner_kind,owner_id,review_id,request_hash,selections_json,created_at) VALUES (?,?,?,?,?,?)'
      )
      .run('user', 'owner', 'review', 'immutable-hash', decision, '2026-09-07T12:00:00.000Z');
    runMigrations(db);
    expect(db.$client.prepare('SELECT * FROM connector_event_consent_commands').get()).toEqual({
      owner_kind: 'user',
      owner_id: 'owner',
      review_id: 'review',
      request_hash: 'immutable-hash',
      selections_json: decision,
      created_at: '2026-09-07T12:00:00.000Z',
      recovery_after: null,
    });
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='connector_event_consent_recovery_idx'"
        )
        .get()
    ).toBeDefined();
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
