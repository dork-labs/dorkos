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
  NEGATIVE_ROOT_TTL_MS,
  projectRootFromCommonDir,
} from '../resolve-project-root.js';

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
