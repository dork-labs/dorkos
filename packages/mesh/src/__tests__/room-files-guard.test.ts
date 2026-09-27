/**
 * No agent registers inside a room's files, and a linked worktree of a
 * registered home never registers either (spec `agent-home-desk` §3.3,
 * invariant I2, DOR-2355).
 *
 * A room repo, its checkout and every agent's worktree of it are shared or
 * private working copies, never homes. A `.dork/agent.json` committed there is
 * just a file: registering it would let a room's content decide who an agent
 * is. The worktree case was already refused by the duplicate-manifest guard
 * (ADR 260801-003050); it is named here so the invariant is pinned in both
 * places.
 *
 * Driven through the real `MeshCore` over real directories and real git.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { MeshCore } from '../mesh-core.js';
import { InsideRoomFilesError } from '../mesh-discovery.js';
import { writeManifest } from '../manifest.js';

let db: Db;
let base: string;
let roomsDir: string;

beforeEach(async () => {
  db = createTestDb();
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'room-files-guard-')));
  roomsDir = path.join(base, 'dork', 'rooms');
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function makeManifest(id: string, name: string): AgentManifest {
  return {
    id,
    name,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-09-26T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    mcpServers: [],
    workspace: { mode: 'home' },
  };
}

async function seedAgent(dir: string, manifest: AgentManifest): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeManifest(dir, manifest);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'pipe' }
  );
}

describe("a room's files never register an agent", () => {
  it('refuses a room repo carrying a committed manifest, on every registration path', async () => {
    const roomRepo = path.join(roomsDir, '01ROOM', 'repo');
    const worktree = path.join(roomsDir, '01ROOM', 'worktrees', 'ana-1a2b3c4d');
    await seedAgent(roomRepo, makeManifest('01ROOMREPO0000000000000000', 'room-copy'));
    await seedAgent(worktree, makeManifest('01ROOMWORKTREE000000000000', 'worktree-copy'));
    const mesh = new MeshCore({ db, defaultScanRoot: base, roomFilesDir: roomsDir });

    expect(await mesh.syncFromDisk(roomRepo)).toBe('inside-room-files');
    await expect(mesh.registerByPath(worktree, {})).rejects.toBeInstanceOf(InsideRoomFilesError);
    await expect(
      mesh.registerByPath(path.join(roomsDir, '01ROOM', 'fresh'), {
        name: 'fresh',
        runtime: 'claude-code',
      })
    ).rejects.toMatchObject({ reason: 'inside-room-files' });
    for await (const _ of mesh.discover([base])) void _;

    expect(mesh.listWithPaths()).toEqual([]);
    mesh.close();
  });

  it('refuses a symlink that points into a room`s repo', async () => {
    const roomRepo = path.join(roomsDir, '01ROOM', 'repo');
    await seedAgent(roomRepo, makeManifest('01ROOMREPO0000000000000000', 'room-copy'));
    const link = path.join(base, 'looks-like-a-project');
    await fs.symlink(roomRepo, link);
    const mesh = new MeshCore({ db, defaultScanRoot: base, roomFilesDir: roomsDir });

    expect(await mesh.syncFromDisk(link)).toBe('inside-room-files');
    await expect(mesh.registerByPath(link, {})).rejects.toBeInstanceOf(InsideRoomFilesError);
    expect(mesh.listWithPaths()).toEqual([]);
    mesh.close();
  });

  it('still registers the same manifest outside the rooms folder', async () => {
    const home = path.join(base, 'agents', 'ana');
    await seedAgent(home, makeManifest('01ANAHOME00000000000000000', 'ana'));
    const mesh = new MeshCore({ db, defaultScanRoot: base, roomFilesDir: roomsDir });

    expect(await mesh.syncFromDisk(home)).toBe('synced');
    expect(mesh.listWithPaths().map((a) => a.projectPath)).toEqual([home]);
    mesh.close();
  });
});

describe('a linked worktree of a registered home', () => {
  it('is refused duplicate-id, so its committed .dork/ registers no agent', async () => {
    const home = path.join(base, 'ana');
    const tree = path.join(base, 'trees', 'ana-feature');
    await seedAgent(home, makeManifest('01ANAHOME00000000000000000', 'ana'));
    git(home, 'init', '-q', '-b', 'main');
    git(home, 'add', '-A');
    git(home, 'commit', '-q', '-m', 'agent');
    git(home, 'worktree', 'add', '-q', '-b', 'feature', tree);
    const mesh = new MeshCore({ db, defaultScanRoot: base, roomFilesDir: roomsDir });

    expect(await mesh.syncFromDisk(home)).toBe('synced');
    expect(await mesh.syncFromDisk(tree)).toBe('duplicate-id');
    await expect(mesh.registerByPath(tree, {})).rejects.toThrow(
      /Two directories cannot hold one agent/
    );
    expect(mesh.listWithPaths().map((a) => a.projectPath)).toEqual([home]);
    mesh.close();
  });
});
