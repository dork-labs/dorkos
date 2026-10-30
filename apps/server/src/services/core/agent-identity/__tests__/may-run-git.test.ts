/**
 * DorkOS never runs git in an agent folder (DOR-3343, the kill switch).
 *
 * Two markers, either of which proves git ran: the repository's own settings
 * name a clean filter that writes a marker file, and `git` and `gh` on PATH are
 * stand-ins that write the same marker before handing over to the real git.
 * The first case proves both fire in a folder that is no agent's, so the
 * others cannot pass by accident. Then each of the four server paths that ran
 * git in an agent's folder — git status, the carry-over summary, the diff's
 * HEAD baseline and the heartbeat workspace gatherer — must give its empty
 * answer, and the marker must never appear.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitStatus } from '../../git-status.js';
import { runGitForSummary } from '../../../session/fleet/carry-over-summary.js';
import { gitShowHead } from '../../../diff/git-baseline.js';
import { createWorkspaceGatherer, runCommand } from '../../../heartbeats/gatherers/workspace.js';
import { GitRepoConfigUnsafeError } from '@dorkos/shared/safe-git';
import { scanWorktrees } from '../../../workspace/worktree-scan.js';
import { fileLister } from '../../file-lister.js';
import { mayRunGitHere, setGitGuardRoots } from '../may-run-git.js';
import { setAgentHomeRegistry } from '../agent-home.js';
import { clearTestHomes, registerTestHomes } from './agent-home-fixture.js';

vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  BoundaryError: class BoundaryError extends Error {},
}));

/** The real git, found once before PATH gets the stand-ins. */
const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
const git = (cwd: string, ...args: string[]) =>
  execFileSync(realGit, args, { cwd, stdio: 'pipe' }).toString().trim();
const commit = (cwd: string, message: string, ...extra: string[]) =>
  git(
    cwd,
    '-c',
    'user.email=a@example.com',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    ...extra,
    '-m',
    message
  );

