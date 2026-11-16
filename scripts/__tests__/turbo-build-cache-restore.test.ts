/**
 * The turbo build cache the main canary saves and the shards restore
 * (DOR-4190, ledgers 261115-201939 and the restore-keys follow-up).
 *
 * The first version restored only by `<os>-<arch>-<lockfile hash>-`, so one
 * lockfile change on `main` after the last canary left every queue build and
 * pull request with no entry to find: `Cache not found`, `Cached: 0 cached`,
 * until the next canary, which GitHub delivers about twice a day. This pins
 * the fix: each restore falls back to the newest entry for the same OS and
 * arch whatever its lockfile, because turbo's own task hashes decide what is
 * replayed. It also pins what made that fallback safe: only `main` saves, and
 * only after the build-only trim.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');

const PREFIX = 'turbo-test-builds-${{ runner.os }}-${{ runner.arch }}-';
const LOCK = "${{ hashFiles('pnpm-lock.yaml') }}";
const KEY = `${PREFIX}${LOCK}-\${{ github.sha }}`;

/** One job's text, from its key to the next top-level job key. */
function jobText(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  expect(start, `test.yml has no job ${id}`).toBeGreaterThan(0);
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

/** The `restore-keys: |` lines of a step, trimmed, in order. */
function restoreKeys(step: string): string[] {
  const lines = step.split('\n');
  const at = lines.findIndex((line) => line.trim() === 'restore-keys: |');
  expect(at, 'the restore step has no restore-keys block').toBeGreaterThan(0);
  const keys: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('            ')) break;
    keys.push(line.trim());
  }
  return keys;
}

const RESTORE = 'Restore the builds the last main canary made';

describe.each(['test-shard', 'test-binary'])('%s restores the build cache', (id) => {
  const step = stepText(jobText(id), RESTORE);

  it('asks for the exact entry first', () => {
    expect(step).toContain(`key: ${KEY}\n`);
  });

  it('prefers the same lockfile, then takes the newest entry for this OS and arch', () => {
    expect(restoreKeys(step)).toEqual([`${PREFIX}${LOCK}-`, PREFIX]);
  });

  it('only restores, never saves', () => {
    expect(step).toContain('uses: actions/cache/restore@');
  });
});

describe('only the main canary saves, and only build entries', () => {
  const shard = jobText('test-shard');

  it('has exactly one save of the build cache in the whole workflow', () => {
    expect(workflow.split('actions/cache/save@').length - 1).toBe(1);
    expect(workflow.split(`key: ${KEY}\n`).length - 1).toBe(3);
  });

  it('trims to build entries on refs/heads/main before the save', () => {
    const trim = stepText(shard, "Keep only this run's build entries in the turbo cache");
    expect(trim).toContain("if: ${{ github.ref == 'refs/heads/main' }}");
    expect(trim).toContain('bash scripts/keep-build-cache-only.sh');

    const save = stepText(shard, 'Save the builds for the queue and pull requests');
    expect(save).toContain("if: ${{ steps.trim.outputs.save == 'true' }}");
    expect(save).toContain(`key: ${KEY}\n`);
    expect(shard.indexOf(save)).toBeGreaterThan(shard.indexOf(trim));
  });

  it('saves under the prefix every restore falls back to', () => {
    const save = stepText(shard, 'Save the builds for the queue and pull requests');
    const saved = /key: (.+)\n/.exec(save)?.[1] ?? '';
    expect(saved.startsWith(PREFIX)).toBe(true);
  });
});
