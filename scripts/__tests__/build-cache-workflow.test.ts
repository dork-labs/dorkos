/**
 * build-cache.yml saves main's build caches after every merge (DOR-4627,
 * ledger 261123-194610-build-cache-per-merge).
 *
 * Its whole value rests on one property: what it saves must be what the
 * workflows that restore it would have built themselves. Turbo replays an
 * entry only when its task hash matches, and a build's hash covers its env and
 * its turbo arguments, so a different build line or a missing NODE_ENV would
 * save entries no queue build ever replays, while every run still looks green.
 * So this pins the build lines, env, runner images and keys here against the
 * live text of test.yml and browser-test.yml, not against copies.
 *
 * It also pins that the workflow can never gate a merge (push to main and
 * dispatch only, no required context) and that the cache-write token lives in
 * the prune job alone.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const buildCache = read('.github/workflows/build-cache.yml');
const testYml = read('.github/workflows/test.yml');
const browserYml = read('.github/workflows/browser-test.yml');

/** One job's text, from its key to the next top-level job key. */
function jobText(workflow: string, id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  expect(start, `no job ${id}`).toBeGreaterThan(0);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** A step's lines, from its `- name:` to the next step or the end of the job. */
function stepText(job: string, name: string): string {
  const at = job.indexOf(`      - name: ${name}\n`);
  expect(at, `no step "${name}"`).toBeGreaterThanOrEqual(0);
  const rest = job.slice(at + 1);
  const next = rest.search(/\n {6}- /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The single value of `key:` (or another one-line field) in a step. */
function field(step: string, name: string): string {
  const m = new RegExp(`^ {10}${name}: (.+)$`, 'm').exec(step);
  expect(m, `no ${name}: in\n${step}`).not.toBeNull();
  return m![1]!;
}

/** The `restore-keys: |` lines of a step, trimmed, in order. */
function restoreKeys(step: string): string[] {
  const lines = step.split('\n');
  const at = lines.findIndex((line) => line.trim() === 'restore-keys: |');
  expect(at, 'no restore-keys block').toBeGreaterThan(0);
  const keys: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('            ')) break;
    keys.push(line.trim());
  }
  return keys;
}

/** The job-level `env:` keys a build's turbo hash reads (turbo.json `build.env`). */
function hashedEnv(job: string): string[] {
  const block = /\n {4}env:\n((?: {6}.*\n|\s*#.*\n)+)/.exec(job)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => /^ {6}([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter(([, name]) => /^(NODE_ENV|VITE_|NEXT_PUBLIC_|POSTHOG_)/.test(name!))
    .map(([, name, value]) => `${name}=${value}`)
    .sort();
}

const runsOn = (job: string) => /^ {4}runs-on: (.+)$/m.exec(job)?.[1];

const testBuilds = jobText(buildCache, 'test-builds');
const browserBuilds = jobText(buildCache, 'browser-builds');
const prune = jobText(buildCache, 'prune');
const testShard = jobText(testYml, 'test-shard');
const browserShard = jobText(browserYml, 'browser-shard');

const SAVE = 'Save the builds for the queue and pull requests';
const TRIM = "Keep only this run's build entries in the turbo cache";
const RESTORE = 'Restore the builds the last merge saved';

describe('build-cache.yml runs after every merge and gates nothing', () => {
  const on = /\non:\n((?: .*\n)+)/.exec(buildCache)?.[1] ?? '';

  it('triggers on push to main and on dispatch, never on a pull request or the queue', () => {
    expect(on).toContain('  push:\n    branches: [main]\n');
    expect(on).toContain('  workflow_dispatch:\n');
    expect(on).not.toMatch(/pull_request|merge_group|schedule/);
  });

  it('cancels a superseded push, one group per ref', () => {
    expect(buildCache).toContain(
      'concurrency:\n  group: build-cache-${{ github.ref }}\n  cancel-in-progress: true\n'
    );
  });

  it('owns no required context', () => {
    const required = JSON.parse(read('ci/required-checks.json')) as { contexts: string[] };
    for (const id of ['test-builds', 'browser-builds', 'prune'])
      expect(required.contexts).not.toContain(id);
  });

  it('runs every job on main only', () => {
    expect(testBuilds).toContain("    if: ${{ github.ref == 'refs/heads/main' }}\n");
    expect(browserBuilds).toContain("    if: ${{ github.ref == 'refs/heads/main' }}\n");
    expect(prune).toContain("    if: ${{ !cancelled() && github.ref == 'refs/heads/main' }}\n");
  });
});

describe('test-builds builds and saves exactly what test.yml restores', () => {
  it('runs on the image test.yml shards use outside the queue', () => {
    expect(testShard).toContain("|| 'ubuntu-latest' }}");
    expect(runsOn(testBuilds)).toBe('ubuntu-latest');
  });

  it('builds with the same command as the queue shards, every package, no filters', () => {
    expect(
      stepText(testShard, 'Build what the suites import, once, with no test arguments')
    ).toContain('          bash scripts/build-test-deps.sh\n');
    const build = stepText(testBuilds, 'Build what the test suites import');
    expect(build).toContain('        run: bash scripts/build-test-deps.sh\n');
    expect(build).toMatch(/^ {8}id: deps$/m);
  });

  it('sets no env that a build hash reads, as test-shard sets none', () => {
    expect(hashedEnv(testShard)).toEqual([]);
    expect(hashedEnv(testBuilds)).toEqual([]);
  });

  it('saves under the key test.yml saves and restores, after the trim', () => {
    const key = field(stepText(testShard, SAVE), 'key');
    const save = stepText(testBuilds, SAVE);
    expect(field(save, 'key')).toBe(key);
    expect(save).toContain("if: ${{ steps.trim.outputs.save == 'true' }}");
    const trim = stepText(testBuilds, TRIM);
    expect(trim).toContain('bash scripts/keep-build-cache-only.sh "$BUILD_SUMMARY"');
    expect(trim).toContain('BUILD_SUMMARY: ${{ steps.deps.outputs.summary }}');
    expect(testBuilds.indexOf(save)).toBeGreaterThan(testBuilds.indexOf(trim));
  });

  it("restores the previous merge's entry with test.yml's own keys, and skips the save on an exact hit", () => {
    const theirs = stepText(testShard, 'Restore the builds the last main canary made');
    const ours = stepText(testBuilds, RESTORE);
    expect(field(ours, 'key')).toBe(field(theirs, 'key'));
    expect(restoreKeys(ours)).toEqual(restoreKeys(theirs));
    expect(stepText(testBuilds, TRIM)).toContain(
      "if: ${{ steps.turbo-restore.outputs.cache-hit != 'true' }}"
    );
  });
});

describe('browser-builds builds and saves exactly what browser-test.yml restores', () => {
  const BUILD = 'Build what the webServer legs boot from';

  it("runs on browser-test.yml's pinned image", () => {
    expect(runsOn(browserBuilds)).toBe(runsOn(browserShard));
  });

  it('carries the same hashed env as browser-shard (NODE_ENV)', () => {
    expect(hashedEnv(browserShard)).toEqual(['NODE_ENV=development']);
    expect(hashedEnv(browserBuilds)).toEqual(hashedEnv(browserShard));
  });

  it("runs browser-shard's build line, byte for byte", () => {
    const theirs = /\n {8}run: (.+)\n/.exec(stepText(browserShard, BUILD))?.[1];
    const ours = /\n {8}run: (.+)\n/.exec(stepText(browserBuilds, BUILD))?.[1];
    expect(theirs).toContain('--summarize');
    expect(ours).toBe(theirs);
  });

  it('saves under the key browser-test.yml saves and restores, after the trim', () => {
    const key = field(stepText(browserShard, SAVE), 'key');
    const save = stepText(browserBuilds, SAVE);
    expect(field(save, 'key')).toBe(key);
    const trim = stepText(browserBuilds, TRIM);
    expect(trim).toContain('bash scripts/keep-build-cache-only.sh');
    expect(browserBuilds.indexOf(save)).toBeGreaterThan(browserBuilds.indexOf(trim));
  });

  it("restores with browser-test.yml's own keys", () => {
    const theirs = stepText(browserShard, 'Restore the builds the last main canary made');
    const ours = stepText(browserBuilds, RESTORE);
    expect(field(ours, 'key')).toBe(field(theirs, 'key'));
    expect(restoreKeys(ours)).toEqual(restoreKeys(theirs));
  });
});

describe('pnpm stores', () => {
  it.each([
    ['test-builds', testBuilds, testShard],
    ['browser-builds', browserBuilds, browserShard],
  ])('%s saves the store its readers restore, on main and a miss only', (_id, ours, theirs) => {
    const name = 'Save the pnpm store for the queue and pull requests';
    const save = stepText(ours, name);
    expect(field(save, 'key')).toBe(field(stepText(theirs, name), 'key'));
    expect(save).toContain(
      "if: ${{ github.ref == 'refs/heads/main' && steps.pnpm-store-restore.outputs.cache-hit != 'true' }}"
    );
  });
});

describe('only the prune job can delete caches', () => {
  it('build jobs get the workflow default, contents: read', () => {
    expect(buildCache).toContain('\npermissions:\n  contents: read\n');
    expect(testBuilds).not.toMatch(/^ {4}permissions:/m);
    expect(browserBuilds).not.toMatch(/^ {4}permissions:/m);
  });

  it('prune has actions: write, builds nothing, and runs the tested script', () => {
    expect(prune).toContain('    permissions:\n      actions: write\n      contents: read\n');
    expect(prune).not.toMatch(/pnpm|turbo/);
    expect(prune).toContain('run: bash scripts/prune-main-build-caches.sh');
    expect(prune).toContain('needs: [test-builds, browser-builds]');
  });

  it('no checkout keeps a credential', () => {
    const checkouts = buildCache.match(/uses: actions\/checkout@/g) ?? [];
    const persisted = buildCache.match(/persist-credentials: false/g) ?? [];
    expect(checkouts.length).toBe(3);
    expect(persisted.length).toBe(checkouts.length);
  });
});
