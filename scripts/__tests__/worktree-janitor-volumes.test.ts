/**
 * Pins the missing-disk guard in scripts/worktree-janitor.sh.
 *
 * Worktrees can live on an external disk under /Volumes/<name>/. Unplug it and
 * git sees each of them as a worktree whose directory is gone, so a plain
 * `git worktree prune` deletes their records. The janitor runs every night from
 * a LaunchAgent, so the guard has to hold on its own: while a registered
 * worktree on a /Volumes disk is missing, --fix skips the prune, never judges
 * that worktree or its branch, and still reaps worktrees on disks that are there.
 *
 * Hermetic: a throwaway repo and bare origin in a temp dir, and a fake `gh` that
 * reports no pull requests. A worktree "on" a missing disk is a real worktree
 * whose admin record is pointed at a /Volumes path that cannot exist, which is
 * exactly what git sees after an unplug. Never touches this repo's worktrees.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const JANITOR = join(import.meta.dirname, '..', 'worktree-janitor.sh');
const MISSING_VOL = `/Volumes/dorkos-janitor-test-missing-${process.pid}`;

let tmp: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
}

/** A fresh repo with one commit on main, pushed to a bare origin. */
function newRepo(name: string): string {
  const repo = join(tmp, name);
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', `${repo}-origin.git`], { env });
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo], { env });
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'init'
  );
  git(repo, 'remote', 'add', 'origin', `${repo}-origin.git`);
  git(repo, 'push', '--quiet', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return repo;
}

/**
 * Register a worktree, then point its admin record at `path` and delete the
 * directory, as if it had moved there and the disk then vanished.
 */
function phantomWorktree(repo: string, id: string, path: string, branch?: string): string {
  const real = join(tmp, `${id}-real`);
  const args = branch ? ['-b', branch, real, 'main'] : ['--detach', real, 'main'];
  git(repo, 'worktree', 'add', '--quiet', ...args);
  const admin = join(repo, '.git', 'worktrees', `${id}-real`);
  writeFileSync(join(admin, 'gitdir'), `${path}/.git\n`);
  rmSync(real, { recursive: true, force: true });
  return admin;
}

/** A clean detached worktree at main on the temp disk: reapable by rule 2. */
function reapableWorktree(repo: string, id: string): string {
  const path = join(tmp, id);
  git(repo, 'worktree', 'add', '--quiet', '--detach', path, 'main');
  return path;
}

function runFix(repo: string): string {
  const r = spawnSync('bash', [JANITOR, '--fix'], { cwd: repo, env, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'janitor-volumes-')));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\necho "[]"\n', { mode: 0o755 });
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    DORK_HOME: join(tmp, 'dork-home'),
    // Every fixture worktree is brand new; without this none is ever a candidate.
    DORKOS_JANITOR_IDLE_HOURS: '0',
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('worktree-janitor.sh with a worktree on a missing disk', () => {
  it('skips the prune, keeps the record, and logs one ALERT naming the disk', () => {
    expect(existsSync(MISSING_VOL)).toBe(false);
    const repo = newRepo('ext');
    const admin = phantomWorktree(repo, 'ext-a', `${MISSING_VOL}/dorkos-wt/ext-a`);

    const out = runFix(repo);

    expect(existsSync(admin)).toBe(true);
    const alerts = out
      .split('\n')
      .filter((l) => l.includes(`ALERT: ${MISSING_VOL} is not mounted`));
    expect(alerts).toHaveLength(1);
    // The daily wrapper keeps only lines matching removed|ERROR|error.
    expect(alerts[0]).toMatch(/removed|ERROR|error/);
    expect(out).toContain('git worktree prune skipped');
  });

  it('never reaps the worktree or its branch, even when the gate would', () => {
    const repo = newRepo('branch');
    // At main's tip, not on origin, no PR: rule 2 reaps this branch if it is judged.
    phantomWorktree(repo, 'ext-b', `${MISSING_VOL}/dorkos-wt/ext-b`, 'ext-work');

    const out = runFix(repo);

    expect(git(repo, 'branch', '--list', 'ext-work').trim()).not.toBe('');
    expect(out).not.toContain('ext-work');
  });

  it('still reaps worktrees on disks that are present', () => {
    const repo = newRepo('mixed');
    const extAdmin = phantomWorktree(repo, 'ext-c', `${MISSING_VOL}/dorkos-wt/ext-c`);
    const internalAdmin = phantomWorktree(repo, 'gone-d', join(tmp, 'gone', 'gone-d'));
    const live = reapableWorktree(repo, 'live-e');

    const out = runFix(repo);

    expect(existsSync(live), out).toBe(false);
    expect(out).toContain('removed 1, failed 0');
    // Prune is all or nothing, so the vanished internal one waits too.
    expect(existsSync(extAdmin)).toBe(true);
    expect(existsSync(internalAdmin)).toBe(true);
  });
});

describe('worktree-janitor.sh with every disk present', () => {
  it('prunes a vanished internal-disk worktree as before, with no ALERT', () => {
    const repo = newRepo('int');
    const admin = phantomWorktree(repo, 'int-a', join(tmp, 'gone', 'int-a'));

    const out = runFix(repo);

    expect(existsSync(admin), out).toBe(false);
    expect(out).not.toContain('ALERT');
    expect(out).not.toContain('prune skipped');
  });
});
