import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  gitIsAncestor,
  gitPatchId,
  patchFingerprint,
  readReleaseBranchCommits,
} from '../../scripts/release-branch/proof.js';
import { checkReleaseCherryPicks } from '../../scripts/release-branch/rules.js';

// A real throwaway git repo with made-up content: the rule's inputs come from
// git itself here, so a patch-id or ancestry mistake cannot hide behind a mock.
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
let pinSha = '';
let fixOnMain = '';
let mainTip = '';

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'release-branch-git-'));
  git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'VERSION'), '1.2.2\n');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'dorkos', version: '1.2.2' }, null, 2) + '\n'
  );
  await commit('app.ts', 'export const a = 1;\n', 'feat: app');
  pinSha = git('rev-parse', 'HEAD');
  await commit('other.ts', 'export const b = 1;\n', 'feat: after the pin');
  fixOnMain = await commit('app.ts', 'export const a = 2;\n', 'fix: a is two (#7)');
  mainTip = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'release/v1.2.3', pinSha);
});
afterAll(() => rm(repo, { recursive: true, force: true }));

it('accepts a clean -x pick and the release commit, read from real git', async () => {
  git('cherry-pick', '-x', fixOnMain);
  await writeFile(join(repo, 'VERSION'), '1.2.3\n');
  await commit(
    'package.json',
    JSON.stringify({ name: 'dorkos', version: '1.2.3' }, null, 2) + '\n',
    'chore(release): v1.2.3'
  );
  const head = git('rev-parse', 'HEAD');
  const commits = readReleaseBranchCommits(repo, pinSha, head);
  expect(commits).toHaveLength(2);
  expect(commits[0].patchId).toBe(gitPatchId(repo, fixOnMain));
  expect(commits[1].files.find((f) => f.path === 'package.json')?.after).toContain('1.2.3');
  expect(
    checkReleaseCherryPicks({
      version: '1.2.3',
      commits,
      isMainAncestor: (sha) => gitIsAncestor(repo, sha, mainTip),
      patchIdOf: (sha) => gitPatchId(repo, sha),
    })
  ).toEqual([]);
});

it('refuses a pick that was edited after picking (patch-id differs)', async () => {
  const before = git('rev-parse', 'HEAD');
  git('cherry-pick', '-x', '--no-commit', fixOnMain);
  await writeFile(join(repo, 'app.ts'), 'export const a = 3;\n');
  git('add', '-A');
  git('commit', '-q', '-m', `fix: a is two (#7)\n\n(cherry picked from commit ${fixOnMain})`);
  const commits = readReleaseBranchCommits(repo, before, git('rev-parse', 'HEAD'));
  expect(
    checkReleaseCherryPicks({
      version: '1.2.3',
      commits,
      isMainAncestor: (sha) => gitIsAncestor(repo, sha, mainTip),
      patchIdOf: (sha) => gitPatchId(repo, sha),
    })[0]?.code
  ).toBe('patch-id-mismatch');
});

it('tells apart changes git patch-id would call equal: whitespace and binary contents', async () => {
  // git patch-id --stable ignores whitespace and sees only "Binary files differ".
  const start = git('rev-parse', 'HEAD');
  const spaced = await commit('msg.ts', "export const m = 'a b';\n", 'feat: spaced');
  git('reset', '-q', '--hard', start);
  const unspaced = await commit('msg.ts', "export const m = 'ab';\n", 'feat: unspaced');
  expect(gitPatchId(repo, spaced)).toBeDefined();
  expect(gitPatchId(repo, spaced)).not.toBe(gitPatchId(repo, unspaced));

  git('reset', '-q', '--hard', start);
  const blobA = await commit('logo.bin', '\u0000\u0001A\u0000', 'feat: logo');
  git('reset', '-q', '--hard', start);
  const blobB = await commit('logo.bin', '\u0000\u0001B\u0000', 'feat: logo');
  expect(gitPatchId(repo, blobA)).toBeDefined();
  expect(gitPatchId(repo, blobA)).not.toBe(gitPatchId(repo, blobB));
  git('reset', '-q', '--hard', start);
});

it('matches a clean pick whose hunk moved to other line numbers', () => {
  const at = (line: number) =>
    `diff --git a/x.ts b/x.ts\nindex ${'1'.repeat(40)}..${line}${'2'.repeat(39)} 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -${line},3 +${line},3 @@ function f()\n a\n-b\n+c\n d\n`;
  expect(patchFingerprint(at(3))).toBe(patchFingerprint(at(9)));
  expect(patchFingerprint(at(3))).not.toBe(patchFingerprint(at(3).replace('+c', '+c ')));
  expect(patchFingerprint('')).toBeUndefined();
  // Different invalid UTF-8 bytes must not fold into one U+FFFD.
  const withByte = (b: number) =>
    Buffer.concat([Buffer.from(at(3).replace('+c', '+')), Buffer.from([b, 0x0a])]);
  expect(patchFingerprint(withByte(0x80))).not.toBe(patchFingerprint(withByte(0xff)));
  // The function name after @@ is context, not change.
  expect(patchFingerprint(at(3))).toBe(patchFingerprint(at(3).replace('function f()', 'g()')));
});

it('knows a branch-only commit is not on main', async () => {
  const branchOnly = await commit('app.ts', 'export const a = 4;\n', 'fix: branch only');
  expect(gitIsAncestor(repo, branchOnly, mainTip)).toBe(false);
  expect(gitIsAncestor(repo, fixOnMain, mainTip)).toBe(true);
  expect(gitIsAncestor(repo, 'f'.repeat(40), mainTip)).toBe(false);
});
