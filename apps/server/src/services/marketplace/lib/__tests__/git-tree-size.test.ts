/**
 * The size limits on a git download (DOR-2321), against real local
 * repositories. The clone limits are shrunk for this file only: 1 MB and 100
 * files and folders.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
  CLONE_SIZE_LIMITS: { maxTotalBytes: 1024 * 1024, maxEntries: 100, maxFileBytes: 1024 * 1024 },
}));

import { fetchTree, GitFetchError } from '../git-tree.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Write an object from stdin and return its id. */
function gitIn(cwd: string, input: string | Buffer, ...args: string[]): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8' }).trim();
}

let root: string;
let work: string;
let bare: string;
let url: string;

/** A new commit whose root tree is `tree`, pushed as `branch`; returns its id. */
function commitTree(tree: string, branch: string): string {
  const commit = gitIn(work, 'x', 'commit-tree', tree, '-m', branch);
  git(work, 'push', '-q', 'origin', `${commit}:refs/heads/${branch}`);
  return commit;
}

/** A tree of `fan`^`depth` files built from a handful of shared objects. */
function fanOutTree(fan: number, depth: number): string {
  let tree = gitIn(
    work,
    Array.from(
      { length: fan },
      (_, i) => `100644 blob ${gitIn(work, 'x', 'hash-object', '-w', '--stdin')}\tf${i}`
    ).join('\n') + '\n',
    'mktree'
  );
  for (let level = 1; level < depth; level++) {
    tree = gitIn(
      work,
      Array.from({ length: fan }, (_, i) => `040000 tree ${tree}\td${i}`).join('\n') + '\n',
      'mktree'
    );
  }
  return tree;
}

/** A tree holding one file with `content` at `pkg/big.bin`. */
function treeWithFile(content: Buffer): string {
  const blob = gitIn(work, content, 'hash-object', '-w', '--stdin');
  const pkg = gitIn(work, `100644 blob ${blob}\tbig.bin\n`, 'mktree');
  return gitIn(work, `040000 tree ${pkg}\tpkg\n`, 'mktree');
}

let small: string;
let bomb: string;
let compressible: string;
let incompressible: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'git-tree-size-'));
  work = path.join(root, 'work');
  bare = path.join(root, 'remote.git');
  url = `file://${bare}`;
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 't');
  git(work, 'remote', 'add', 'origin', bare);
  mkdirSync(path.join(work, 'pkg'));
  writeFileSync(path.join(work, 'pkg', 'SKILL.md'), 'small');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'small');
  small = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'main');

  // 4^5 = 1,024 files from a few hundred bytes of objects.
  const fan = fanOutTree(4, 5);
  bomb = commitTree(gitIn(work, `040000 tree ${fan}\tpkg\n`, 'mktree'), 'bomb');
  // 2 MB that packs to a few kilobytes: only the tree listing's sizes see it.
  compressible = commitTree(treeWithFile(Buffer.alloc(2 * 1024 * 1024, 120)), 'compressible');
  // 24 MB that cannot be compressed: the download itself passes the limit.
  incompressible = commitTree(treeWithFile(randomBytes(24 * 1024 * 1024)), 'incompressible');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Fetch `commitSha` into a new directory; returns the directory and the error. */
async function fetchInto(commitSha: string, subpath: string) {
  const dir = mkdtempSync(path.join(root, 'dest-'));
  const error = await fetchTree({ cloneUrl: url, commitSha, subpath, destDir: dir }).then(
    () => undefined,
    (err: unknown) => err as Error
  );
  return { dir, error };
}

describe('fetchTree size limits (DOR-2321)', () => {
  // Purpose: a download within the limits arrives as before.
  it('keeps a download within the limits', async () => {
    const { dir, error } = await fetchInto(small, '');
    expect(error).toBeUndefined();
    expect(existsSync(path.join(dir, 'pkg', 'SKILL.md'))).toBe(true);
  });

  // Purpose: a tiny tree that names thousands of files is refused from its
  // listing, before a single file is written, whole or blobless.
  it.each([
    ['whole', ''],
    ['blobless, sparse to its folder', 'pkg'],
  ])('refuses a fan-out tree before checkout (%s)', async (_label, subpath) => {
    const { dir, error } = await fetchInto(bomb, subpath);
    expect(error).toBeInstanceOf(GitFetchError);
    expect(error!.message).toContain(
      'The download has more than 100 files and folders, so DorkOS did not unpack it.'
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  // Purpose: with the files downloaded, their sizes in the listing refuse a
  // tree that would unpack past the byte limit, however small its download.
  it('refuses a tree that would unpack past the byte limit, before checkout', async () => {
    const { dir, error } = await fetchInto(compressible, '');
    expect(error!.message).toContain(
      'The download is larger than 1 MB, so DorkOS did not unpack it.'
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  // Purpose: a download that grows past the byte limit is stopped while git
  // is still downloading, and removed.
  it('stops a download that grows past the byte limit', async () => {
    const { dir, error } = await fetchInto(incompressible, '');
    expect(error!.message).toContain('The download grew past 1 MB, so DorkOS stopped it.');
    expect(readdirSync(dir)).toEqual([]);
  }, 60_000);
});
