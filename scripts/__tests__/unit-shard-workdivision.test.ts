/** Execute the actual workflow fan-in against complete and damaged shard evidence. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');

// The child git must not inherit a session's GIT_* settings or a person's own config.
const gitEnv = Object.fromEntries(
  // eslint-disable-next-line no-restricted-syntax -- the real step runs under a real environment.
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

/** Run git in a fixture repo with a fixed identity. */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: gitEnv }
  );
  expect(result.status, result.stderr).toBe(0);
}

/** Write a file in a fixture repo, making its folders. */
function put(cwd: string, file: string): void {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), `${file}\n`);
}

type Repo =
  | { kind: 'none' }
  | { kind: 'plain'; files: string[] }
  | { kind: 'merge'; files: string[]; removed?: string[] };

/**
 * Run the real "Pick the shard count" step for one event over a fixture repo
 * shaped like actions/checkout's pull request checkout: a test-merge commit
 * whose first parent is the base and whose second parent is the PR's head.
 */
function pick(event: string, repo: Repo): number[] {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dorkos-shard-count-'));
  try {
    if (repo.kind !== 'none') {
      git(cwd, 'init', '-q', '-b', 'main');
      put(cwd, 'README.md');
      put(cwd, 'apps/server/src/moved.ts');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'base');
      if (repo.kind === 'merge') git(cwd, 'checkout', '-q', '-b', 'pr');
      for (const file of repo.files) put(cwd, file);
      for (const file of repo.kind === 'merge' ? (repo.removed ?? []) : [])
        git(cwd, 'rm', '-q', file);
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'change');
      if (repo.kind === 'merge') {
        git(cwd, 'checkout', '-q', 'main');
        put(cwd, 'docs/elsewhere.md');
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-q', '-m', 'main moved on');
        git(cwd, 'merge', '-q', '--no-ff', '-m', 'test merge', 'pr');
      }
    }
    const output = path.join(cwd, 'output.txt');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', step('Pick the shard count')], {
      cwd,
      encoding: 'utf8',
      env: { ...gitEnv, EVENT: event, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const line = readFileSync(output, 'utf8').trim();
    expect(line).toMatch(/^matrix=\[/);
    return JSON.parse(line.slice('matrix='.length)) as number[];
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const SIX = [1, 2, 3, 4, 5, 6];
// The queue's and the canary's list, read from the real step (ledger 261031-150702).
const shardIds = pick('merge_group', { kind: 'none' });
const prShardIds = pick('pull_request', { kind: 'merge', files: ['apps/client/src/a.ts'] });

/** Extract the real shell body; no copy of the lane intersection algorithm. */
function step(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const run = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  expect(run).toBeGreaterThan(start);
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

type Copy = { id: number; total?: number; missingLane?: boolean };
/** Run the actual identity writer and fan-in over finite artifact fixtures. */
function lane(copies: Copy[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dorkos-six-shards-'));
  try {
    const summary = path.join(cwd, 'summary.md');
    writeFileSync(summary, '');
    const writer = step('Read the quarantine lane')
      .split('\n')
      .find((line) => line.includes('> "$RUNNER_TEMP/shard.txt"'))!;
    expect(writer).toBeTruthy();
    for (const [index, copy] of copies.entries()) {
      const dir = path.join(cwd, 'lane', `copy-${index}`);
      mkdirSync(dir, { recursive: true });
      const command = writer.replaceAll('${{ matrix.shard }}', String(copy.id));
      const written = spawnSync('bash', ['-e', '-c', command], {
        cwd,
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- real bash step reads runner paths.
        env: { ...process.env, RUNNER_TEMP: dir },
      });
      expect(written.status, written.stderr).toBe(0);
      if (copy.total !== undefined)
        writeFileSync(path.join(dir, 'shard.txt'), `${copy.id}/${copy.total}\n`);
      if (!copy.missingLane)
        writeFileSync(
          path.join(dir, 'quarantine.txt'),
          `apps/client/shared.test.ts > same\napps/client/only-${index}.test.ts > distinct\n`
        );
    }
    const result = spawnSync(
      'bash',
      ['-e', '-o', 'pipefail', '-c', step('Agree on the lane this build ran under')],
      {
        cwd,
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- real bash step reads runner paths.
        env: { ...process.env, RUNNER_TEMP: cwd, GITHUB_STEP_SUMMARY: summary },
      }
    );
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      intersection: (() => {
        try {
          return readFileSync(path.join(cwd, 'quarantine.txt'), 'utf8');
        } catch {
          return '';
        }
      })(),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const complete = () => shardIds.map((id) => ({ id }));
describe('six-way unit file work division', () => {
  it('uses every matrix identity once and each sweep partitions its own leg', () => {
    expect(shardIds).toEqual([1, 2, 3, 4, 5, 6]);
    // The queue sweep names its total as a literal, which must be the queue list's length.
    const denominators = [...workflow.matchAll(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/g)].map(
      (match) => Number(match[1])
    );
    expect(denominators).toEqual([shardIds.length]);
    // A narrow pull request runs fewer shards and reads its total from the matrix itself.
    expect(prShardIds).toEqual([1, 2]);
    expect(
      workflow.match(/--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/g)
    ).toHaveLength(1);
    const result = lane(complete());
    expect(result.status, result.output).toBe(0);
    expect(result.intersection).toBe('apps/client/shared.test.ts > same\n');
  });
  it('refuses a missing matrix copy instead of widening the intersection', () => {
    const result = lane(complete().slice(0, -1));
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('only 5 handed over');
  });
  it('refuses duplicate identities even with six artifact directories', () => {
    const result = lane([...complete().slice(0, -1), { id: 5 }]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('not shards 1..6 exactly');
  });
  it('refuses a stale denominator rather than mixing runs', () => {
    const result = lane([...complete().slice(0, -1), { id: 6, total: 4 }]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('disagree about how many');
  });
  it('refuses a missing lane body even when every identity arrived', () => {
    const result = lane([...complete().slice(0, -1), { id: 6, missingLane: true }]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('not every shard handed over');
  });
});

describe('how many shards a run gets (ledger 261031-150702)', () => {
  it('reads the matrix from the picker job, which test-shard needs', () => {
    expect(workflow).toMatch(/^ {2}test-shard:\n {4}needs: \[test-shard-count\]\n/m);
    expect(workflow).toMatch(
      /^ {8}shard: \$\{\{ fromJSON\(needs\.test-shard-count\.outputs\.matrix\) \}\}$/m
    );
    expect(workflow).toMatch(/^ {6}matrix: \$\{\{ steps\.count\.outputs\.matrix \}\}$/m);
  });
  it.each(['merge_group', 'schedule', 'workflow_dispatch'])('%s always gets six', (event) => {
    expect(pick(event, { kind: 'none' })).toEqual(SIX);
  });
  // The last four are files `turbo --affected` reads as touching every package
  // (#3361 ran all 33 suites on two shards for a turbo.json edit).
  it.each([
    'apps/server/src/services/a.ts',
    'packages/shared/src/b.ts',
    'turbo.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ])('a pull request that changes %s gets six', (file) => {
    expect(pick('pull_request', { kind: 'merge', files: ['apps/client/src/a.ts', file] })).toEqual(
      SIX
    );
  });
  it('a pull request that only deletes a server file still gets six', () => {
    expect(
      pick('pull_request', { kind: 'merge', files: [], removed: ['apps/server/src/moved.ts'] })
    ).toEqual(SIX);
  });
  it('a pull request near but outside those folders keeps two', () => {
    expect(
      pick('pull_request', {
        kind: 'merge',
        files: [
          'packages/shared-ui/a.ts',
          'apps/server-notes.md',
          'docs/apps/server/a.md',
          'apps/client/package.json',
          'docs/turbo.json',
        ],
      })
    ).toEqual([1, 2]);
  });
  it('falls back to six when HEAD is not a test-merge commit', () => {
    expect(pick('pull_request', { kind: 'plain', files: ['apps/client/src/a.ts'] })).toEqual(SIX);
  });
  it('falls back to six when there is no repository to diff', () => {
    expect(pick('pull_request', { kind: 'none' })).toEqual(SIX);
  });
});
