/**
 * The server's own git in a room repo runs no program the repo's config names
 * through a fetch (DOR-3667). An agent that can write `repo/.git/config` could
 * set a promisor remote with `extensions.partialClone` and its own
 * `remote.<name>.uploadpack`; then even a read like `git cat-file` of a missing
 * object lazy-fetches and runs that program as the server.
 *
 * Fixtures write config only. The "program" is a harmless marker script that
 * records it ran.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitEnv, initRepo, runGit } from '../room-repo-git.js';
import { removeFixtureTree } from './fixture-git.js';

let home: string;
let repo: string;
let marker: string;
let program: string;

/** Plain git, as an agent's shell would run it, with no host config. */
function plainGit(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', ...args], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' },
  });
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'room-lazy-fetch-')));
  repo = path.join(home, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, home);
  await writeFile(path.join(repo, 'README.md'), 'hi\n');
  plainGit(repo, 'add', '-A');
  plainGit(repo, 'commit', '-q', '-m', 'first');
  marker = path.join(home, 'ran');
  program = path.join(home, 'upload-pack.sh');
  await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`, { mode: 0o755 });
});

afterEach(async () => {
  await removeFixtureTree(home);
});

/** Arm the room repo the way an agent's shell could: config only. */
function armPromisor(): void {
  plainGit(repo, 'remote', 'add', 'origin', `file://${home}/elsewhere`);
  plainGit(repo, 'config', 'remote.origin.promisor', 'true');
  plainGit(repo, 'config', 'remote.origin.uploadpack', program);
  plainGit(repo, 'config', 'extensions.partialClone', 'origin');
}

describe('room git and a repo config that would lazy-fetch (DOR-3667)', () => {
  it('refuses to run, and runs nothing, when the config names a promisor remote', async () => {
    armPromisor();
    const missing = '1'.repeat(40);

    await expect(runGit(['cat-file', '-e', missing], repo, home)).rejects.toMatchObject({
      code: 'ROOM_REPO_CONFIG_UNSAFE',
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('allows only the keys a room repo really carries', async () => {
    // A fresh room repo plus a plain remote and a branch is fine.
    plainGit(repo, 'remote', 'add', 'origin', `${home}/elsewhere`);
    plainGit(repo, 'config', 'branch.main.remote', 'origin');
    await expect(runGit(['rev-parse', 'HEAD'], repo, home)).resolves.toMatch(/^[0-9a-f]{40}$/);

    // A key outside the allowlist, even one that names no program, refuses.
    plainGit(repo, 'config', 'core.ignoreStat', 'true');
    await expect(runGit(['rev-parse', 'HEAD'], repo, home)).rejects.toMatchObject({
      code: 'ROOM_REPO_CONFIG_UNSAFE',
    });
  });

  it('runs every room git command with no lazy fetch and no transport at all', () => {
    const env = gitEnv(home, repo);
    expect(env.GIT_NO_LAZY_FETCH).toBe('1');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('');
  });

  it('runs nothing even past the audit: the environment alone stops the lazy fetch', () => {
    // As the server's git would run in this room, with the audit out of the way:
    // the environment the runner gives every command must stop the fetch itself.
    armPromisor();
    const env = gitEnv(home, repo);
    try {
      execFileSync('git', ['cat-file', '-e', '1'.repeat(40)], { cwd: repo, env, stdio: 'pipe' });
    } catch {
      // A missing object is an error either way; what matters is the marker.
    }
    expect(existsSync(marker)).toBe(false);
  });
});
