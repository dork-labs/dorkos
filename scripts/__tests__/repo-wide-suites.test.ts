/**
 * Pins the split in `scripts/vitest.repo.config.ts` (ledger 261112-185148).
 *
 * The repo-wide suites run in the merge queue through `typecheck.yml`; the
 * rest run only in `scripts-test / harness`, which the queue skips. A suite
 * that is on neither list runs in no queue build, and a repo-wide guard left
 * off the first list is exactly the hole this split closes. So every test file
 * in the `scripts` project must be on exactly one list, and the queue config
 * must collect exactly the repo-wide one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import repoConfig, { HERMETIC_SUITES, REPO_WIDE_SUITES } from '../vitest.repo.config.ts';

const SCRIPTS = path.resolve(import.meta.dirname, '..');

/** Every `*.test.ts` under a `__tests__` directory in `scripts/`, relative to it. */
function scriptsSuites(dir = SCRIPTS, inTests = false, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scriptsSuites(full, inTests || entry.name === '__tests__', out);
    } else if (inTests && entry.name.endsWith('.test.ts')) {
      out.push(path.relative(SCRIPTS, full));
    }
  }
  return out.sort();
}

describe('the scripts suites split between the queue and harness', () => {
  const all = scriptsSuites();
  const repoWide: string[] = [...REPO_WIDE_SUITES];
  const hermetic: string[] = [...HERMETIC_SUITES];

  it('found the suites to check', () => {
    // An empty walk would pass every assertion below.
    expect(all.length).toBeGreaterThan(50);
    expect(all).toContain('__tests__/code-only.test.ts');
  });

  it('puts every suite on exactly one list', () => {
    const listed = [...repoWide, ...hermetic];
    const unlisted = all.filter((file) => !listed.includes(file));
    const twice = repoWide.filter((file) => hermetic.includes(file));

    expect(
      unlisted,
      'Add each new suite to REPO_WIDE_SUITES in scripts/vitest.repo.config.ts if any ' +
        'test in it reads a file outside scripts/ (or runs git ls-files), else to ' +
        'HERMETIC_SUITES. When unsure, it is repo-wide.'
    ).toEqual([]);
    expect(twice).toEqual([]);
  });

  it('lists no suite that does not exist', () => {
    expect([...repoWide, ...hermetic].filter((file) => !all.includes(file))).toEqual([]);
  });

  it('runs this guard in the queue, on the repo-wide list', () => {
    // On the hermetic list it ran only in `harness`, which the queue skips, so
    // PRs outside scripts/ merged unlisted suites and main went red (DOR-4224).
    // Moving it back edits scripts/, which runs `harness`, so this goes red there.
    expect(repoWide).toContain('__tests__/repo-wide-suites.test.ts');
  });

  it('has the queue config collect the repo-wide list and nothing else', () => {
    expect(repoConfig.test?.include).toEqual(repoWide);
  });

  it('is run by the required typecheck workflow on every event', () => {
    // A list nothing runs in the queue is the old hole with extra steps.
    const workflow = readFileSync(
      path.join(SCRIPTS, '..', '.github', 'workflows', 'typecheck.yml'),
      'utf8'
    );

    expect(workflow).toContain('vitest run --config scripts/vitest.repo.config.ts');
  });
});
