/**
 * `@dorkos/ci-steward#test` names, as turbo `inputs`, the files outside this
 * package that its suites read (DOR-3518).
 *
 * The census and the canary tests read the real workflows, `ci/`,
 * `lefthook.yml`, the root manifest and `.claude/` settings and hooks, and the
 * files those name under `scripts/`. None of that is in this package, so
 * without the override turbo neither re-runs these suites when only one of
 * those files changes (`turbo test --affected` on a pull request skipped them
 * for a workflow-only change) nor keys their cache on them.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const TASK = '@dorkos/ci-steward#test';

/** The root-relative reads these suites make, as turbo globs. */
const READS = [
  '.github/workflows/**',
  'ci/**',
  'lefthook.yml',
  'package.json',
  '.claude/settings.json',
  '.claude/hooks/**',
  'scripts/**',
  'apps/e2e/playwright.config.ts',
];

type Task = { dependsOn?: string[]; cache?: boolean; inputs?: string[] };
const turbo = JSON.parse(readFileSync(path.join(ROOT, 'turbo.json'), 'utf8')) as {
  tasks: Record<string, Task>;
};

describe(`${TASK} declares what its suites read`, () => {
  it('names every outside read as an input, beside its own files', () => {
    const inputs = turbo.tasks[TASK]?.inputs;
    expect(inputs, `${TASK} is gone from turbo.json`).toBeDefined();
    expect(inputs).toContain('$TURBO_DEFAULT$');
    expect(inputs).toEqual(expect.arrayContaining(READS.map((read) => `$TURBO_ROOT$/${read}`)));
  });

  it('names only paths that exist, so a moved file cannot make this vacuous', () => {
    for (const read of READS) {
      expect(existsSync(path.join(ROOT, read.replace(/\/\*\*$/, ''))), read).toBe(true);
    }
  });

  it('restates what the base test task declares, since the override replaces it', () => {
    expect(turbo.tasks[TASK]?.dependsOn).toEqual(turbo.tasks.test?.dependsOn);
    expect(turbo.tasks[TASK]?.cache).toBe(turbo.tasks.test?.cache);
  });
});
