/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Every git branch Vercel deploys gets its own Neon database branch from the
// Vercel-Neon integration, named `preview/<git-branch>`. The database is made
// when the deployment is created, before the build clones anything, so the
// ignoreCommand (which runs after the clone) cannot stop it. Only
// `git.deploymentEnabled` stops the deployment itself. Merge-queue builds and
// `codex/archive/*` twins never need a preview site, and the queue alone
// refilled the Neon project every day
// (ci/ledger/260925-230012-neon-preview-branch-leak.md).
//
// Vercel reads this file from the commit it deploys, so a key only works for a
// branch whose tree carries it: an archive twin of a commit made before this
// rule landed still deploys. `ci-steward-data` is an orphan branch with no
// apps/site at all, which is why it is NOT listed: a key for it would be dead
// config. Its preview database is left to the nightly sweep.
//
// Vercel matches keys with minimatch, and a branch is deployed if ANY matching
// key is true. `path.posix.matchesGlob` is Node's own minimatch port, so the
// assertions below use the same rules Vercel does.
const SITE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

type VercelConfig = { git?: { deploymentEnabled?: Record<string, boolean> | boolean } };

const config = JSON.parse(readFileSync(join(SITE_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;
const rules = config.git?.deploymentEnabled;

/** Mirrors Vercel's rule: deployed unless a key matches, and any true match wins. */
function deploys(branch: string): boolean {
  if (typeof rules === 'boolean') return rules;
  const hits = Object.entries(rules ?? {}).filter(([pattern]) =>
    posix.matchesGlob(branch, pattern)
  );
  return hits.length === 0 || hits.some(([, enabled]) => enabled);
}

describe('vercel.json git.deploymentEnabled', () => {
  it('is a per-branch map, never a blanket switch that would stop production', () => {
    expect(typeof rules).toBe('object');
    expect(Object.values(rules as Record<string, boolean>).every((v) => v === false)).toBe(true);
  });

  it.each([
    'gh-readonly-queue/main/pr-2126-fc032be03dccb4b5565863ea7dacfea8bf94ddbf',
    'codex/archive/community-20260916/admission',
  ])('does not deploy %s', (branch) => {
    expect(deploys(branch)).toBe(false);
  });

  it.each([
    'main',
    'feat/launcher-live-receipt',
    'codex/retire-obsidian-plugin',
    'DOR-2337',
    'ci-steward/measurement-blind-spots',
    'gh-readonly-queue-lookalike',
    'codex/archive-notes',
  ])('still deploys %s', (branch) => {
    expect(deploys(branch)).toBe(true);
  });
});
