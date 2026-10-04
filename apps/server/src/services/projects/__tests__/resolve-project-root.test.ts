/**
 * The one project-root rule (spec `flow-multiproject` §6.1), against REAL git
 * repositories: what git reports about worktrees, bare repositories and
 * subfolders is the whole question, and a mocked runner could only repeat the
 * answer this module already assumes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runGit } from '../../workspace/providers/git.js';
import {
  createProjectRootResolver,
  MAX_CONCURRENT_ROOT_LOOKUPS,
  MAX_NEGATIVE_ROOT_TTL_MS,
  NEGATIVE_ROOT_TTL_MS,
  isNotARepository,
  negativeTtl,
  projectRootFromCommonDir,
} from '../resolve-project-root.js';

/** What the git runner throws when git says the folder is in no repository. */
function notARepo(): Error {
  return Object.assign(new Error('Command failed: git rev-parse'), {
    code: 128,
    stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
}

let base: string;
let main: string;
let worktree: string;
let dorkWorktree: string;
let subfolder: string;
let bare: string;
let bareWorktree: string;
let link: string;
let plain: string;
let holder: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'project-root-')));
  main = path.join(base, 'dev', 'dorkos');
  initRepo(main);
  worktree = path.join(base, 'dev', 'dorkos-wt');
  git(main, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  // The shape DorkOS's own workspaces take: `<dorkHome>/workspaces/<project>/<key>`.
  dorkWorktree = path.join(base, '.dork', 'workspaces', 'dorkos', 'dor-1');
  mkdirSync(path.dirname(dorkWorktree), { recursive: true });
  git(main, 'worktree', 'add', '-q', '-b', 'dor-1', dorkWorktree);
  subfolder = path.join(main, 'apps', 'server');
  mkdirSync(subfolder, { recursive: true });
  bare = path.join(base, 'origin.git');
  git(base, 'clone', '-q', '--bare', main, bare);
  // The "bare repo plus worktrees" layout: every checkout is a linked worktree.
  bareWorktree = path.join(base, 'bare-wt');
  git(bare, 'worktree', 'add', '-q', '-b', 'side', bareWorktree);
  link = path.join(base, 'dorkos-link');
  symlinkSync(main, link);
  plain = path.join(base, 'plain');
  mkdirSync(plain);
  // A folder that only holds repositories is in none of them.
  holder = path.join(base, 'repos');
  initRepo(path.join(holder, 'one'));
  initRepo(path.join(holder, 'two'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveProjectRoot', () => {
  const resolve = (dir: string) => createProjectRootResolver().resolve(dir);

  it('answers a main checkout with itself', async () => {
    expect(await resolve(main)).toBe(main);
  });

  it('maps a linked worktree to its main checkout', async () => {
    expect(await resolve(worktree)).toBe(main);
  });

  it('maps a worktree under ~/.dork/workspaces/ to its main checkout', async () => {
    expect(await resolve(dorkWorktree)).toBe(main);
  });

  it('maps a subfolder to its main checkout', async () => {
    expect(await resolve(subfolder)).toBe(main);
  });

  it('maps a worktree of a bare repository to the bare repository itself', async () => {
    expect(await resolve(bareWorktree)).toBe(bare);
  });

  it('does not read a bare repository folder it merely stumbled on (safe.bareRepository=explicit)', async () => {
    // The hardened runner refuses implicit bare repositories (DOR-2326), so
    // the folder itself is no project; its worktrees still are.
    expect(await resolve(bare)).toBeNull();
  });

  it('reads a symlink and its target as one project', async () => {
    expect(await resolve(link)).toBe(main);
    expect(await resolve(path.join(link, 'apps', 'server'))).toBe(main);
  });

  it('answers null for a folder in no repository', async () => {
    expect(await resolve(plain)).toBeNull();
  });

  it('answers null for a folder that holds two repositories but is in neither', async () => {
    expect(await resolve(holder)).toBeNull();
    expect(await resolve(path.join(holder, 'two'))).toBe(path.join(holder, 'two'));
  });

  it('answers null for a relative folder instead of reading the server cwd', async () => {
    expect(await resolve('dev/dorkos')).toBeNull();
  });
});

describe('the cache', () => {
  it('asks git once per folder, shared by concurrent callers, for the life of the process', async () => {
    const spy = vi.fn(runGit);
    let clock = 0;
    const resolver = createProjectRootResolver({ runGit: spy, now: () => clock });
    await Promise.all([resolver.resolve(worktree), resolver.resolve(worktree)]);
    clock = 10 * NEGATIVE_ROOT_TTL_MS;
    expect(await resolver.resolve(worktree)).toBe(main);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps "no project" for 60 seconds, then asks git again', async () => {
    const spy = vi.fn(runGit);
    let clock = 0;
    const resolver = createProjectRootResolver({ runGit: spy, now: () => clock });
    await resolver.resolve(plain);
    clock = NEGATIVE_ROOT_TTL_MS - 1;
    await resolver.resolve(plain);
    expect(spy).toHaveBeenCalledTimes(1);
    clock = NEGATIVE_ROOT_TTL_MS;
    await resolver.resolve(plain);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('peeks without running git: undefined before, the root after, null for no project', async () => {
    const spy = vi.fn(runGit);
    const resolver = createProjectRootResolver({ runGit: spy });
    expect(resolver.peek(subfolder)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    await resolver.resolve(subfolder);
    await resolver.resolve(plain);
    expect(resolver.peek(subfolder)).toBe(main);
    expect(resolver.peek(plain)).toBeNull();
  });

  it('waits longer after each further "no project", up to the ceiling', async () => {
    const spy = vi.fn(runGit);
    let clock = 0;
    const resolver = createProjectRootResolver({ runGit: spy, now: () => clock });
    await resolver.resolve(plain); // miss 1, kept 1 minute
    clock += NEGATIVE_ROOT_TTL_MS;
    await resolver.resolve(plain); // miss 2, kept 2 minutes
    expect(spy).toHaveBeenCalledTimes(2);
    clock += 2 * NEGATIVE_ROOT_TTL_MS - 1;
    await resolver.resolve(plain);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(resolver.peek(plain)).toBeNull();
    clock += 1;
    await resolver.resolve(plain);
    expect(spy).toHaveBeenCalledTimes(3);
    expect([1, 2, 3, 4, 5, 50].map(negativeTtl)).toEqual([
      NEGATIVE_ROOT_TTL_MS,
      2 * NEGATIVE_ROOT_TTL_MS,
      4 * NEGATIVE_ROOT_TTL_MS,
      8 * NEGATIVE_ROOT_TTL_MS,
      MAX_NEGATIVE_ROOT_TTL_MS,
      MAX_NEGATIVE_ROOT_TTL_MS,
    ]);
  });

  it('finds a folder that became a repository once its wait runs out', async () => {
    let isRepo = false;
    const fakeGit = vi.fn(async () => {
      if (!isRepo) throw notARepo();
      return '/repos/a/.git\n';
    });
    let clock = 0;
    const resolver = createProjectRootResolver({
      runGit: fakeGit as unknown as typeof runGit,
      now: () => clock,
      canonical: (dir) => dir,
    });
    await resolver.resolve('/repos/a'); // miss 1
    clock += NEGATIVE_ROOT_TTL_MS;
    await resolver.resolve('/repos/a'); // miss 2, kept 2 minutes
    isRepo = true;
    clock += 2 * NEGATIVE_ROOT_TTL_MS;
    expect(await resolver.resolve('/repos/a')).toBe('/repos/a');
    expect(fakeGit).toHaveBeenCalledTimes(3);
  });

  it('never backs off on a failure that is not git saying "not a repository"', async () => {
    // A timeout (killed, no stderr), git missing (ENOENT), then the real answer.
    const timeout = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
    const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const failures: unknown[] = [timeout, missing, timeout, notARepo(), timeout];
    const fakeGit = vi.fn(async () => {
      throw failures.shift();
    });
    let clock = 0;
    const resolver = createProjectRootResolver({
      runGit: fakeGit as unknown as typeof runGit,
      now: () => clock,
      canonical: (dir) => dir,
    });
    for (let i = 0; i < 3; i++) {
      await resolver.resolve('/repos/flaky');
      clock += NEGATIVE_ROOT_TTL_MS; // each transient miss is retried after the base minute
    }
    expect(fakeGit).toHaveBeenCalledTimes(3);
    await resolver.resolve('/repos/flaky'); // the first real "not a repository": 1 minute
    clock += NEGATIVE_ROOT_TTL_MS;
    await resolver.resolve('/repos/flaky'); // a timeout again: 1 minute, count kept
    expect(fakeGit).toHaveBeenCalledTimes(5);
    expect(resolver.peek('/repos/flaky')).toBeNull();
    clock += NEGATIVE_ROOT_TTL_MS;
    expect(resolver.peek('/repos/flaky')).toBeUndefined();
  });

  it('reads git\'s own "not a git repository" as the only answer worth backing off on', () => {
    expect(isNotARepository(notARepo())).toBe(true);
    expect(isNotARepository({ stderr: Buffer.from('fatal: not a git repository') })).toBe(true);
    expect(isNotARepository(new Error('not a git repository'))).toBe(false);
    expect(isNotARepository({ killed: true, stderr: '' })).toBe(false);
    expect(isNotARepository(undefined)).toBe(false);
  });

  it(`never runs more than ${MAX_CONCURRENT_ROOT_LOOKUPS} git calls at once across cold folders`, async () => {
    let running = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const fakeGit = vi.fn(async (_args: string[], cwd: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
      return `${cwd}/.git\n`;
    });
    const resolver = createProjectRootResolver({
      runGit: fakeGit as unknown as typeof runGit,
      canonical: (dir) => dir,
    });
    const folders = Array.from({ length: 25 }, (_, i) => `/repos/r${i}`);
    const all = Promise.all(folders.map((dir) => resolver.resolve(dir)));
    while (fakeGit.mock.calls.length < folders.length || release.length > 0) {
      await new Promise((resolve) => setImmediate(resolve));
      expect(running).toBeLessThanOrEqual(MAX_CONCURRENT_ROOT_LOOKUPS);
      release.splice(0).forEach((go) => go());
    }
    expect(await all).toEqual(folders);
    expect(peak).toBe(MAX_CONCURRENT_ROOT_LOOKUPS);
    expect(fakeGit).toHaveBeenCalledTimes(folders.length);
  });

  it('reads uncached on every call', async () => {
    const spy = vi.fn(runGit);
    const resolver = createProjectRootResolver({ runGit: spy });
    expect(await resolver.readUncached(worktree)).toBe(main);
    expect(await resolver.readUncached(worktree)).toBe(main);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('projectRootFromCommonDir', () => {
  it('takes the parent of a .git common dir', () => {
    expect(projectRootFromCommonDir('/repos/dorkos/.git\n')).toBe('/repos/dorkos');
  });

  it('keeps a bare repository as its own root', () => {
    expect(projectRootFromCommonDir('/repos/dorkos.git\n')).toBe('/repos/dorkos.git');
  });

  it('reads empty output as no root', () => {
    expect(projectRootFromCommonDir('')).toBeNull();
  });
});
