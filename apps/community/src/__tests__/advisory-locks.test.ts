/**
 * Every numeric PostgreSQL advisory lock key has exactly one purpose. Two unrelated callers
 * sharing a key serialise for no reason, and deadlock when either takes row locks after it: the
 * erasure journal once reused the community-creation key, and an erasure finishing on a
 * community an owner was claiming deadlocked the claim (DOR-2566).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Each key, what it serialises, and exactly the files (relative to src/) that take it. Moving
 * one of these files, as the routes split will, means updating its entry here.
 */
const REGISTRY: Record<string, { purpose: string; files: string[] }> = {
  '77281502': { purpose: 'applying migrations', files: ['migrate.ts'] },
  '77281503': {
    purpose: 'creating or claiming a community (bootstrap, host create, owner claim, import)',
    files: [
      'app.ts',
      'routes/host/owner-claims.ts',
      'routes/host/imports.ts',
      'routes/host/host.ts',
    ],
  },
  '77281504': { purpose: 'assigning handles', files: ['handles.ts'] },
  '77281505': { purpose: 'appending to the erasure journal', files: ['erasure/journal.ts'] },
  '77281506': {
    purpose: 'taking ownership through an owner replacement claim',
    files: ['owner-replacement/claim.ts'],
  },
};

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * A number handed to any advisory lock function (`pg_advisory_*`, `pg_try_advisory_*`, lock or
 * unlock, shared or not), written as a literal or inside a template string (`${77281503}`), or a
 * `…_LOCK = <number>` constant handed to one.
 */
const LOCK_KEY =
  /pg_(?:try_)?advisory(?:_xact)?_(?:un)?lock(?:_shared)?\(\s*(?:\$\{\s*)?['"`]?(\d+)|\b[A-Z_]*LOCK\s*=\s*['"`]?(\d{5,})\b/g;

// Purpose: fails if a numeric advisory lock key is taken by a file outside its one purpose, or
// if a key is used that the registry above does not name.
it('keeps every advisory lock key to one purpose', () => {
  const uses: { key: string; file: string }[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(LOCK_KEY))
      uses.push({ key: match[1] ?? match[2], file: relative(SRC, path) });
  }
  // The scan really sees the call sites, so an empty result cannot pass vacuously.
  expect(new Set(uses.map((use) => use.key))).toEqual(new Set(Object.keys(REGISTRY)));
  const misplaced = uses.filter((use) => !REGISTRY[use.key]?.files.includes(use.file));
  expect(misplaced).toEqual([]);
  // Every listed file still takes its key, so a stale entry cannot hide a move.
  for (const [key, entry] of Object.entries(REGISTRY))
    for (const file of entry.files)
      expect(uses, `${file} takes ${key}`).toContainEqual({ key, file });
});
