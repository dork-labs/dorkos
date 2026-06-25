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
import { derivePorts } from '@dorkos/shared/workspace';
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
