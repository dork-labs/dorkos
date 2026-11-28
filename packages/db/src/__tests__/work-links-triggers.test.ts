/**
 * The append-only triggers on `work_links` survive every migration (DOR-4972).
 * Drizzle does not know triggers exist, so a migration that rebuilds the table
 * drops them, and only a hand-copied `WORK_LINKS_APPEND_ONLY_TRIGGERS` puts
 * them back. These run every migration and hold each rebuild to that copy, so
 * the next rebuild cannot forget them.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { WORK_LINKS_APPEND_ONLY_TRIGGERS } from '../schema/work-graph/work-links.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** The journal index of DOR-4972's rebuild of `work_links`. */
const REBUILD_IDX = 223;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Run the migrations up to and including one journal index on `db`. */
function migrateThrough(db: Db, lastIdx: number): void {
  const directory = mkdtempSync(join(tmpdir(), 'work-links-triggers-'));
  directories.push(directory);
  mkdirSync(join(directory, 'meta'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= lastIdx);
  for (const entry of journal.entries as { tag: string }[]) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  }
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
  migrate(db, { migrationsFolder: directory });
}

describe('work_links stays append-only through every migration', () => {
  it('has both triggers, as written once, after all migrations', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const stored = db.$client
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'work_links'")
      .all() as { sql: string }[];
    expect(stored.map((row) => `${row.sql};`).sort()).toEqual(
      [...WORK_LINKS_APPEND_ONLY_TRIGGERS].sort()
    );
  });

  it('refuses UPDATE and DELETE after all migrations', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    db.$client
      .prepare(
        `INSERT INTO work_links (id, from_ref, to_ref, relation, recorded_at, source)
         VALUES ('01J0000000000000000000000A', 'dork:chat:a', 'DOR-1', 'claims', '2026-11-26T10:00:00.000Z', 'claim-tool')`
      )
      .run();
    expect(() => db.$client.prepare("UPDATE work_links SET source = 'x'").run()).toThrow(
      /work links are append-only/
    );
    expect(() => db.$client.prepare('DELETE FROM work_links').run()).toThrow(
      /work links are append-only/
    );
  });

  it('ends every migration that rebuilds the table with both triggers, copied exactly', () => {
    const rebuilds = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) =>
        /CREATE TABLE `(__new_)?work_links`/.test(readFileSync(join(MIGRATIONS, name), 'utf8'))
      );
    expect(rebuilds.length).toBeGreaterThanOrEqual(2);
    for (const name of rebuilds) {
      const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
      for (const trigger of WORK_LINKS_APPEND_ONLY_TRIGGERS) expect(sql, name).toContain(trigger);
    }
  });

  it('keeps every row through the rebuild', () => {
    const db = createDb(':memory:');
    migrateThrough(db, REBUILD_IDX - 1);
    const insert = db.$client.prepare(
      `INSERT INTO work_links (id, from_ref, to_ref, relation, recorded_at, recording_chat_id, source, turn_marks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // One row of each kind of edge the table held before: their ends, sources and marks differ.
    const at = '2026-11-25T10:00:00.000Z';
    insert.run(
      '01J0000000000000000000000B',
      'dork:chat:a',
      'DOR-1',
      'works_on',
      at,
      'a',
      'open-pr',
      '{}'
    );
    insert.run(
      '01J0000000000000000000000C',
      'dork:chat:a',
      'owner/repo#4',
      'opened',
      at,
      'a',
      'open-pr',
      '{"outsider":true}'
    );
    insert.run(
      '01J0000000000000000000000D',
      'dork:chat:b',
      'dork:chat:a',
      'started',
      at,
      null,
      'server',
      null
    );
    insert.run(
      '01J0000000000000000000000E',
      'dork:chat:a',
      'dork:todo:T1',
      'produced',
      at,
      null,
      'server',
      null
    );
    insert.run(
      '01J0000000000000000000000F',
      'dork:chat:c',
      'dork:chat:a',
      'forked_from',
      at,
      null,
      'server',
      null
    );
    insert.run(
      '01J0000000000000000000000G',
      'dork:chat:d',
      'dork:chat:c',
      'rekeyed_from',
      at,
      null,
      'server',
      null
    );
    insert.run(
      '01J0000000000000000000000H',
      'dork:chat:a',
      'worktree:wt-a',
      'opened',
      at,
      null,
      'server',
      null
    );
    insert.run(
      '01J0000000000000000000000J',
      'dork:chat:a',
      'DOR-1',
      'claims',
      at,
      null,
      'server',
      null
    );
    const before = db.$client.prepare('SELECT * FROM work_links').all();
    migrateThrough(db, REBUILD_IDX);
    expect(before).toHaveLength(8);
    expect(db.$client.prepare('SELECT * FROM work_links').all()).toEqual(before);
  });
});
