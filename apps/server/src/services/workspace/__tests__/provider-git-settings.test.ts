/**
 * Creating a workspace changes a person's own repository on their behalf, so
 * it must behave as their own git would (DOR-2326): their `post-checkout` hook
 * runs, and a bare source still works although safe.bareRepository=explicit
 * refuses a bare repository git only finds by where it runs. Reads keep the
 * full hardening, which runs no hook.
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBoundary } from '../../../lib/boundary.js';
import { CloneProvider } from '../providers/clone.js';
import { runGit } from '../providers/git.js';
import { WorktreeProvider } from '../providers/worktree.js';

let base: string;
let root: string;
let source: string;
let marker: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** A `post-checkout` hook in `gitDir` that records that it ran. */
function installHook(gitDir: string): void {
  const hooks = path.join(gitDir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);
}

const request = (source: string, name: string) => ({
  projectKey: 'p',
  key: name,
  path: path.join(root, name),
  source,
  branch: `ws/${name}`,
});

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ws-git-settings-')));
  root = path.join(base, 'workspaces');
  source = path.join(base, 'source');
  marker = path.join(base, 'HOOK-RAN');
  mkdirSync(root);
  git(['init', '-q', '-b', 'main', source], base);
  git(
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    source
  );
  await initBoundary(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// The hook scripts are POSIX shell.
describe.skipIf(process.platform === 'win32')('workspace creation keeps the person’s hooks', () => {
  it('runs post-checkout for a worktree workspace', async () => {
    installHook(path.join(source, '.git'));
    await new WorktreeProvider(root).create(request(source, 'wt'));
    expect(existsSync(marker)).toBe(true);
  });

  it('runs post-checkout for a clone workspace', async () => {
    // A clone's hooks come from the person's git template, never its source.
    const template = path.join(base, 'template');
    installHook(template);
    vi.stubEnv('GIT_TEMPLATE_DIR', template);
    try {
      await new CloneProvider(root).create(request(source, 'cl'));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(existsSync(marker)).toBe(true);
  });

  it('does not run hooks for a read', async () => {
    installHook(path.join(source, '.git'));
    await runGit(['checkout', '-q', '-b', 'read-path'], source);
    expect(existsSync(marker)).toBe(false);
  });

  it('creates and removes a worktree workspace from a bare source', async () => {
    const bare = path.join(base, 'bare.git');
    git(['clone', '-q', '--bare', source, bare], base);
    const provider = new WorktreeProvider(root);
    const req = request(bare, 'from-bare');
    await provider.create(req);
    expect(existsSync(path.join(req.path, '.git'))).toBe(true);
    await provider.remove(
      { path: req.path, source: bare } as Parameters<WorktreeProvider['remove']>[0],
      { force: true }
    );
    expect(existsSync(req.path)).toBe(false);
  });
});
