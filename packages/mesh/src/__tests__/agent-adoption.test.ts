/**
 * Adoption callbacks: a scan that adopts a manifest nobody had registered
 * before says so once, and a re-scan of the same agent says nothing (DOR-1042).
 *
 * The server wires {@link MeshCore.onAgentAdopted} to the agent-created seam, so
 * an agent that first appears through a discovery scan takes its #team seat
 * without waiting for the next boot (team-room-home spec D3.1). The whole value
 * of the callback is that it fires on adoption and NOT on re-observation: the
 * scan re-yields every manifest-bearing directory it walks past, registered or
 * not, and the reconciler runs one every five minutes — a callback that fired on
 * each of those would re-announce every agent on the machine twelve times an
 * hour.
 *
 * Driven through the real `MeshCore` over real temp directories, because the
 * question is what a scan of what is on disk decides.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Logger } from '@dorkos/shared/logger';
import { MeshCore } from '../mesh-core.js';
import { writeManifest } from '../manifest.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-adoption-'));
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
    name: 'ana',
    description: '',
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

/** A logger that swallows everything, so a refusal warning does not spam the run. */
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

/** Write a manifest into `dir`, creating it first. */
async function seedAgent(dir: string, manifest: AgentManifest): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeManifest(dir, manifest);
}

/** Run a whole scan of `root` to completion, discarding the events. */
async function scan(mesh: MeshCore, root: string): Promise<void> {
  for await (const _ of mesh.discover([root])) void _;
}

describe('MeshCore.onAgentAdopted', () => {
  it('fires once for an agent the scan adopts for the first time', async () => {
    const base = await makeTempDir();
    const home = path.join(base, 'ana');
    await seedAgent(home, makeManifest({ id: '01ANA0000000000000000000A', displayName: 'Ana' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const adopted = vi.fn();
    mesh.onAgentAdopted(adopted);

    await scan(mesh, base);

    expect(adopted).toHaveBeenCalledTimes(1);
    expect(adopted).toHaveBeenCalledWith({
      id: '01ANA0000000000000000000A',
      name: 'ana',
      displayName: 'Ana',
      // The directory rides along: the rooms domain keys on it.
      path: home,
    });

    mesh.close();
  });

  it('stays silent when a later scan re-sees an agent it already knows', async () => {
    const base = await makeTempDir();
    const home = path.join(base, 'ana');
    await seedAgent(home, makeManifest({ id: '01ANA0000000000000000000A' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const adopted = vi.fn();
    mesh.onAgentAdopted(adopted);

    await scan(mesh, base);
    expect(adopted).toHaveBeenCalledTimes(1);

    // The every-five-minutes reconciler pass, and the one after that.
    await scan(mesh, base);
    await scan(mesh, base);

    expect(adopted).toHaveBeenCalledTimes(1);

    mesh.close();
  });

  it('stays silent for a duplicate manifest the relocation guard refuses', async () => {
    const base = await makeTempDir();
    const primary = path.join(base, 'repo');
    const worktree = path.join(base, 'worktrees', 'one');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    for (const dir of [primary, worktree]) await seedAgent(dir, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const adopted = vi.fn();
    mesh.onAgentAdopted(adopted);

    await scan(mesh, base);

    // One registration happened, so one announcement — the refused copy is not
    // a second agent and must not be announced as one.
    expect(adopted).toHaveBeenCalledTimes(1);
    expect(adopted.mock.calls[0]![0]).toMatchObject({ path: primary });

    mesh.close();
  });

  it('stays silent when a known agent merely moves to a new directory', async () => {
    const base = await makeTempDir();
    const oldHome = path.join(base, 'old');
    const newHome = path.join(base, 'new');
    const manifest = makeManifest({ id: '01ANA0000000000000000000A' });
    await seedAgent(oldHome, manifest);

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const adopted = vi.fn();
    mesh.onAgentAdopted(adopted);

    await scan(mesh, base);
    expect(adopted).toHaveBeenCalledTimes(1);

    // The agent genuinely moves: the old directory releases the manifest.
    await fs.rm(oldHome, { recursive: true, force: true });
    await seedAgent(newHome, manifest);
    await scan(mesh, base);

    // A relocation is the same agent in a new place — it already has its seat.
    expect(adopted).toHaveBeenCalledTimes(1);

    mesh.close();
  });

  it('a throwing callback costs neither the other callbacks nor the rest of the scan', async () => {
    const base = await makeTempDir();
    await seedAgent(path.join(base, 'ana'), makeManifest({ id: '01ANA0000000000000000000A' }));
    await seedAgent(path.join(base, 'bo'), makeManifest({ id: '01BOB0000000000000000000B' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const broken = vi.fn(() => {
      throw new Error('team seat exploded');
    });
    const healthy = vi.fn();
    mesh.onAgentAdopted(broken);
    mesh.onAgentAdopted(healthy);

    await expect(scan(mesh, base)).resolves.toBeUndefined();

    // The second listener still ran, for BOTH agents — a broken reaction must
    // not swallow its neighbour's, nor stop the announcement of the next agent.
    expect(broken).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(healthy.mock.calls.map(([agent]) => agent.id).sort()).toEqual([
      '01ANA0000000000000000000A',
      '01BOB0000000000000000000B',
    ]);

    // Both agents still registered: a thrown reaction costs no registration.
    expect(mesh.listWithPaths()).toHaveLength(2);

    mesh.close();
  });

  it('does not fire for an explicit registerByPath — that path notifies for itself', async () => {
    const base = await makeTempDir();
    const home = path.join(base, 'ana');
    await fs.mkdir(home, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const adopted = vi.fn();
    mesh.onAgentAdopted(adopted);

    await mesh.registerByPath(home, { name: 'ana', runtime: 'claude-code' });

    // `POST /api/mesh/agents` and the `mesh_register` MCP tool notify the seam
    // directly; firing here too would seat the agent twice.
    expect(adopted).not.toHaveBeenCalled();

    mesh.close();
  });

  it('does not fire for syncFromDisk — the creation paths that call it notify for themselves', async () => {
    const base = await makeTempDir();
    const home = path.join(base, 'ana');
    await seedAgent(home, makeManifest({ id: '01ANA0000000000000000000A' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base, logger: quietLogger() });
    const adopted = vi.fn();
    mesh.onAgentAdopted(adopted);

    // `createAgentWorkspace` and `POST /api/agents` both write the manifest,
    // call `syncFromDisk`, then notify the seam themselves.
    await mesh.syncFromDisk(home);

    expect(adopted).not.toHaveBeenCalled();

    mesh.close();
  });
});
