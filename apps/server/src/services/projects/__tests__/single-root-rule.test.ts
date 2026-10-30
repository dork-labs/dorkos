/**
 * Invariant 5 of spec `flow-multiproject`: one root rule.
 *
 * Three files used to derive a main checkout from `--git-common-dir` on their
 * own, and they disagreed (a bare repository, a relative common dir, a symlink
 * each read differently in one of them). Only `resolve-project-root.ts` may run
 * that git call now. Two carve-outs ask a different question. The rooms
 * domain reads a room's own private repository, with a ceiling so git cannot
 * climb out of it. The repo settings check (DOR-3298) keys a security record
 * by the shared git folder itself, read fresh on every launch, never a cached
 * project root: an agent can re-point a worktree's `.git` between turns.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSrc = path.resolve(import.meta.dirname, '..', '..', '..');

/** The only non-test files allowed to name the flag, relative to `apps/server/src`. */
const ALLOWED = new Set([
  'services/projects/resolve-project-root.ts',
  'services/rooms/repo/room-repo-git.ts',
  'services/runtimes/claude-code/repo-settings/repo-git.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

describe('the single project-root rule', () => {
  it('finds the server source to scan (so the check below cannot pass vacuously)', () => {
    const files = sourceFiles(serverSrc).map((file) => path.relative(serverSrc, file));
    expect(files).toContain('services/projects/resolve-project-root.ts');
    expect(files.length).toBeGreaterThan(100);
  });

  it('lets no other server file run --git-common-dir', () => {
    const offenders = sourceFiles(serverSrc)
      .filter((file) => readFileSync(file, 'utf8').includes('--git-common-dir'))
      .map((file) => path.relative(serverSrc, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });
});
