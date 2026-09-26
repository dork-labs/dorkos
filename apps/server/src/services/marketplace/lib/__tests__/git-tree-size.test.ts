/**
 * The size limits on a git download (DOR-2321), against real local
 * repositories. The clone limits are shrunk for this file only: 1 MB and 100
 * files and folders.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/git-safety.js', async (importOriginal) => ({
  // The real `-c` hardening; only the environment is swapped for a local remote.
  internalGitArgs: (await importOriginal<typeof import('../../../../lib/git-safety.js')>())
    .internalGitArgs,
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

import { fetchTree, GitFetchError } from '../git/git-tree.js';
import {
  GIT_OUTPUT_LIMITS,
  killProcessTree,
  pastByteLimit,
  stopAllGit,
  trackGit,
} from '../git/git-runner.js';

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

describe('the blobless path sizes files before checkout (DOR-2321)', () => {
  // Purpose: the normal case (a package in a folder, fetched blobless). One
  // small download named several times would unpack past the byte limit;
  // its files are fetched and sized, counted once per place they appear,
  // before anything is written.
  it('refuses a blob that unpacks past the limit through repeated use', async () => {
    const blob = gitIn(work, Buffer.alloc(400 * 1024, 97), 'hash-object', '-w', '--stdin');
    const pkg = gitIn(
      work,
      Array.from({ length: 4 }, (_, i) => `100644 blob ${blob}\tcopy${i}`).join('\n') + '\n',
      'mktree'
    );
    const commit = commitTree(gitIn(work, `040000 tree ${pkg}\tpkg\n`, 'mktree'), 'repeated');
    const { dir, error } = await fetchInto(commit, 'pkg');
    expect(error!.message).toContain(
      'The download is larger than 1 MB, so DorkOS did not unpack it.'
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  // Purpose: within the limits, the blobless path still checks the package out.
  it('still checks out a folder within the limits', async () => {
    const { dir, error } = await fetchInto(small, 'pkg');
    expect(error).toBeUndefined();
    expect(existsSync(path.join(dir, 'pkg', 'SKILL.md'))).toBe(true);
  });
});

describe('stopping git (DOR-2321)', () => {
  // Purpose: a stopped git must not leave helpers running. On POSIX the whole
  // process group goes: a shell and the two sleeps it started all stop.
  it.skipIf(process.platform === 'win32')('kills the whole process group on POSIX', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const kids = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(Number);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    killProcessTree(child.pid!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const alive = [child.pid!, ...kids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    expect(alive).toEqual([]);
  });

  // Purpose: on Windows the tree is stopped with taskkill /T /F.
  it('uses taskkill /T /F on Windows', () => {
    const run = vi.fn();
    killProcessTree(1234, 'win32', run);
    expect(run).toHaveBeenCalledWith('taskkill', ['/T', '/F', '/PID', '1234']);
  });

  // Purpose: the byte watch stops git on either signal: the download on disk,
  // or free space falling by more than the limit (plus a margin for the
  // disk's other writers), which catches what a checkout writes.
  it.each([
    ['a download past the limit', { size: 11, freeBefore: 1e12, freeNow: 1e12 }, true],
    [
      'free space falling past the limit',
      { size: 0, freeBefore: 1e12, freeNow: 1e12 - 400e6 },
      true,
    ],
    ['free space within the margin', { size: 0, freeBefore: 1e12, freeNow: 1e12 - 100e6 }, false],
    ['free space unknown', { size: 0, freeBefore: undefined, freeNow: undefined }, false],
  ])('decides on %s', (_label, sample, stop) => {
    expect(pastByteLimit({ ...sample, maxBytes: 10 })).toBe(stop);
  });
});

describe('git output and running groups (DOR-2321)', () => {
  // Purpose: a tree listing is counted as it streams and never kept, so a
  // legitimate listing longer than the output limit is judged by the entry
  // and byte limits alone: a small package still fetches, and a tree past the
  // entry limit still gets the size message.
  it('judges a tree listing by the size limits, never the output limit', async () => {
    const saved = GIT_OUTPUT_LIMITS.stdoutChars;
    // Shorter than the small package's own listing, longer than any other
    // output its fetch keeps (a 41-character commit id).
    GIT_OUTPUT_LIMITS.stdoutChars = 50;
    try {
      const fetched = await fetchInto(small, '');
      expect(fetched.error).toBeUndefined();
      const refused = await fetchInto(bomb, '');
      expect(refused.error!.message).toContain('more than 100 files and folders');
    } finally {
      GIT_OUTPUT_LIMITS.stdoutChars = saved;
    }
  });

  // Purpose: output that is kept is capped, and passing the cap stops git.
  it('stops git that prints past the output limit', async () => {
    const saved = GIT_OUTPUT_LIMITS.stdoutChars;
    GIT_OUTPUT_LIMITS.stdoutChars = 5;
    try {
      const { error } = await fetchInto(small, '');
      expect(error!.message).toContain('git printed too much');
    } finally {
      GIT_OUTPUT_LIMITS.stdoutChars = saved;
    }
  });

  // Purpose: git runs in its own process group, which the terminal's Ctrl-C
  // no longer reaches, so running groups are tracked and stopped on the way
  // out, with exit and signal handlers installed the first time.
  it.skipIf(process.platform === 'win32')('stops every tracked group on the way out', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { detached: true });
    const before = process.listenerCount('SIGTERM');
    trackGit(child.pid!);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(Math.min(before + 1, 1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopAllGit();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});