describe('mayRunGitHere: the git kill switch', () => {
  let scratch: string;
  let marker: string;
  let standIns: string;

  /**
   * A repository whose own settings run a program when git reads it: a clean
   * filter on every file, and a tracked file changed since the last commit.
   */
  function repoThatRunsItsOwnSettings(dir: string): string {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=mark\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    commit(dir, 'one');
    const filter = path.join(scratch, 'filter.sh');
    fs.writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    git(dir, 'config', 'filter.mark.clean', filter);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    return dir;
  }

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'may-run-git-')));
    marker = path.join(scratch, 'ran');
    standIns = path.join(scratch, 'bin');
    fs.mkdirSync(standIns);
    fs.writeFileSync(
      path.join(standIns, 'git'),
      `#!/bin/sh\ntouch '${marker}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(standIns, 'gh'),
      `#!/bin/sh\ntouch '${marker}' '${marker}.gh'\nexit 1\n`,
      {
        mode: 0o755,
      }
    );
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  beforeEach(() => {
    vi.stubEnv('PATH', `${standIns}${path.delimiter}${process.env.PATH ?? ''}`);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    clearTestHomes();
    setGitGuardRoots(() => []);
    fs.rmSync(marker, { force: true });
  });

  it('both markers fire in a folder that is no agent`s, which still gets git status', async () => {
    const project = repoThatRunsItsOwnSettings(path.join(scratch, 'project'));
    registerTestHomes([path.join(scratch, 'agents', 'ana')]);
    expect(mayRunGitHere(project)).toBe(true);
    // The repository's own clean filter fires under plain git.
    vi.unstubAllEnvs();
    git(project, 'status', '--porcelain=v1');
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    // The stand-in fires when DorkOS starts git; the filter itself is now
    // refused by the runner's audit, so status is read from a clean copy.
    vi.stubEnv('PATH', `${standIns}${path.delimiter}${process.env.PATH ?? ''}`);
    git(project, 'config', '--unset', 'filter.mark.clean');
    await expect(getGitStatus(project)).resolves.toMatchObject({ branch: 'main', modified: 1 });
    expect(fs.existsSync(marker)).toBe(true);
  });

  describe('in an agent home', () => {
    let home: string;
    beforeAll(() => {
      home = path.join(scratch, 'agents', 'ana');
    });

    it('git status answers "not a repository" and runs nothing', async () => {
      repoThatRunsItsOwnSettings(home);
      registerTestHomes([home]);
      await expect(getGitStatus(home)).resolves.toEqual({ error: 'not_git_repo' });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('git status refuses a subfolder of the home too', async () => {
      repoThatRunsItsOwnSettings(home);
      const sub = path.join(home, 'src');
      fs.mkdirSync(sub, { recursive: true });
      registerTestHomes([home]);
      await expect(getGitStatus(sub)).resolves.toEqual({ error: 'not_git_repo' });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('the carry-over summary reads nothing', async () => {
      repoThatRunsItsOwnSettings(home);
      registerTestHomes([home]);
      await expect(runGitForSummary(home, ['status', '--short'])).resolves.toBeUndefined();
      await expect(runGitForSummary(home, ['diff', '--stat'])).resolves.toBeUndefined();
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('the diff has no HEAD baseline', async () => {
      repoThatRunsItsOwnSettings(home);
      registerTestHomes([home]);
      await expect(gitShowHead(home, path.join(home, 'a.txt'))).resolves.toBeNull();
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('the heartbeat workspace gatherer finds nothing and runs neither git nor gh', async () => {
      repoThatRunsItsOwnSettings(home);
      registerTestHomes([home]);
      const changes = await createWorkspaceGatherer()({
        agent: { id: 'ana', name: 'Ana', projectPath: home, cwd: home },
        since: new Date(0).toISOString(),
        now: new Date(),
        signal: new AbortController().signal,
        ownBeatSessions: new Set(),
      });
      expect(changes).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('the gatherer never starts a command at all', async () => {
      registerTestHomes([home]);
      const run = vi.fn(async () => '');
      await createWorkspaceGatherer(run)({
        agent: { id: 'ana', name: 'Ana', projectPath: home, cwd: home },
        since: null,
        now: new Date(),
        signal: new AbortController().signal,
        ownBeatSessions: new Set(),
      });
      expect(run).not.toHaveBeenCalled();
    });
  });

  it('refuses a worktree whose git folder lives in an agent home', () => {
    const home = path.join(scratch, 'agents', 'bo');
    fs.mkdirSync(home, { recursive: true });
    git(home, 'init', '-q', '-b', 'main');
    commit(home, 'one', '--allow-empty');
    const tree = path.join(scratch, 'elsewhere', 'bo-tree');
    git(home, 'worktree', 'add', '-q', '-b', 'side', tree);
    registerTestHomes([home]);
    expect(mayRunGitHere(tree)).toBe(false);
    expect(mayRunGitHere(path.join(tree, 'sub'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')(
    'refuses an agent home spelled in other case on a case-blind disk',
    async () => {
      const home = path.join(scratch, 'agents', 'dee');
      repoThatRunsItsOwnSettings(home);
      registerTestHomes([home]);
      const shouted = path.join(scratch, 'AGENTS', 'DEE');
      expect(mayRunGitHere(shouted)).toBe(false);
      await expect(getGitStatus(shouted)).resolves.toEqual({ error: 'not_git_repo' });
      expect(fs.existsSync(marker)).toBe(false);
    }
  );

  it('refuses a folder whose .git file cannot be read as a pointer', () => {
    const dir = path.join(scratch, 'odd');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'not a pointer\n');
    registerTestHomes([]);
    expect(mayRunGitHere(dir)).toBe(false);
  });

  it('refuses the rooms directory, the workspace root and the data directory', () => {
    const rooms = path.join(scratch, 'dork', 'rooms');
    const workspaces = path.join(scratch, 'custom-workspaces');
    registerTestHomes([], { roomsDir: rooms });
    setGitGuardRoots(() => [workspaces]);
    expect(mayRunGitHere(path.join(rooms, 'r1', 'repo'))).toBe(false);
    expect(mayRunGitHere(path.join(workspaces, 'w1'))).toBe(false);
    vi.stubEnv('DORK_HOME', path.join(scratch, 'dork-home'));
    try {
      expect(mayRunGitHere(path.join(scratch, 'dork-home', 'agents', 'x'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a managed workspace an agent owns, wherever it is', () => {
    const home = path.join(scratch, 'agents', 'cy');
    const checkout = path.join(scratch, 'checkouts', 'cy-1');
    fs.mkdirSync(checkout, { recursive: true });
    registerTestHomes([home], { managed: { [checkout]: home } });
    expect(mayRunGitHere(checkout)).toBe(false);
  });

  it('refuses a worktree with an empty .git folder planted inside it', async () => {
    const home = repoThatRunsItsOwnSettings(path.join(scratch, 'agents', 'eve'));
    git(home, 'add', '.');
    commit(home, 'two');
    const tree = path.join(scratch, 'elsewhere', 'eve-tree');
    fs.rmSync(tree, { recursive: true, force: true });
    git(home, 'worktree', 'add', '-q', '-b', 'eve-side', tree);
    fs.writeFileSync(path.join(tree, 'a.txt'), 'three\n');
    const sub = path.join(tree, 'sub');
    fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
    registerTestHomes([home]);
    fs.rmSync(marker, { force: true });
    expect(mayRunGitHere(sub)).toBe(false);
    await expect(getGitStatus(sub)).resolves.toEqual({ error: 'not_git_repo' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses a home that was registered in other case', () => {
    if (process.platform !== 'darwin') return;
    const home = path.join(scratch, 'agents', 'fay');
    fs.mkdirSync(home, { recursive: true });
    registerTestHomes([path.join(scratch, 'AGENTS', 'FAY')]);
    expect(mayRunGitHere(home)).toBe(false);
  });

  it('refuses every folder while the agent list is not up yet', async () => {
    const project = repoThatRunsItsOwnSettings(path.join(scratch, 'project-early'));
    setAgentHomeRegistry({
      isRegisteredHome: () => false,
      listRegisteredHomes: () => [],
      managedWorkspaceOwner: () => null,
      roomsDir: null,
      homesKnown: () => false,
    });
    expect(mayRunGitHere(project)).toBe(false);
    await expect(getGitStatus(project)).resolves.toEqual({ error: 'not_git_repo' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the workspaces scan lists an agent checkout without running git in it', async () => {
    const root = path.join(scratch, 'ws-root');
    const checkout = repoThatRunsItsOwnSettings(path.join(root, 'proj', 'one'));
    registerTestHomes([]);
    setGitGuardRoots(() => [root]);
    const result = await scanWorktrees(root);
    expect(result.worktrees).toEqual([
      expect.objectContaining({ path: checkout, readable: false, branch: null }),
    ]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the file list in an agent home is read from disk, not git', async () => {
    const home = repoThatRunsItsOwnSettings(path.join(scratch, 'agents', 'gus'));
    registerTestHomes([home]);
    const listed = await fileLister.listFiles(home);
    expect(listed.files).toContain('a.txt');
    const tree = await fileLister.listTree(home, home, 1, false);
    expect(tree.map((entry) => entry.name)).toContain('a.txt');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses a main checkout that has a worktree under the workspace root', async () => {
    const main = repoThatRunsItsOwnSettings(path.join(scratch, 'main-checkout'));
    git(main, 'add', '.');
    commit(main, 'two');
    fs.writeFileSync(path.join(main, 'a.txt'), 'three\n');
    const root = path.join(scratch, 'ws-shared');
    const tree = path.join(root, 'proj', 'agent-tree');
    fs.rmSync(root, { recursive: true, force: true });
    git(main, 'worktree', 'add', '-q', '-b', 'agent-side', tree);
    registerTestHomes([]);
    setGitGuardRoots(() => [root]);
    fs.rmSync(marker, { force: true });
    expect(mayRunGitHere(main)).toBe(false);
    expect(mayRunGitHere(path.join(main, 'sub'))).toBe(false);
    await expect(getGitStatus(main)).resolves.toEqual({ error: 'not_git_repo' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('audits a repository before the heartbeat runs gh in it', async () => {
    const project = repoThatRunsItsOwnSettings(path.join(scratch, 'gh-project'));
    fs.rmSync(`${marker}.gh`, { force: true });
    await expect(
      runCommand('gh', ['pr', 'checks'], { cwd: project, signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
    expect(fs.existsSync(`${marker}.gh`)).toBe(false);
  });
});
