/**
 * `git status` never runs inside a room's files (spec `agent-home-desk` I3).
 * Real git, a real clean filter: the claim is that no program the room's shared
 * settings name runs. Seeded: dropping the rooms-dir check in `getGitStatus`
 * reddens the first case (the filter writes its marker).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitStatus } from '../git-status.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../agent-identity/__tests__/agent-home-fixture.js';

vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  BoundaryError: class BoundaryError extends Error {},
}));

describe('getGitStatus in a room`s files', () => {
  let scratch: string;
  let roomsDir: string;
  let marker: string;

  /** A repository whose shared config names a clean filter that leaves a marker. */
  function repoWithFilter(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    const script = path.join(scratch, 'filter.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
    git('config', 'filter.evil.clean', script);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  }

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-rooms-')));
    roomsDir = path.join(scratch, 'dork', 'rooms');
    marker = path.join(scratch, 'ran');
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  afterEach(() => {
    clearTestHomes();
    fs.rmSync(marker, { force: true });
  });

  it('answers "not a repository" and runs nothing the room`s settings name', async () => {
    const repo = path.join(roomsDir, 'r1', 'repo');
    repoWithFilter(repo);
    registerTestHomes([], { roomsDir });

    await expect(getGitStatus(repo)).resolves.toEqual({ error: 'not_git_repo' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('still reads a repository outside the rooms directory', async () => {
    const repo = path.join(scratch, 'project');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    registerTestHomes([], { roomsDir });

    await expect(getGitStatus(repo)).resolves.toMatchObject({ untracked: 0 });
  });
});
