/**
 * Registration never overwrites a manifest a directory already holds, and
 * unregistration never deletes one that git is tracking (DOR-1019).
 *
 * The incident: a verification run pointed `POST /api/mesh/agents` at a repo
 * checkout, which minted a second identity and wrote it straight over that
 * repo's committed `.dork/agent.json`; unregistering afterwards deleted the
 * file outright. Both writes are immediate — mesh registration is file-first
 * (ADR-0043) — so the only reason the manifest survived was that a person
 * noticed it in `git status` and restored it from HEAD.
 *
 * Driven through the real `MeshCore` over real temp directories, and over a
 * real `git init`ed repo for the tracked-file half: the question is what the
 * bytes on disk say afterwards, which no mock can answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Logger } from '@dorkos/shared/logger';
import { MeshCore } from '../mesh-core.js';
import { isManifestGitTracked } from '../git-tracked.js';
import { writeManifest, MANIFEST_DIR, MANIFEST_FILE } from '../manifest.js';

const tempDirs: string[] = [];

/** A temp directory, realpath-resolved (macOS `/var` is a symlink to `/private/var`). */
async function makeTempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-clobber-')));
  tempDirs.push(dir);
  return dir;
}

let db: Db;

beforeEach(() => {
  tempDirs.length = 0;
  db = createTestDb();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeManifest(overrides: Partial<AgentManifest> & { id: string }): AgentManifest {
  return {
    workspace: { mode: 'home' },
    name: 'ana',
    description: 'the agent this directory already had',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-10T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  };
}

/** A logger that swallows everything, so guard warnings do not spam the run. */
function quietLogger(): Logger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

/** The manifest file inside `dir`. */
function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_DIR, MANIFEST_FILE);
}

/** Read the manifest file's exact bytes, or `null` when it is gone. */
async function manifestBytes(dir: string): Promise<string | null> {
  return fs.readFile(manifestPath(dir), 'utf-8').catch(() => null);
}

/** Run git in `cwd` with an identity of its own, so the test never reads the user's. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  });
}

/** A git repo with one commit, so `git ls-files` has an index to answer from. */
function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
}

describe('registration adopts rather than overwrites', () => {
  it('adopts the manifest a directory already carries, leaving the file untouched', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await writeManifest(
      repo,
      makeManifest({ id: '01ANA0000000000000000000A', displayName: 'Ana' })
    );
    const before = await manifestBytes(repo);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const registered = await mesh.registerByPath(repo, {
      name: 'verification-agent',
      runtime: 'codex',
    });

    // The identity on disk wins: no second id, and the caller's overrides never
    // reach the file.
    expect(registered.id).toBe('01ANA0000000000000000000A');
    expect(registered.name).toBe('ana');
    expect(await manifestBytes(repo)).toBe(before);

    // ADR-0043: the DB row still has to exist, keyed to the adopted identity.
    expect(mesh.get('01ANA0000000000000000000A')?.name).toBe('ana');
    expect(mesh.listWithPaths()).toHaveLength(1);

    mesh.close();
  });

  it('refuses a directory whose manifest is present but unreadable, naming the file', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'repo');
    await fs.mkdir(path.join(repo, MANIFEST_DIR), { recursive: true });
    await fs.writeFile(manifestPath(repo), '{ this is not json', 'utf-8');
    const before = await manifestBytes(repo);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    await expect(
      mesh.registerByPath(repo, { name: 'verification-agent', runtime: 'claude-code' })
    ).rejects.toThrow(manifestPath(repo));

    expect(await manifestBytes(repo)).toBe(before);
    expect(mesh.listWithPaths()).toHaveLength(0);

    mesh.close();
  });

  it('still mints a fresh identity for a directory with no manifest', async () => {
    const base = await makeTempDir();
    const fresh = path.join(base, 'fresh');
    await fs.mkdir(fresh, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const registered = await mesh.registerByPath(fresh, { name: 'fresh', runtime: 'claude-code' });

    expect(registered.name).toBe('fresh');
    expect(await manifestBytes(fresh)).toContain(registered.id);

    mesh.close();
  });
});

describe('unregistration never deletes a git-tracked manifest', () => {
  it('leaves a tracked manifest on disk and stops the scan from re-adopting it', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeManifest(repo, makeManifest({ id: '01ANA0000000000000000000A' }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'track the agent manifest');
    const before = await manifestBytes(repo);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const agent = await mesh.registerByPath(repo, { name: 'ana', runtime: 'claude-code' });

    await mesh.unregister(agent.id);

    // The repo's own file survives, byte for byte.
    expect(await manifestBytes(repo)).toBe(before);
    // The registry row does not.
    expect(mesh.get(agent.id)).toBeUndefined();
    // And the file left behind must not walk back in on the next scan.
    expect(mesh.listDenied().map((d) => d.path)).toContain(repo);

    mesh.close();
  });

  it('deletes an untracked manifest inside a git repo, exactly as before', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeManifest(repo, makeManifest({ id: '01ANA0000000000000000000B' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const agent = await mesh.registerByPath(repo, { name: 'ana', runtime: 'claude-code' });

    await mesh.unregister(agent.id);

    expect(await manifestBytes(repo)).toBeNull();
    expect(mesh.listDenied()).toHaveLength(0);

    mesh.close();
  });

  it('deletes a manifest that is in no repo at all, exactly as before', async () => {
    const base = await makeTempDir();
    const plain = path.join(base, 'plain');
    await fs.mkdir(plain, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const agent = await mesh.registerByPath(plain, { name: 'plain', runtime: 'claude-code' });

    await mesh.unregister(agent.id);

    expect(await manifestBytes(plain)).toBeNull();
    expect(mesh.listDenied()).toHaveLength(0);

    mesh.close();
  });

  it('keeps the manifest when git cannot answer but a working tree is there', async () => {
    // A `.git` FILE that points nowhere — the shape a linked worktree or a
    // submodule has, here with a broken target so git exits 128 instead of
    // answering. Not knowing must not mean deleting.
    const base = await makeTempDir();
    const repo = path.join(base, 'worktree');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, '.git'), 'gitdir: /nowhere/at/all\n', 'utf-8');
    await writeManifest(repo, makeManifest({ id: '01ANA0000000000000000000D' }));

    const warn = vi.fn();
    expect(await isManifestGitTracked(repo, { warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says untracked, quietly, for a directory that is no longer there', async () => {
    const base = await makeTempDir();
    const warn = vi.fn();

    expect(await isManifestGitTracked(path.join(base, 'gone'), { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('clears the denial when the same directory is registered again', async () => {
    const base = await makeTempDir();
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo, { recursive: true });
    initRepo(repo);
    await writeManifest(repo, makeManifest({ id: '01ANA0000000000000000000C' }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'track the agent manifest');

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const agent = await mesh.registerByPath(repo, { name: 'ana', runtime: 'claude-code' });
    await mesh.unregister(agent.id);
    expect(mesh.listDenied()).toHaveLength(1);

    const readopted = await mesh.registerByPath(repo, { name: 'ana', runtime: 'claude-code' });

    expect(readopted.id).toBe('01ANA0000000000000000000C');
    expect(mesh.listDenied()).toHaveLength(0);

    mesh.close();
  });
});
