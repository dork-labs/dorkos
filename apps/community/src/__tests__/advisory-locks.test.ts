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

/** Each key, what it serialises, and the files (relative to src/) allowed to take it. */
const REGISTRY: Record<string, { purpose: string; files: RegExp }> = {
  '77281502': { purpose: 'applying migrations', files: /^migrate\.ts$/ },
  '77281503': {
    purpose: 'creating or claiming a community (bootstrap, host create, owner claim, import)',
    files: /^(app\.ts|routes\/.+\.ts)$/,
  },
  '77281504': { purpose: 'assigning handles', files: /^handles\.ts$/ },
  '77281505': { purpose: 'appending to the erasure journal', files: /^erasure\/journal\.ts$/ },
};

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** A literal key in a lock call, or a `…_LOCK = <number>` constant handed to one. */
const LOCK_KEY =
  /pg_advisory(?:_xact)?_lock(?:_shared)?\(\s*(\d+)\s*\)|\b[A-Z_]*LOCK\s*=\s*(\d{5,})\b/g;

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
  const misplaced = uses.filter((use) => !REGISTRY[use.key]?.files.test(use.file));
  expect(misplaced).toEqual([]);
});
