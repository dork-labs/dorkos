import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every server test file is one the server's vitest run picks up (DOR-4940).
 *
 * `apps/server/vitest.config.ts` includes only `__tests__` folders, plus the
 * space server's code, which keeps two tests beside their source. A
 * `*.test.ts` anywhere else is never run, and nothing says so: it reads as a
 * passing test to anyone who opens it. This census reads the `include` globs
 * from that config, so the exception here and the one there are the same
 * line, and fails on any server test file none of them matches.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = 'apps/server';
const ALWAYS_INCLUDED = 'src/**/__tests__/**/*.test.ts';

/** The `test.include` globs of the server's vitest config, relative to `apps/server`. */
function serverIncludes(): string[] {
  const config = readFileSync(path.join(ROOT, SERVER, 'vitest.config.ts'), 'utf8');
  const testBlock = config.slice(config.indexOf('test: {'));
  const list = /\binclude:\s*\[([^\]]*)\]/.exec(testBlock)?.[1] ?? '';
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Every `*.test.ts(x)` under `apps/server/src`, tracked or new, relative to `apps/server`. */
function serverTestFiles(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'src/*.test.ts',
      'src/*.test.tsx',
    ],
    { cwd: path.join(ROOT, SERVER), encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean);
}

describe('the server test location census', () => {
  const includes = serverIncludes();
  const files = serverTestFiles();

  it('read the config and the tree, so it cannot pass on nothing', () => {
    expect(includes).toContain(ALWAYS_INCLUDED);
    expect(files.length).toBeGreaterThan(1000);
  });

  it('every server test file is reached by the vitest include', () => {
    const neverRun = files.filter((file) => !includes.some((glob) => path.matchesGlob(file, glob)));
    expect(
      neverRun.map((file) => `${SERVER}/${file}`),
      'These tests never run. Move each into a __tests__ folder beside its source.'
    ).toEqual([]);
  });
});
