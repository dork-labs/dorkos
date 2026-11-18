/**
 * The turbo build cache for the browser workflows (DOR-4634, ledger
 * 261117-184500). Before it, browser-test.yml and app-frame-browser.yml had no
 * turbo cache at all, so every browser job rebuilt server, client and their
 * packages from nothing (~130 s a job, seven jobs a queue build).
 *
 * Same shape as test.yml's (scripts/__tests__/turbo-build-cache-restore.test.ts):
 * every job restores, only a run on main saves, and only after
 * scripts/keep-build-cache-only.sh has trimmed the cache to this run's build
 * entries, so no test result is ever replayed. One job saves because every
 * browser job builds the same tasks with the same hashes (verified with
 * `turbo run build --dry=json`: `@dorkos/client#build` hashes the same under
 * each job's filter and with or without `--summarize`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (name: string) => readFileSync(path.join(root, '.github/workflows', name), 'utf8');
const browserTest = read('browser-test.yml');
const appFrame = read('app-frame-browser.yml');

const PREFIX = 'turbo-browser-builds-${{ runner.os }}-${{ runner.arch }}-';
const LOCK = "${{ hashFiles('pnpm-lock.yaml') }}";
const KEY = `${PREFIX}${LOCK}-\${{ github.sha }}`;
const RESTORE = 'Restore the builds the last main canary made';

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

/** The first step in a job whose run line starts a turbo build. */
function buildIndex(job: string): number {
  const at = job.indexOf('run: pnpm exec turbo run build ');
  expect(at, 'job has no turbo build step').toBeGreaterThan(0);
  return at;
}

describe.each([
  ['browser-test.yml', browserTest, 'browser-smoke'],
  ['browser-test.yml', browserTest, 'browser-shard'],
  ['browser-test.yml', browserTest, 'first-run'],
  ['app-frame-browser.yml', appFrame, 'gesture-spec'],
])('%s %s restores the build cache before it builds', (_file, workflow, id) => {
  const job = jobText(workflow, id);
  const step = stepText(job, RESTORE);

  it('asks for the exact entry, then the same lockfile, then any for this OS and arch', () => {
    expect(step).toContain('uses: actions/cache/restore@');
    expect(step).toContain('path: .turbo/cache\n');
    expect(step).toContain(`key: ${KEY}\n`);
    expect(step).toContain(
      `restore-keys: |\n            ${PREFIX}${LOCK}-\n            ${PREFIX}\n`
    );
  });

  it('restores before the build', () => {
    expect(job.indexOf(step)).toBeLessThan(buildIndex(job));
  });
});

describe('only browser-shard (1/6) on main saves, and only build entries', () => {
  const shard = jobText(browserTest, 'browser-shard');

  it('has exactly one save of this key across both workflows', () => {
    const saves = [browserTest, appFrame]
      .flatMap((workflow) => workflow.split(/\n(?= {6}- )/))
      .filter((step) => step.includes('uses: actions/cache/save@'))
      .filter((step) => step.includes('turbo-browser-builds-'));
    expect(saves).toHaveLength(1);
    expect(saves[0]).toContain(`key: ${KEY}\n`);
  });

  it('records a run summary on the build the trim reads', () => {
    const build = shard.slice(buildIndex(shard)).split('\n')[0];
    expect(build).toContain('--summarize');
  });

  it('trims on refs/heads/main for shard 1, after the build and before the save', () => {
    const trim = stepText(shard, "Keep only this run's build entries in the turbo cache");
    expect(trim).toContain("if: ${{ github.ref == 'refs/heads/main' && matrix.shard == 1 }}");
    expect(trim).toContain('bash scripts/keep-build-cache-only.sh');

    const save = stepText(shard, 'Save the builds for the queue and pull requests');
    expect(save).toContain("if: ${{ steps.turbo-trim.outputs.save == 'true' }}");
    expect(shard.indexOf(trim)).toBeGreaterThan(buildIndex(shard));
    expect(shard.indexOf(save)).toBeGreaterThan(shard.indexOf(trim));
  });
});
