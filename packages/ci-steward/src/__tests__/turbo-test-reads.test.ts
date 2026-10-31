/**
 * Every suite names, as turbo `inputs`, the files outside its package that its
 * tests read, and names them without sweeping in gitignored files (DOR-3518,
 * ledger 261031-170302).
 *
 * A pull request runs the suites whose turbo task HASH its change moved
 * (scripts/pr-test-plan.sh), and a hash covers only declared files. So a read a
 * suite never declared is a change its pull request will not test. The reads
 * below were found by an audit of every unit test outside `apps/e2e` and proved
 * by a dry-run probe: a one-line change to each moves the reader's hash.
 *
 * THE GITIGNORED-FILE TRAP. `$TURBO_DEFAULT$` skips gitignored files, but an
 * explicit `$TURBO_ROOT$/…` glob does not: measured, a file under
 * `packages/evals/.turbo/` moved the server hash under `packages/**`, and
 * vitest's own cache under `scripts/node_modules/` moved ci-steward's under
 * `scripts/**`. A hash that moves on build output or a cache file never matches
 * between base and head, so the plan would run that suite every time and a
 * local cache would never replay it. Hence the rule pinned below: no input
 * sweeps a whole package directory, and `scripts/**` excludes its
 * `node_modules`.
 *
 * @module __tests__/turbo-test-reads
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The repository root, four levels above this file. */
const ROOT = resolve(import.meta.dirname, '../../../..');

/** The fields of a turbo task definition this guard reads. */
interface TurboTask {
  /** What must build before the task runs. */
  dependsOn?: string[];
  /** Whether turbo may replay a previous run. */
  cache?: boolean;
  /** The file set the task's hash is computed over. */
  inputs?: string[];
}

/** `turbo.json`'s tasks, parsed. */
const tasks = (
  JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
    tasks?: Record<string, TurboTask>;
  }
).tasks!;

/** Per suite, a sample of the outside reads the audit found, root-relative. */
const READS: Readonly<Record<string, readonly string[]>> = {
  '@dorkos/server#test': [
    'docs/**',
    'contributing/**',
    '.github/**',
    'apps/client/src/**',
    'packages/*/src/**',
    'packages/db/drizzle/**',
    '.env.example',
    'turbo.json',
  ],
  '@dorkos/harness#test': ['.agents/harness.manifest.json', 'meta/harness-smoke/**', 'turbo.json'],
  '@dorkos/test-utils#test': ['turbo.json'],
  '@dorkos/site#test': ['docs/**', 'apps/server/src/**', 'scripts/lib/code-only.mjs'],
  '@dorkos/client#test': ['scripts/lib/code-only.mjs', 'apps/design-system/src/**'],
  'dorkos#test': ['apps/e2e/community-two-desktop/**'],
  '@dorkos/marketplace#test': ['apps/server/src/services/marketplace/fixtures/valid-shape/**'],
  '@dorkos/evals#test': ['turbo.json'],
  '@dorkos/ci-steward#test': ['turbo.json'],
};

describe('every suite declares what it reads outside its package', () => {
  it.each(Object.entries(READS))('%s names its outside reads', (task, reads) => {
    expect(tasks[task]?.inputs, `${task} is gone from turbo.json`).toBeDefined();
    expect(tasks[task]?.inputs).toEqual(
      expect.arrayContaining(reads.map((read) => `$TURBO_ROOT$/${read}`))
    );
  });

  it('every package-scoped test override keeps its own files and the base task', () => {
    // A package-scoped `inputs` REPLACES the default set, and a package-scoped
    // task does not merge with the base `test` definition.
    const overrides = Object.entries(tasks).filter(([id, t]) => id.endsWith('#test') && t.inputs);
    expect(overrides.length).toBeGreaterThanOrEqual(Object.keys(READS).length);
    for (const [id, task] of overrides) {
      expect(task.inputs, id).toContain('$TURBO_DEFAULT$');
      expect(task.dependsOn, id).toEqual(expect.arrayContaining(['^build']));
      expect(task.cache, id).toBe(tasks.test?.cache);
    }
  });
});

describe('no input sweeps in gitignored files', () => {
  it('no input globs a whole package directory or the whole apps/ or packages/ tree', () => {
    const sweeping = Object.entries(tasks).flatMap(([id, task]) =>
      (task.inputs ?? [])
        .filter((input) => /^\$TURBO_ROOT\$\/(apps|packages)(\/[^/*]+)?\/\*\*$/.test(input))
        .map((input) => `${id}: ${input}`)
    );
    expect(
      sweeping,
      'Spell a cross-package read as source globs (src/**, scripts/**, package.json), ' +
        'never `**` over a package: it would hash dist/, node_modules/ and .turbo/.'
    ).toEqual([]);
  });

  it('a scripts/** input excludes the node_modules vitest writes its cache into', () => {
    for (const [id, task] of Object.entries(tasks)) {
      if (!task.inputs?.includes('$TURBO_ROOT$/scripts/**')) continue;
      expect(task.inputs, id).toContain('!$TURBO_ROOT$/scripts/node_modules/**');
    }
  });
});
