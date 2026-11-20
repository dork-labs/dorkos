import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkPicksInRepo } from '../../scripts/release-branch/check-picks.js';

// Security M1 (Nov 19) and S1, on a real throwaway repo with made-up content:
// a commit main reverted must not come back by being cherry-picked again.
let repo = '';
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
const commit = async (file: string, body: string, message: string) => {
  await writeFile(join(repo, file), body);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};
const releaseCommit = async () => {
  await writeFile(join(repo, 'VERSION'), '1.0.1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore(release): v1.0.1');
  return git('rev-parse', 'HEAD');
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'release-branch-revert-'));
  git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'VERSION'), '1.0.0\n');
  await commit('auth.ts', 'export const ok = (u: { ok: boolean }) => u.ok;\n', 'feat: auth');
});
afterEach(() => rm(repo, { recursive: true, force: true }));

it('refuses re-picking a commit main reverted before the cut (source-before-cut)', async () => {
  const backdoor = await commit('auth.ts', 'export const ok = () => true;\n', 'feat: faster auth');
  git('revert', '--no-edit', backdoor);
  const pin = await commit('other.ts', 'export const x = 1;\n', 'feat: other');
  git('switch', '-q', '-c', 'release/v1.0.1', pin);
  git('cherry-pick', '-x', backdoor);
  const head = await releaseCommit();
  const findings = checkPicksInRepo({
    repoDir: repo,
    version: '1.0.1',
    base: pin,
    head,
    mainSha: pin,
  });
  expect(findings.map((f) => f.code)).toEqual(['source-before-cut']);
});

it('refuses a pick whose source main reverted after the cut (source-reverted-on-main)', async () => {
  const pin = git('rev-parse', 'HEAD');
  const backdoor = await commit('auth.ts', 'export const ok = () => true;\n', 'feat: faster auth');
  git('revert', '--no-edit', backdoor);
  const mainTip = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'release/v1.0.1', pin);
  git('cherry-pick', '-x', backdoor);
  const head = await releaseCommit();
  const findings = checkPicksInRepo({
    repoDir: repo,
    version: '1.0.1',
    base: pin,
    head,
    mainSha: mainTip,
  });
  expect(findings.map((f) => f.code)).toEqual(['source-reverted-on-main']);
});

it('still accepts a clean pick of a main fix that stayed', async () => {
  const pin = git('rev-parse', 'HEAD');
  const fix = await commit(
    'auth.ts',
    'export const ok = (u: { ok: boolean }) => u.ok === true;\n',
    'fix: auth'
  );
  git('switch', '-q', '-c', 'release/v1.0.1', pin);
  git('cherry-pick', '-x', fix);
  const head = await releaseCommit();
  expect(
    checkPicksInRepo({ repoDir: repo, version: '1.0.1', base: pin, head, mainSha: fix })
  ).toEqual([]);
});
