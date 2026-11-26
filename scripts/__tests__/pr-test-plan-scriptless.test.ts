/**
 * The pull request leg's test plan never selects a package with no `test`
 * script. Turbo's dry-run plan lists a `test` task for every package and gives
 * one with no script the command `<NONEXISTENT>`; planning it made the merge
 * queue's "suite actually executed" proof refuse every shard (#4496).
 *
 * A stubbed turbo stands in here, as in pr-test-plan.test.ts's failure cases:
 * the point is what the planner does with a task turbo marks this way.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'scripts/pr-test-plan.sh');

// The child git must not inherit a session's GIT_* settings or a person's own config.
const env = Object.fromEntries(
  // eslint-disable-next-line no-restricted-syntax -- the real script runs under a real environment.
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

const scratch = mkdtempSync(path.join(tmpdir(), 'dorkos-pr-plan-scriptless-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run git in the fixture repo with a fixed identity. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env }
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** Write a file in the fixture repo, making its folders, and commit it. */
function commit(repo: string, file: string, body: string): string {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', file);
  return git(repo, 'rev-parse', 'HEAD');
}

it('drops a task turbo marks <NONEXISTENT>, even when its hash moved', () => {
  const repo = path.join(scratch, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const base = commit(repo, 'packages/shared/src/index.ts', 'one\n');
  const head = commit(repo, 'packages/shared/src/index.ts', 'two\n');

  // Both hashes follow the checkout the planner runs in, so both tasks look
  // changed; only the one with a real command may be planned.
  const stub = path.join(scratch, 'scriptless-turbo.sh');
  const task = (id: string, pkg: string, dir: string, command: string) =>
    `{"task":"test","taskId":"${id}","hash":"${pkg}-%s","package":"${pkg}","directory":"${dir}","command":"${command}"}`;
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'h=$(printf %s "$PWD" | cksum | cut -d" " -f1)',
      `printf '{"tasks":[${task('shared#test', 'shared', 'packages/shared', 'vitest run')},${task('eslint-config#test', 'eslint-config', 'packages/eslint-config', '<NONEXISTENT>')}]}\\n' "$h" "$h"`,
      '',
    ].join('\n')
  );
  chmodSync(stub, 0o755);

  const result = spawnSync('bash', [script, base, head], {
    encoding: 'utf8',
    env: { ...env, REPO_ROOT: repo, TURBO: stub },
  });
  expect(result.status, result.stderr).toBe(0);
  const [verdict, ...suites] = result.stdout.trim().split('\n');
  expect({ verdict, suites }).toEqual({ verdict: 'selected', suites: ['shared packages/shared'] });
});
