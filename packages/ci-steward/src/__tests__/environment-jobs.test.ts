/**
 * The census's environment-job checks (DOR-4030): the real workflows pass; an
 * unpinned action beside an environment's secrets (no exceptions) and a job that reads an environment's secret without naming the
 * environment each fail the census.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEnvironmentJobs, isPinned } from '../environment-jobs.ts';
import { loadHandFiles, type HandFiles } from '../load.ts';
import { loadWorkflows } from '../workflows.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
/** actions/create-github-app-token v3.4.0, the SHA Security checked (DOR-4030 round 3). */
const APP_TOKEN_SHA = 'f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const realFiles = (): HandFiles => loadHandFiles(REPO).files!;

/** Every real workflow, with one file's text edited (an edit must change it), then checked. */
function run(edit?: { file: string; change: (text: string) => string }, files = realFiles()) {
  const root = mkdtempSync(path.join(tmpdir(), 'env-jobs-'));
  dirs.push(root);
  const from = path.join(REPO, files.config.workflows_dir);
  const to = path.join(root, files.config.workflows_dir);
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(path.join(from, f), 'utf8');
    const out = edit && f === edit.file ? edit.change(text) : text;
    if (edit && f === edit.file) expect(out).not.toBe(text);
    writeFileSync(path.join(to, f), out);
  }
  const workflows = loadWorkflows(root, files.config.workflows_dir, (f, m) => {
    throw new Error(`${f}: ${m}`);
  });
  return checkEnvironmentJobs(files, workflows).map((f) => [f.code, f.file, f.where]);
}

describe('checkEnvironmentJobs on the real workflows', () => {
  it('passes as committed', () => {
    expect(run()).toEqual([]);
  });

  it('fails on a tag-pinned action in a job that names an environment', () => {
    expect(
      run({
        file: 'queue-repeat-guard.yml',
        change: (t) => t.replace(`actions/checkout@${SHA} # v7.0.1`, 'actions/checkout@v7'),
      })
    ).toEqual([
      [
        'environment-pins/unpinned',
        '.github/workflows/queue-repeat-guard.yml',
        'door: actions/checkout@v7',
      ],
    ]);
  });

  it('fails on a local action in a job that names an environment', () => {
    expect(
      run({
        file: 'neon-preview-sweep.yml',
        change: (t) => t.replace(`actions/checkout@${SHA} # v7.0.1`, './.github/actions/checkout'),
      })
    ).toEqual([
      [
        'environment-pins/unpinned',
        '.github/workflows/neon-preview-sweep.yml',
        'sweep: ./.github/actions/checkout',
      ],
    ]);
  });

  it('fails on a tag-pinned action in a packages: write job with no environment', () => {
    expect(
      run({
        file: 'publish-community.yml',
        change: (t) =>
          t.replace(
            'docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0',
            'docker/build-push-action@v7'
          ),
      })
    ).toEqual([
      [
        'environment-pins/unpinned',
        '.github/workflows/publish-community.yml',
        'build-and-publish: docker/build-push-action@v7',
      ],
    ]);
  });

  it('fails on a tag-pinned action in an id-token: write job with no environment', () => {
    expect(
      run({
        file: 'browser-native-release-artifact.yml',
        change: (t) =>
          t.replace(
            'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2',
            'actions/attest@v4'
          ),
      })
    ).toEqual([
      [
        'environment-pins/unpinned',
        '.github/workflows/browser-native-release-artifact.yml',
        'build-darwin: actions/attest@v4',
      ],
    ]);
  });

  it('leaves a tag in a read-only job with no environment alone', () => {
    // operating-skills-version-check sets no permissions; the repository default is read.
    const text = readFileSync(
      path.join(REPO, '.github/workflows/operating-skills-version-check.yml'),
      'utf8'
    );
    expect(text).toContain('actions/checkout@v7\n');
    expect(run()).toEqual([]);
  });

  it('fails on the App-token action back on its moving v3 tag (there is no exception list)', () => {
    expect(
      run({
        file: 'queue-repeat-guard.yml',
        change: (t) =>
          t.replace(
            `actions/create-github-app-token@${APP_TOKEN_SHA} # v3.4.0`,
            'actions/create-github-app-token@v3'
          ),
      })
    ).toEqual([
      [
        'environment-pins/unpinned',
        '.github/workflows/queue-repeat-guard.yml',
        'door: actions/create-github-app-token@v3',
      ],
    ]);
  });

  it('pins the App-token action to the same reviewed SHA everywhere it is used', () => {
    const dir = path.join(REPO, realFiles().config.workflows_dir);
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

  it('fails when a job reads an environment secret without naming the environment', () => {
    expect(
      run({
        file: 'neon-preview-sweep.yml',
        change: (t) => t.replace('    environment: automation\n', ''),
      })
    ).toEqual([
      [
        'environment-secrets/outside-environment',
        '.github/workflows/neon-preview-sweep.yml',
        'sweep',
      ],
    ]);
  });

  it('reads a secret named in lower case as that secret (GitHub contexts ignore case)', () => {
    expect(
      run({
        file: 'neon-preview-sweep.yml',
        change: (t) =>
          t
            .replace('    environment: automation\n', '')
            .replace('secrets.NEON_API_KEY', 'secrets.neon_api_key'),
      })
    ).toEqual([
      [
        'environment-secrets/outside-environment',
        '.github/workflows/neon-preview-sweep.yml',
        'sweep',
      ],
    ]);
  });

  it('fails when a job names the wrong environment for the secret it reads', () => {
    const findings = run({
      file: 'review-redispatch.yml',
      change: (t) => t.replace('    environment: automation\n', '    environment: release\n'),
    });
    expect(findings).toContainEqual([
      'environment-secrets/outside-environment',
      '.github/workflows/review-redispatch.yml',
      'redispatch',
    ]);
  });
});

describe('isPinned', () => {
  it.each([
    [`actions/checkout@${SHA}`, true],
    ['actions/checkout@v7', false],
    ['actions/checkout@v7.0.1', false],
    [`actions/checkout@${SHA.slice(0, 39)}`, false],
    [`actions/checkout@${SHA.toUpperCase()}`, false],
    ['./.github/actions/x', false],
    [`docker://alpine@sha256:${'a'.repeat(64)}`, true],
    ['docker://alpine:3', false],
  ])('%s -> %s', (uses, want) => {
    expect(isPinned(uses)).toBe(want);
  });
});
