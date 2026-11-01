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
// `git.deploymentEnabled` stops the deployment itself
// (ci/ledger/260925-230012-neon-preview-branch-leak.md).
//
// Denying two prefixes was not enough: agent scratch branches of every shape
// kept deploying, about 164 of them by 2026-11-01. So the rule is an allowlist:
// production (`main`) and branches whose last part starts `site-` deploy,
// nothing else does. Branches are `<agent>/<topic>`, so a PR that needs a
// preview site names its topic `site-...` (`designer/site-hero-copy`); every
// other PR still gets the `site-build` CI check.
//
// Vercel reads this file from the commit it deploys, so a branch cut from a
// main older than this rule keeps the old behaviour until it is rebased.
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
  });

  it.each(['main', 'dorkos-2/site-preview-allowlist', 'designer/site-hero-copy', 'site-docs'])(
    'deploys %s',
    (branch) => {
      expect(deploys(branch)).toBe(true);
    }
  );

  it.each([
    'gh-readonly-queue/main/pr-2126-fc032be03dccb4b5565863ea7dacfea8bf94ddbf',
    'codex/archive/community-20260916/admission',
    'codex/retire-obsidian-plugin',
    'wip/scratch',
    'lane-archive/lane-d/2026-10-30',
    'pr-assets/DOR-3307',
    'feat/launcher-live-receipt',
    'DOR-2337',
    'ci-steward/measurement-blind-spots',
    'main-backup',
    'mainline',
    'site',
    'site/redesign',
    'designer/website-redesign',
    'designer/site-hero/extra',
    'release/v0.130.0',
  ])('does not deploy %s', (branch) => {
    expect(deploys(branch)).toBe(false);
  });
});
