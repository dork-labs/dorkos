/**
 * "Is this manifest tracked?" never depends on how git words its error.
 *
 * A folder with no `.git` above it is answered from disk, before git runs. Git
 * says "not a git repository (or any of the parent directories)" on one machine
 * and "(or any parent up to mount point /tmp)" on another (a CI runner whose
 * temp folder is its own file system), and only the first matched the old
 * check, so the second warned on every unregister. Here git is a stand-in that
 * fails with each wording: the answer is the same, quiet `false`, and the
 * stand-in never even runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const git = vi.hoisted(() => ({ stderr: '', calls: 0 }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      git.calls += 1;
      const done = args[args.length - 1] as (err: Error) => void;
      done(Object.assign(new Error('git failed'), { code: 128, stderr: git.stderr }));
    },
  };
});

const { isManifestGitTracked } = await import('../git-tracked.js');

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  git.calls = 0;
});

async function folderInNoRepository(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-wording-')));
  dirs.push(dir);
  return dir;
}

describe('isManifestGitTracked in a folder no repository holds', () => {
  it.each([
    'fatal: not a git repository (or any of the parent directories): .git',
    'fatal: not a git repository (or any parent up to mount point /tmp)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).',
  ])('answers untracked, quietly, whatever git would say: %s', async (wording) => {
    git.stderr = wording;
    const warn = vi.fn();
    expect(await isManifestGitTracked(await folderInNoRepository(), { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(git.calls).toBe(0);
  });

  it('answers untracked, quietly, for a folder that is gone', async () => {
    const warn = vi.fn();
    const gone = path.join(await folderInNoRepository(), 'gone');
    expect(await isManifestGitTracked(gone, { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(git.calls).toBe(0);
  });
});
