/**
 * A throwaway git repo for the repo settings tests (DOR-3298): a `main`
 * branch with one commit, and worktrees beside it, all made with the real git
 * through `execFileSync` and an argument list.
 *
 * The child env drops every `GIT_*` variable the test runner may carry (a
 * DorkOS session sets some), and pins identity and config so a person's own
 * git setup never leaks in.
 *
 * @module services/runtimes/claude-code/repo-settings/__tests__/git-fixture
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The env every fixture git command runs with. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

/**
 * Run git in a folder and return its trimmed stdout.
 *
 * @param cwd - Where to run.
 * @param args - The subcommand and its arguments.
 */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();
}

/**
 * Write a file, making its folder.
 *
 * @param file - The absolute path.
 * @param content - Text, or a value written as JSON.
 */
export function writeFile(file: string, content: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** A repo on disk. */
export interface RepoFixture {
  /** The temp folder holding everything. */
  root: string;
  /** The main checkout, on `main`. */
  main: string;
  /** Add a worktree on a new branch from `main`. */
  addWorktree: (name: string) => string;
  /** Commit every change in the main checkout to `main`. */
  commit: (message: string) => string;
  /** Remove everything. */
  cleanup: () => void;
}

/**
 * Make a repo whose `main` holds `files` (path to content) in one commit.
 *
 * @param files - Repo-relative path to content.
 */
export function makeRepo(files: Record<string, unknown>): RepoFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-')));
  const main = path.join(root, 'repo');
  fs.mkdirSync(main);
  git(main, ['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(main, rel), content);
  const commit = (message: string) => {
    git(main, ['add', '-A']);
    git(main, ['commit', '-q', '--allow-empty', '-m', message]);
    return git(main, ['rev-parse', 'HEAD']);
  };
  commit('initial');
  return {
    root,
    main,
    commit,
    addWorktree: (name) => {
      const dir = path.join(root, name);
      git(main, ['worktree', 'add', '-q', '-b', name, dir, 'main']);
      return dir;
    },
    cleanup: () =>
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

/**
 * Take every `GIT_*` variable out of this process's env, so the code under
 * test reads the fixture repo and nothing a session pointed git at. Returns
 * the function that puts them back.
 */
export function isolateGitEnv(): () => void {
  const saved: [string, string | undefined][] = [];
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('GIT_')) continue;
    saved.push([key, process.env[key]]);
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of saved) process.env[key] = value;
  };
}
