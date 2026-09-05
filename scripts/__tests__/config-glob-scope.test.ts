/**
 * Scope guard for the repo-wide `**\/*.config.ts` ESLint carve-out (DOR-1785).
 *
 * `packages/eslint-config/base.js` exempts every `*.config.ts` file from the
 * `no-restricted-syntax` process.env rule, because a vite/vitest/playwright/
 * drizzle/next config runs in the tool's own process before any application
 * module loads and so has no `env.ts` to import from. That reasoning holds for
 * a build config sitting at a package root. It does NOT hold for application
 * code, and the glob cannot tell the two apart: it matches on the filename
 * alone, anywhere in the tree.
 *
 * So the exemption is only as narrow as the repo's file naming keeps it. Today
 * every one of the ~30 matches is a genuine tool config at a package root, and
 * the day someone adds `src/services/foo/retry.config.ts` — a perfectly natural
 * name for an application module holding tuning constants — that file silently
 * acquires a licence to read `process.env` directly, with no disable comment to
 * review and nothing anywhere saying it happened. That is the failure mode this
 * guard exists to make loud: not a wrong answer, but a rule quietly ceasing to
 * apply to code it was written for.
 *
 * `src/` is the line because it is this repo's universal marker for authored
 * application code; build configs live above it, never inside it. A file that
 * trips this test is not necessarily wrong — it just may not keep a name that
 * hands it a lint exemption nobody chose to grant.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * Every tracked `*.config.ts` path in the repo.
 *
 * `git ls-files` rather than a filesystem walk: it is the tracked tree by
 * definition, so it never sees `node_modules`, a build output directory, a
 * sibling worktree, or the `vitest.config.ts.timestamp-*.mjs` scratch files an
 * interrupted vitest run leaves behind.
 */
function trackedConfigFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', '*.config.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

describe('the **/*.config.ts lint carve-out', () => {
  it('matches no file under a src/ directory', () => {
    const insideSrc = trackedConfigFiles().filter((file) => file.split('/').includes('src'));

    expect(insideSrc).toEqual([]);
  });

  it('matches the tool configs it was written for', () => {
    // Guards the guard: an assertion over an empty list passes for the wrong
    // reason, and `git ls-files` returning nothing (wrong cwd, no git) would do
    // exactly that. The real count is ~30; the bound only proves the query ran.
    expect(trackedConfigFiles().length).toBeGreaterThan(20);
  });
});
