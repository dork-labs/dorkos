/**
 * The census's environment-job checks (DOR-4030): the real workflows pass; an
 * unpinned action beside an environment's secrets (no exceptions) and a job
 * that reads an environment's secret without naming the environment each fail
 * the census.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvironmentJobs, isPinned } from '../environment-jobs.ts';
import { realWorkflows, REPO } from './fixture.ts';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
/** actions/create-github-app-token v3.4.0, the SHA Security checked (DOR-4030 round 3). */
const APP_TOKEN_SHA = 'f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc';

/** Every real workflow, with one file's text edited, then checked. */
function run(edit?: { file: string; change: (text: string) => string }) {
  const { files, workflows } = realWorkflows(edit);
  return checkEnvironmentJobs(files, workflows).map((f) => [f.code, f.file, f.where]);
}

/** Replaces `from` with `to`, once. */
const swap = (from: string, to: string) => (t: string) => t.replace(from, to);
const NO_AUTOMATION = swap('    environment: automation\n', '');

describe('checkEnvironmentJobs on the real workflows', () => {
  it('passes as committed, leaving a tag in a read-only job with no environment alone', () => {
    // operating-skills-version-check sets no permissions; the repository default is read.
    const text = readFileSync(
      path.join(REPO, '.github/workflows/operating-skills-version-check.yml'),
      'utf8'
    );
    expect(text).toContain('actions/checkout@v7\n');
    expect(run()).toEqual([]);
  });

  it.each([
    [
      'a tag-pinned action in a job that names an environment',
      'queue-repeat-guard.yml',
      swap(`actions/checkout@${SHA} # v7.0.1`, 'actions/checkout@v7'),
      'door: actions/checkout@v7',
    ],
    [
      'a local action in a job that names an environment',
      'neon-preview-sweep.yml',
      swap(`actions/checkout@${SHA} # v7.0.1`, './.github/actions/checkout'),
      'sweep: ./.github/actions/checkout',
    ],
    [
      'a tag-pinned action in a packages: write job with no environment',
      'publish-community.yml',
      swap(
        'docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0',
        'docker/build-push-action@v7'
      ),
      'build-and-publish: docker/build-push-action@v7',
    ],
    [
      'a tag-pinned action in an id-token: write job with no environment',
      'browser-native-release-artifact.yml',
      swap('actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2', 'actions/attest@v4'),
      'build-darwin: actions/attest@v4',
    ],
    [
      'the App-token action back on its moving v3 tag (there is no exception list)',
      'queue-repeat-guard.yml',
      swap(
        `actions/create-github-app-token@${APP_TOKEN_SHA} # v3.4.0`,
        'actions/create-github-app-token@v3'
      ),
      'door: actions/create-github-app-token@v3',
    ],
  ])('fails on %s', (_label, file, change, where) => {
    expect(run({ file, change })).toEqual([
      ['environment-pins/unpinned', `.github/workflows/${file}`, where],
    ]);
  });

  it('pins the App-token action to the same reviewed SHA everywhere it is used', () => {
    const dir = path.join(REPO, realWorkflows().files.config.workflows_dir);
    const USES = /uses:\s*actions\/create-github-app-token@(\S+)/g;
    const uses = readdirSync(dir)
      .filter((n) => /\.ya?ml$/.test(n))
      .flatMap((n) =>
        [...readFileSync(path.join(dir, n), 'utf8').matchAll(USES)].map((m) => [n, m[1]])
      );
    expect(uses.map(([n]) => n).sort()).toEqual([
      'auto-revert.yml',
      'daily-release.yml',
      'daily-release.yml',
      'dependabot-lockfile-repair.yml',
      'queue-reentry.yml',
      'queue-repeat-guard.yml',
      'review-redispatch.yml',
      'rolling-bisect.yml',
    ]);
    expect(new Set(uses.map(([, ref]) => ref))).toEqual(new Set([APP_TOKEN_SHA]));
  });

  it.each([
    [
      'reads an environment secret without naming the environment',
      'neon-preview-sweep.yml',
      NO_AUTOMATION,
      'sweep',
    ],
    [
      'reads a secret named in lower case (GitHub contexts ignore case)',
      'neon-preview-sweep.yml',
      (t: string) => NO_AUTOMATION(t).replace('secrets.NEON_API_KEY', 'secrets.neon_api_key'),
      'sweep',
    ],
    [
      'names the wrong environment for the secret it reads',
      'review-redispatch.yml',
      swap('    environment: automation\n', '    environment: release\n'),
      'redispatch',
    ],
  ])('fails when a job %s', (_label, file, change, where) => {
    expect(run({ file, change })).toEqual([
      ['environment-secrets/outside-environment', `.github/workflows/${file}`, where],
    ]);
  });
});

describe('isPinned', () => {
  it.each([
    [`actions/checkout@${SHA}`, true],
    ['actions/checkout@v7', false],
    [`actions/checkout@${SHA.slice(0, 39)}`, false],
    [`actions/checkout@${SHA.toUpperCase()}`, false],
    ['./.github/actions/x', false],
    [`docker://alpine@sha256:${'a'.repeat(64)}`, true],
    ['docker://alpine:3', false],
  ])('%s -> %s', (uses, want) => {
    expect(isPinned(uses)).toBe(want);
  });
});
