/**
 * Room git never looks inside a submodule: every working-tree reader runs with
 * `--ignore-submodules=all`, and a caller asking for any other mode is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { withSubmodulesSkipped } from '../room-git-args.js';
import { commitAll, initRepo } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const run = promisify(execFile);

/** Plain git, as an agent's own shell runs it. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', ['-c', 'user.name=Hand', '-c', 'user.email=hand@example.com', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

describe('room git and submodules', () => {
  it('adds the skip flag right after each working-tree reader', () => {
    expect(withSubmodulesSkipped(['status', '--porcelain=v1'])).toEqual([
      'status',
      '--ignore-submodules=all',
      '--porcelain=v1',
    ]);
    expect(withSubmodulesSkipped(['--no-optional-locks', 'diff', '--stat'])).toEqual([
      '--no-optional-locks',
      'diff',
      '--ignore-submodules=all',
      '--stat',
    ]);
    expect(withSubmodulesSkipped(['-C', 'x', '-c', 'a.b=c', 'diff-index', 'HEAD'])).toEqual([
      '-C',
      'x',
      '-c',
      'a.b=c',
      'diff-index',
      '--ignore-submodules=all',
      'HEAD',
    ]);
  });

  it('leaves other commands as they are', () => {
    expect(withSubmodulesSkipped(['rev-parse', 'HEAD'])).toEqual(['rev-parse', 'HEAD']);
    expect(withSubmodulesSkipped(['ls-files', '-s', '-z'])).toEqual(['ls-files', '-s', '-z']);
  });

  it('refuses a caller that asks git to look inside submodules', () => {
    expect(() => withSubmodulesSkipped(['status', '--ignore-submodules=none'])).toThrow();
    expect(() => withSubmodulesSkipped(['diff', '--ignore-submodules'])).toThrow();
  });
});

describe('staging files beside a submodule', () => {
  let scratch: string;
  let home: string;
  let repo: string;
  let marker: string;
  const who = { name: 'Dorian', email: 'operator@dorkos.local' };

  /** A folder in the room's checkout with its own git and a filter that leaves a marker. */
  async function plantRepo(): Promise<string> {
    const sub = path.join(repo, 'sub');
    await mkdir(sub, { recursive: true });
    await git(sub, 'init', '-q', '-b', 'main');
    await git(sub, 'config', 'filter.probe.clean', `sh -c 'touch "${marker}"; cat'`);
    await writeFile(path.join(sub, '.gitattributes'), '* filter=probe\n', 'utf-8');
    await writeFile(path.join(sub, 'a.txt'), 'one\n', 'utf-8');
    await git(sub, 'add', '.');
    await git(sub, 'commit', '-q', '-m', 'sub');
    await rm(marker, { force: true });
    return sub;
  }

  beforeEach(async () => {
    silenceGitAutoMaintenance();
    scratch = realpathSync(await mkdtemp(path.join(tmpdir(), 'dorkos-room-submodule-')));
    home = path.join(scratch, 'rooms', 'room-1');
    repo = path.join(home, 'repo');
    marker = path.join(scratch, 'filter-ran');
    await mkdir(repo, { recursive: true });
    await initRepo(repo, home);
    await writeFile(path.join(repo, 'README.md'), '# room\n', 'utf-8');
    await commitAll(repo, 'first', who, home);
  });

  afterEach(async () => {
    await removeFixtureTree(scratch);
  });

  it('refuses to stage a folder that holds its own git, and runs nothing in it', async () => {
    await plantRepo();
    await writeFile(path.join(repo, 'NOTES.md'), 'a note\n', 'utf-8');

    await expect(commitAll(repo, 'keep', who, home)).rejects.toThrow(/beside a submodule/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses to stage a folder holding its own git under an untracked folder', async () => {
    const sub = path.join(repo, 'outer', 'inner');
    await mkdir(sub, { recursive: true });
    await git(sub, 'init', '-q', '-b', 'main');
    await writeFile(path.join(sub, 'a.txt'), 'one\n', 'utf-8');
    await git(sub, 'add', '.');
    await git(sub, 'commit', '-q', '-m', 'inner');

    await expect(commitAll(repo, 'keep', who, home)).rejects.toThrow(/beside a submodule/);
  });

  it('refuses to stage while the index holds a submodule entry, and runs nothing in it', async () => {
    const sub = await plantRepo();
    await git(repo, 'add', 'sub');
    await rm(marker, { force: true });
    await writeFile(path.join(sub, 'a.txt'), 'two\n', 'utf-8');

    await expect(commitAll(repo, 'keep', who, home)).rejects.toThrow(/beside a submodule/);
    expect(existsSync(marker)).toBe(false);
  });
});
