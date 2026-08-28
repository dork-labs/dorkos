/**
 * Acceptance tests for the WorkspaceManager — the three DOR-84 validation
 * criteria, exercised end-to-end against a REAL temp git repo (bare origin +
 * working clone) and an in-memory DB. These are the criteria the spec promised:
 *   VC#1 — distinct units of work get isolated, collision-free workspaces.
 *   VC#2 — a workspace survives/reuses across attempts for the same key.
 *   VC#3 — cleanup refuses to remove a dirty workspace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { derivePorts, type AttachedSession } from '@dorkos/shared/workspace';
import { createWorkspaceSubsystem, type WorkspaceSubsystem } from '../index.js';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('WorkspaceService — DOR-84 acceptance', () => {
  let db: Db;
  let base: string;
  let root: string;
  let source: string;
  let sub: WorkspaceSubsystem;

  beforeEach(async () => {
    db = createTestDb();
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-accept-')));
    root = path.join(base, 'workspaces');
    source = path.join(base, 'source');
    const origin = path.join(base, 'origin.git');

    // Bare origin + working clone with a pushed `main`, so a fresh worktree reads
    // as clean (its commits are reachable from a remote).
    git(['init', '--bare', '-b', 'main', origin], base);
    await mkdir(source, { recursive: true });
    git(['clone', origin, source], base);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), '# source\n');
    // Real repos gitignore `.env` (it's why .gtrconfig *copies* it into worktrees),
    // so the manager's allocated-port `.env` never trips dirty-detection.
    await writeFile(path.join(source, '.gitignore'), '.env\n');
    git(['add', '.'], source);
    git(['commit', '-m', 'init'], source);
    git(['push', '-u', 'origin', 'main'], source);

    sub = createWorkspaceSubsystem({
      db,
      dorkHome: base,
      config: {
        enabled: true,
        rootPath: root,
        portBase: 4250,
        portBlockSize: 10,
        defaultProvider: 'worktree',
        retentionCap: null,
      },
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('VC#1: distinct keys get isolated paths and disjoint port blocks', async () => {
    const a = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    const b = await sub.service.ensure({ projectKey: 'core', key: 'DOR-2', source });

    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    expect(a.path).not.toBe(b.path);

    // Disjoint blocks → no shared port across the two workspaces.
    expect(Math.abs(a.portBase - b.portBase)).toBeGreaterThanOrEqual(10);
    const aPorts = new Set(Object.values(derivePorts(a.portBase)));
    const bPorts = Object.values(derivePorts(b.portBase));
    expect(bPorts.some((p) => aPorts.has(p))).toBe(false);
  });

  it('VC#2: ensuring the same key twice reuses the same workspace', async () => {
    const first = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    const again = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });

    expect(again.id).toBe(first.id);
    expect(again.path).toBe(first.path);
    expect(again.portBase).toBe(first.portBase);
  });

  it('VC#3: remove refuses a dirty workspace unless forced', async () => {
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });

    // A fresh, untouched workspace is clean and removable.
    // Now make it dirty with an untracked file.
    await writeFile(path.join(ws.path, 'scratch.txt'), 'uncommitted work\n');

    const blocked = await sub.service.remove(ws.id, { force: false });
    expect(blocked.removed).toBe(false);
    expect(blocked.blocked).toBe('dirty');
    expect(blocked.dirty?.untracked).toContain('scratch.txt');

    const forced = await sub.service.remove(ws.id, { force: true });
    expect(forced.removed).toBe(true);
    expect(await sub.service.get(ws.id)).toBeNull();
  });

  it('resolveByPath maps a nested session cwd back to its workspace', async () => {
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    const resolved = await sub.service.resolveByPath(path.join(ws.path, 'apps', 'server'));
    expect(resolved?.id).toBe(ws.id);
  });

  it('a clean workspace is removable without force', async () => {
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-3', source });
    const result = await sub.service.remove(ws.id, { force: false });
    expect(result.removed).toBe(true);
  });
});

describe('WorkspaceService.sweep — retention policy', () => {
  let db: Db;
  let base: string;
  let root: string;
  let source: string;

  beforeEach(async () => {
    db = createTestDb();
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-sweep-')));
    root = path.join(base, 'workspaces');
    source = path.join(base, 'source');
    const origin = path.join(base, 'origin.git');

    git(['init', '--bare', '-b', 'main', origin], base);
    await mkdir(source, { recursive: true });
    git(['clone', origin, source], base);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), '# source\n');
    await writeFile(path.join(source, '.gitignore'), '.env\n');
    git(['add', '.'], source);
    git(['commit', '-m', 'init'], source);
    git(['push', '-u', 'origin', 'main'], source);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function makeSub(
    retentionCap: number | null,
    listAttachedSessions?: (workspacePath: string) => AttachedSession[]
  ): WorkspaceSubsystem {
    return createWorkspaceSubsystem({
      db,
      dorkHome: base,
      config: {
        enabled: true,
        rootPath: root,
        portBase: 4250,
        portBlockSize: 10,
        defaultProvider: 'worktree',
        retentionCap,
      },
      listAttachedSessions,
    });
  }

  it('a null cap disables reclamation — sweep removes nothing', async () => {
    const sub = makeSub(null);
    const a = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    const b = await sub.service.ensure({ projectKey: 'core', key: 'DOR-2', source });

    const result = await sub.service.sweep();

    expect(result.removed).toEqual([]);
    expect(await sub.service.get(a.id)).not.toBeNull();
    expect(await sub.service.get(b.id)).not.toBeNull();
  });

  it('keeps the newest workspaces up to the cap and reclaims older ones', async () => {
    const sub = makeSub(1);
    const older = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    await sub.service.ensure({ projectKey: 'core', key: 'DOR-2', source });
    // Re-ensure bumps lastUsedAt, making DOR-2 unambiguously the newest.
    const newer = await sub.service.ensure({ projectKey: 'core', key: 'DOR-2', source });

    const result = await sub.service.sweep();

    expect(result.removed).toEqual([older.id]);
    expect(await sub.service.get(older.id)).toBeNull();
    expect(await sub.service.get(newer.id)).not.toBeNull();
  });

  it('a pinned workspace beyond the cap survives and is reported', async () => {
    const sub = makeSub(1);
    const pinned = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    await sub.service.setPinned(pinned.id, true);
    const newest = await sub.service.ensure({ projectKey: 'core', key: 'DOR-2', source });

    const result = await sub.service.sweep();

    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ id: pinned.id, reason: 'pinned' });
    expect(await sub.service.get(pinned.id)).not.toBeNull();
    expect(await sub.service.get(newest.id)).not.toBeNull();
  });

  it('a workspace with attached sessions survives as active', async () => {
    const sub = makeSub(0, (workspacePath) => [{ sessionId: 's1', cwd: workspacePath }]);
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });

    const result = await sub.service.sweep();

    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ id: ws.id, reason: 'active' });
    expect(await sub.service.get(ws.id)).not.toBeNull();
  });

  it('a dirty workspace beyond the cap survives the dirty gate', async () => {
    const sub = makeSub(0);
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    await writeFile(path.join(ws.path, 'scratch.txt'), 'uncommitted work\n');

    const result = await sub.service.sweep();

    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ id: ws.id, reason: 'dirty' });
    expect(await sub.service.get(ws.id)).not.toBeNull();
  });

  // The discriminating case for the ownership exemption: this workspace is
  // unpinned, clean, session-less and past a cap of 0, so EVERY other gate lets
  // it through. Only `owner` can save it — remove that check and this test is
  // the one that goes red.
  it('an agent-owned workspace beyond the cap is never swept', async () => {
    const sub = makeSub(0);
    const owned = await sub.service.ensure({
      projectKey: 'core',
      key: 'agent-api-bot-deadbeef',
      source,
      owner: { kind: 'agent', ref: '/projects/api-bot' },
    });

    const result = await sub.service.sweep();

    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ id: owned.id, reason: 'owned' });
    expect(await sub.service.get(owned.id)).not.toBeNull();
  });

  it('an unowned workspace beside an owned one is still swept', async () => {
    const sub = makeSub(0);
    const owned = await sub.service.ensure({
      projectKey: 'core',
      key: 'agent-api-bot-deadbeef',
      source,
      owner: { kind: 'agent', ref: '/projects/api-bot' },
    });
    const unowned = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });

    const result = await sub.service.sweep();

    expect(result.removed).toEqual([unowned.id]);
    expect(await sub.service.get(owned.id)).not.toBeNull();
    expect(await sub.service.get(unowned.id)).toBeNull();
  });
});

describe('WorkspaceService — ownership', () => {
  let db: Db;
  let base: string;
  let root: string;
  let source: string;
  let sub: WorkspaceSubsystem;

  beforeEach(async () => {
    db = createTestDb();
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'ws-owner-')));
    root = path.join(base, 'workspaces');
    source = path.join(base, 'source');
    const origin = path.join(base, 'origin.git');

    git(['init', '--bare', '-b', 'main', origin], base);
    await mkdir(source, { recursive: true });
    git(['clone', origin, source], base);
    git(['config', 'user.email', 't@example.com'], source);
    git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), '# source\n');
    await writeFile(path.join(source, '.gitignore'), '.env\n');
    git(['add', '.'], source);
    git(['commit', '-m', 'init'], source);
    git(['push', '-u', 'origin', 'main'], source);

    sub = createWorkspaceSubsystem({
      db,
      dorkHome: base,
      config: {
        enabled: true,
        rootPath: root,
        portBase: 4250,
        portBlockSize: 10,
        defaultProvider: 'worktree',
        retentionCap: null,
      },
    });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('a workspace ensured with no owner is unowned — the pre-change semantics', async () => {
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    expect(ws.owner).toBeNull();
    expect((await sub.service.get(ws.id))?.owner).toBeNull();
  });

  it('owner survives the sidecar manifest and the derived cache row alike', async () => {
    const owner = { kind: 'agent' as const, ref: '/projects/api-bot' };
    const ws = await sub.service.ensure({
      projectKey: 'core',
      key: 'agent-api-bot-deadbeef',
      source,
      owner,
    });

    // The cache row (what `get`/`list` read).
    expect((await sub.service.get(ws.id))?.owner).toEqual(owner);
    // The sidecar manifest on disk (the source of truth the reconciler rebuilds
    // from) — read straight off the store, not through the service.
    const onDisk = await sub.store.readManifest('core', 'agent-api-bot-deadbeef');
    expect(onDisk?.owner).toEqual(owner);
  });

  it('ensure never re-owns an existing workspace', async () => {
    const first = await sub.service.ensure({
      projectKey: 'core',
      key: 'agent-api-bot-deadbeef',
      source,
      owner: { kind: 'agent', ref: '/projects/api-bot' },
    });
    const again = await sub.service.ensure({
      projectKey: 'core',
      key: 'agent-api-bot-deadbeef',
      source,
      owner: { kind: 'agent', ref: '/projects/somebody-else' },
    });

    expect(again.id).toBe(first.id);
    expect(again.owner).toEqual({ kind: 'agent', ref: '/projects/api-bot' });
  });

  it('a sidecar written before ownership existed reads as unowned', async () => {
    const ws = await sub.service.ensure({ projectKey: 'core', key: 'DOR-1', source });
    // Rewrite the sidecar the way a pre-change release left it: no `owner` key.
    const { owner: _dropped, ...legacy } = ws;
    await writeFile(
      sub.store.manifestPath('core', 'DOR-1'),
      JSON.stringify(legacy, null, 2) + '\n',
      'utf-8'
    );

    const reread = await sub.store.readManifest('core', 'DOR-1');
    expect(reread?.owner).toBeNull();
  });
});
