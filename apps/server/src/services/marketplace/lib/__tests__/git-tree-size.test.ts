/**
 * The size check on a git download (DOR-2321), against a real local
 * repository. The clone limits are shrunk for this file only, so a small
 * commit can pass them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/git-safety.js', () => ({
  hardenedGitEnv: () => ({
    ...process.env,
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }),
}));

vi.mock('@dorkos/marketplace/package-size', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/marketplace/package-size')>()),
  CLONE_SIZE_LIMITS: { maxTotalBytes: 1000, maxFiles: 100, maxFileBytes: 1000 },
}));

import { fetchTree, GitFetchError } from '../git-tree.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let root: string;
let url: string;
let small: string;
let large: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'git-tree-size-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'remote.git');
  url = `file://${bare}`;
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 't');
  git(work, 'remote', 'add', 'origin', bare);
  mkdirSync(path.join(work, 'pkg'));
  writeFileSync(path.join(work, 'pkg', 'SKILL.md'), 'small');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'small');
  small = git(work, 'rev-parse', 'HEAD');
  writeFileSync(path.join(work, 'pkg', 'big.bin'), 'x'.repeat(5000));
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'large');
  large = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'main');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fetchTree size check (DOR-2321)', () => {
  // Purpose: a download within the limits arrives as before.
  it('keeps a download within the limits', async () => {
    const dir = mkdtempSync(path.join(root, 'dest-'));
    expect(await fetchTree({ cloneUrl: url, commitSha: small, subpath: '', destDir: dir })).toBe(
      small
    );
    expect(existsSync(path.join(dir, 'pkg', 'SKILL.md'))).toBe(true);
  });

  // Purpose: a download over the limits is refused with a plain reason and
  // removed before anything can read it.
  it('refuses and removes a download over the limits', async () => {
    const dir = mkdtempSync(path.join(root, 'dest-'));
    const error = await fetchTree({
      cloneUrl: url,
      commitSha: large,
      subpath: '',
      destDir: dir,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitFetchError);
    expect((error as Error).message).toMatch(/larger than 1 KB/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
