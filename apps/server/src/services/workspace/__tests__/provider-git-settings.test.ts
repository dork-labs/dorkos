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
import { runGit, UnsafeWorkspaceSourceError } from '../providers/git.js';
import { GitRepoConfigUnsafeError } from '@dorkos/shared/safe-git';
import { WorktreeProvider } from '../providers/worktree.js';
import { fullChatOf } from '../index.js';
import {
  noteChosenTurn,
  resetChosenTurns,
  setMarkedFullActivity,
} from '../../core/turn-power/full-autonomy.js';

/** Every git the code under test starts, counted by a pass-through mock. */
const gitRuns = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const counted = ((...args: Parameters<typeof actual.execFile>) => {
    gitRuns.count += 1;
    return actual.execFile(...args);
  }) as typeof actual.execFile;
  // Keep execFile's own promisified form, which resolves `{ stdout, stderr }`.
  const promised = promisify(actual.execFile);
  Object.defineProperty(counted, promisify.custom, {
    value: (...args: unknown[]) => {
      gitRuns.count += 1;
      return (promised as (...a: unknown[]) => unknown)(...args);
    },
  });
  return { ...actual, execFile: counted };
});

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
    // A person asked: their hooks run (DOR-2335 keeps them off for anyone else).
    await new WorktreeProvider(root).create({ ...request(source, 'wt'), personGit: true });
    expect(existsSync(marker)).toBe(true);
  });

  it('runs no hook for a worktree anyone else asked for (DOR-2335)', async () => {
    installHook(path.join(source, '.git'));
    await new WorktreeProvider(root).create(request(source, 'wt'));
    expect(existsSync(marker)).toBe(false);
  });

  it('runs post-checkout for a clone workspace', async () => {
    // A clone's hooks come from the person's git template, never its source.
    const template = path.join(base, 'template');
    installHook(template);
    vi.stubEnv('GIT_TEMPLATE_DIR', template);
    try {
      await new CloneProvider(root).create({ ...request(source, 'cl'), personGit: true });
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

// A caller-supplied source must never become a git option or a transport
// helper that runs a program (DOR-2326). Both are refused before git runs.
describe('a workspace source git could misread', () => {
  it.each([
    ['a source starting with -', (m: string) => `--upload-pack=touch '${m}'`],
    ['an ext:: source', (m: string) => `ext::sh -c touch% '${m}'`],
    ['an fd:: source', () => 'fd::3'],
  ])('refuses %s before git runs', async (_label, make) => {
    gitRuns.count = 0;
    const source = make(marker);
    for (const provider of [new CloneProvider(root), new WorktreeProvider(root)]) {
      await expect(provider.create(request(source, 'bad'))).rejects.toBeInstanceOf(
        UnsafeWorkspaceSourceError
      );
    }
    expect(gitRuns.count).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('confines git to transports that run no program, even past the check', async () => {
    // Purpose: the transport allowlist stands behind the check, even for a
    // person whose own git config allows ext:: (GIT_ALLOW_PROTOCOL wins).
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.ext.allow');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'always');
    try {
      await expect(
        runGit(['ls-remote', '--end-of-options', `ext::sh -c touch% ${marker}`], base)
      ).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('still clones a local folder and an ordinary path', async () => {
    const req = request(source, 'ok');
    await new CloneProvider(root).create(req);
    expect(existsSync(path.join(req.path, '.git'))).toBe(true);
  });
});

// The source shares its settings with every agent worktree made from it, so a
// program they name must not run when a workspace is made or removed (DOR-3343).
describe.skipIf(process.platform === 'win32')('a source whose settings name a program', () => {
  /** A smudge filter on every file in the source, writing the marker when it runs. */
  function plantSmudge(): void {
    writeFileSync(path.join(source, '.gitattributes'), '* filter=mark\n');
    writeFileSync(path.join(source, 'a.txt'), 'a\n');
    git(['add', '.'], source);
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'a'], source);
    const filter = path.join(base, 'smudge.sh');
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    git(['config', 'filter.mark.smudge', filter], source);
  }

  it('fires under plain git, so the refusals below mean something', () => {
    plantSmudge();
    git(['worktree', 'add', '-q', '-b', 'plain', path.join(base, 'plain-tree')], source);
    expect(existsSync(marker)).toBe(true);
  });

  it.each([
    ['anyone', false],
    ['a person', true],
  ])('refuses a worktree workspace %s asks for, and runs nothing', async (_who, personGit) => {
    plantSmudge();
    await expect(
      new WorktreeProvider(root).create({ ...request(source, 'wt'), personGit })
    ).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(root, 'wt'))).toBe(false);
  });

  it('refuses to remove a worktree whose source has since gained one', async () => {
    const provider = new WorktreeProvider(root);
    const req = request(source, 'later');
    await provider.create(req);
    plantSmudge();
    await expect(
      provider.remove({ path: req.path, source } as Parameters<WorktreeProvider['remove']>[0], {
        force: false,
      })
    ).rejects.toBeInstanceOf(GitRepoConfigUnsafeError);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a clone of it', async () => {
    plantSmudge();
    await expect(new CloneProvider(root).create(request(source, 'cl'))).rejects.toBeInstanceOf(
      GitRepoConfigUnsafeError
    );
    expect(existsSync(marker)).toBe(false);
  });

  describe('asked for by a chat set to Full autonomy', () => {
    const FULL_CHAT = { sessionId: 'chat-full', agentPath: '/agents/scout' };
    const emit = vi.fn(async () => {});

    beforeEach(() => {
      emit.mockClear();
      setMarkedFullActivity({ emit });
    });
    afterEach(() => {
      setMarkedFullActivity(undefined);
      resetChosenTurns();
    });

    it('makes the worktree anyway, runs none of its filters, and writes one Activity line', async () => {
      plantSmudge();
      const req = { ...request(source, 'wt'), fullChat: FULL_CHAT };
      await new WorktreeProvider(root).create(req);
      expect(existsSync(path.join(req.path, '.git'))).toBe(true);
      // The planted smudge filter did not run on DorkOS's own checkout.
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(path.join(req.path, 'a.txt'))).toBe(true);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'agent.full_action',
          actorId: FULL_CHAT.agentPath,
          resourceId: 'workspace.create',
        })
      );
    });

    it('makes the clone anyway, and writes one Activity line', async () => {
      plantSmudge();
      const req = { ...request(source, 'cl'), fullChat: FULL_CHAT };
      await new CloneProvider(root).create(req);
      expect(existsSync(path.join(req.path, '.git'))).toBe(true);
      expect(emit).toHaveBeenCalledOnce();
    });

    it('writes nothing when the settings pass', async () => {
      await new WorktreeProvider(root).create({ ...request(source, 'ok'), fullChat: FULL_CHAT });
      expect(emit).not.toHaveBeenCalled();
    });

    it('names a Full chat only when its latest turn ran at Full', () => {
      expect(fullChatOf('chat-a')).toBeUndefined();
      noteChosenTurn('chat-a', { asks: 'never', reach: 'everything' }, false);
      expect(fullChatOf('chat-a', '/agents/scout')).toEqual({
        sessionId: 'chat-a',
        agentPath: '/agents/scout',
      });
      noteChosenTurn('chat-a', { asks: 'never', reach: 'workspace' }, false);
      expect(fullChatOf('chat-a')).toBeUndefined();
      expect(fullChatOf(undefined)).toBeUndefined();
    });
  });
});
