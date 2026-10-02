/**
 * Migration 0115 — the per-agent tier ceiling is retired (spec
 * `agent-permissions` phase 3), so `agent_identity_tokens.tier_ceiling` goes.
 *
 * Applied from three starting points, because a DROP COLUMN only has to work on
 * the databases people actually have: a fresh one, one from the phase 2 era
 * (everything through 0107, a token carrying a narrowed ceiling), and one at the
 * last release's shape (everything through 0114). Every one ends with the column
 * gone and the token rows it had kept.
 *
 * @module db/tests/tier-ceiling-drop-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '0115_furry_starjammers';

type Raw = Database.Database;

/** A database with every migration below `idx` applied, and none from it on. */
function databaseBefore(idx: number): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), `dorkos-before-${idx}-`));
  mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const before = journal.entries.filter((e) => e.idx < idx);
  // A renumbered 0115 would build a shape that already has it.
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
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    // The copied migrations are read only here (the database is in memory),
    // so the folder goes now rather than piling up in the temp folder.
    rmSync(folder, { recursive: true, force: true });
  }
  return sqlite;
}

/** Apply everything outstanding, the way production does. */
function applyAll(raw: Raw): void {
  migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
}

/** The token table's column names. */
function columns(raw: Raw): string[] {
  return (raw.prepare('PRAGMA table_info(agent_identity_tokens)').all() as { name: string }[]).map(
    (c) => c.name
  );
}

/** A token row as the old shape stored it, with a narrowed ceiling. */
function seedOldToken(raw: Raw): void {
  raw
    .prepare(
      'INSERT INTO agent_identity_tokens (token_hash, agent_path, display_name, tier_ceiling, created_at) ' +
        "VALUES ('hash-1', '/agents/auditor', 'Auditor', 'observe', '2026-09-01T00:00:00.000Z')"
    )
    .run();
}

describe('migration 0115: the tier ceiling column goes', () => {
  it('leaves a fresh database without the column', () => {
    const raw = new Database(':memory:');
    applyAll(raw);
    expect(columns(raw)).not.toContain('tier_ceiling');
    expect(columns(raw)).toContain('agent_path');
  });

  it.each([
    ['the phase 2 era (through 0107)', 108],
    ['the last release (through 0114)', 115],
  ])('drops it from a database at %s, keeping every token', (_label, idx) => {
    const raw = databaseBefore(idx);
    expect(columns(raw)).toContain('tier_ceiling');
    seedOldToken(raw);

    applyAll(raw);

    expect(columns(raw)).not.toContain('tier_ceiling');
    expect(
      raw.prepare('SELECT token_hash, agent_path, display_name FROM agent_identity_tokens').all()
    ).toEqual([{ token_hash: 'hash-1', agent_path: '/agents/auditor', display_name: 'Auditor' }]);
  });
});
