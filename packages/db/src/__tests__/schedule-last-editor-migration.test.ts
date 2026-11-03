/**
 * The DOR-3703 upgrade: every schedule's last editor starts as the agent
 * that proposed it, so no agent approves a schedule it made, and a schedule no
 * agent proposed keeps no editor, so no agent may approve it.
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
).entries.find((entry) => entry.tag.endsWith('_dor3703_schedule_last_editor'))!.idx;

describe('the schedule last editor migration (DOR-3703)', () => {
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
    directory = mkdtempSync(join(tmpdir(), 'schedule-last-editor-'));
    mkdirSync(join(directory, 'meta'));
    db = createDb(':memory:');
    migrateThrough(MIGRATION_IDX - 1);
  });

  afterEach(() => {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function schedule(
    id: string,
    proposedByAgentPath: string | null,
    proposedBySessionId: string | null
  ) {
    db.$client
      .prepare(
        `INSERT INTO pulse_schedules (id, name, cron, prompt, file_path, created_at, updated_at,
           proposed_by_agent_path, proposed_by_session_id)
         VALUES (?, ?, '0 3 * * *', 'sweep', '', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?, ?)`
      )
      .run(id, id, proposedByAgentPath, proposedBySessionId);
  }

  function editorOf(id: string) {
    return db.$client
      .prepare(
        `SELECT last_edited_by_agent_path AS path, last_edited_by_session_id AS session,
           agent_approval_key AS key FROM pulse_schedules WHERE id = ?`
      )
      .get(id) as { path: string | null; session: string | null; key: string | null };
  }

  it('sets each schedule’s last editor to its proposer, and leaves one nobody proposed empty', () => {
    schedule('from-an-agent', '/agents/a', 'ses-a');
    schedule('from-a-person', null, null);

    migrateThrough(MIGRATION_IDX);

    expect(editorOf('from-an-agent')).toEqual({ path: '/agents/a', session: 'ses-a', key: null });
    expect(editorOf('from-a-person')).toEqual({ path: null, session: null, key: null });
  });

  it('marks a person’s own approved schedule as person-approved, and no agent’s proposal', () => {
    schedule('from-an-agent', '/agents/a', 'ses-a');
    schedule('from-a-person', null, null);
    db.$client.prepare("UPDATE pulse_schedules SET approved_content_key = 'k1'").run();

    migrateThrough(MIGRATION_IDX);

    const personKey = (id: string) =>
      (
        db.$client
          .prepare('SELECT person_approved_key AS key FROM pulse_schedules WHERE id = ?')
          .get(id) as { key: string | null }
      ).key;
    expect(personKey('from-a-person')).toBe('k1');
    expect(personKey('from-an-agent')).toBeNull();
  });
});
