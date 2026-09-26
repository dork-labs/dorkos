/**
 * An agent arriving from a folder never brings its own wider permissions
 * (spec `agent-permissions`, review D1). Each path that registers a folder —
 * the HTTP register route, the in-session `mesh_register` tool, and the
 * reconciler adopting a folder it found — is driven through its REAL code
 * against a real `MeshCore`, real manifests on disk, and the REAL permission
 * service and observer, joined by the same agent-created seam `index.ts` uses.
 * The folder's own `.dork/agent.json` asks for more than the defaults; what
 * lands is only what is at least as strict, with one history line.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

// The unregister route scans the filesystem for orphaned marketplace installs
// before it removes anything. Not what this file is about, and it is slow.
vi.mock('../../services/mesh/orphaned-installs.js', () => ({
  logOrphanedInstalls: vi.fn().mockResolvedValue(undefined),
}));

import { MeshCore } from '@dorkos/mesh';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createMeshRouter } from '../mesh.js';
import { notifyAgentCreated, setOnAgentCreated } from '../../services/core/agent-created-hook.js';
import { createMeshRegisterHandler } from '../../services/runtimes/claude-code/mcp-tools/mesh-tools.js';
import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';
import {
  ArrivalRecord,
  PermissionObserver,
  createArrivalStep,
  createPermissionService,
  narrowingContext,
  narrowingReader,
  permissionActions,
  readAgentPermissionsFromManifest,
} from '../../services/core/permissions/index.js';
import {
  ARRIVAL_NOTE,
  ARRIVAL_WRITE_FAILED_NOTE,
} from '../../services/core/permissions/permission-service.js';
import { composeCapabilityRegistryForDocs } from '../../services/core/self-description/dorkos-registry.js';
import type { ConfigManager } from '../../services/core/config-manager.js';
import type { ActivityService } from '../../services/activity/activity-service.js';

const target = swappableServer();
const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Careful, with Files & commands at Ask first: what a folder must not widen. */
const CONFIG: Record<string, unknown> = {
  permissions: {
    preset: 'careful',
    defaults: { areas: {}, actions: {} },
    upgradeSweptVersion: null,
  },
  'runtimes.defaultTrustStop': 'ask',
  ui: {},
};
const fakeConfig = {
  get: (key: string) => structuredClone(CONFIG[key]),
  set: (key: string, value: unknown) => {
    CONFIG[key] = value;
  },
  getDot: (key: string) => CONFIG[key] ?? null,
} as unknown as ConfigManager;

let relay: RelayCore;
let mesh: MeshCore;
let base: string;
let agentsHome: string;
let emitted: Array<{ eventType: string; metadata?: Record<string, unknown> }>;
let arrivals: ArrivalRecord;
/** What the gate reads for an agent: the same narrowing reader index.ts hands it. */
let gateRead: (agentPath: string) => Promise<unknown>;

beforeEach(async () => {
  relay = new RelayCore({ dataDir: await tempDir('arrival-relay-') });
  base = await tempDir('arrival-base-');
  agentsHome = await tempDir('arrival-home-');
  mesh = new MeshCore({
    db: createTestDb(),
    relayCore: relay,
    defaultScanRoot: base,
    agentsHomeDir: agentsHome,
  });
  emitted = [];
  const activity = {
    emit: async (event: { eventType: string; metadata?: Record<string, unknown> }) => {
      emitted.push(event);
    },
    list: async () => ({ items: [], nextCursor: null }),
  } as unknown as ActivityService;
  const observer = new PermissionObserver({
    snapshotFile: path.join(await tempDir('arrival-dork-'), 'observed.json'),
    agentAt: (agentPath) => {
      const agent = mesh.listWithPaths().find((a) => a.projectPath === agentPath);
      return agent ? { id: agent.id, name: agent.name } : undefined;
    },
    read: readAgentPermissionsFromManifest,
    areaOfAction: (id) =>
      permissionActions(composeCapabilityRegistryForDocs()).find((a) => a.id === id)?.area,
    activity,
    logger: { warn: () => {} },
  });
  arrivals = new ArrivalRecord({
    file: path.join(await tempDir('arrival-record-'), 'pending.json'),
    logger: { warn: () => {} },
  });
  const service = createPermissionService({
    config: fakeConfig,
    mesh: () => mesh,
    registry: () => composeCapabilityRegistryForDocs(),
    activity,
    observer,
    arrivals,
  });
  gateRead = narrowingReader(readAgentPermissionsFromManifest, {
    arrivals,
    agentAt: (agentPath) => mesh.listWithPaths().find((a) => a.projectPath === agentPath)?.id,
    context: () => narrowingContext(fakeConfig, composeCapabilityRegistryForDocs()),
  });
  // The seam index.ts wires: every arrival takes this step first.
  const onArrival = createArrivalStep({
    arrivals,
    screen: () => (id) => service.screenArrivedAgent(id),
    logger: { warn: () => {} },
  });
  setOnAgentCreated(async (agent) => {
    await onArrival(agent.id);
  });
  mesh.onUnregister((agentId) => {
    arrivals.clear(agentId);
    void observer.forget(agentId);
  });
  // …and a folder a scan finds reaches that seam the way index.ts routes it.
  mesh.onAgentAdopted((agent) => void notifyAgentCreated({ ...agent, origin: 'registered' }));
  const app = express();
  app.use(express.json());
  app.use('/api/mesh', createMeshRouter({ meshCore: mesh }));
  target.mount(app);
});

afterEach(async () => {
  setOnAgentCreated(null);
  // Put write access back so the temp folders can be removed.
  for (const dir of tempDirs) {
    await fs.chmod(dir, 0o755).catch(() => undefined);
  }
  mesh?.close();
  await relay.close();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** A folder whose settings file asks for more than the defaults allow. */
async function wideFolder(root: string, name: string, id: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await writeManifest(dir, {
    id,
    name,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'user',
    personaEnabled: true,
    mcpServers: [],
    workspace: { mode: 'home' },
    permissions: {
      areas: { rooms: 'allowed', tasks: 'allowed', agents: 'blocked' },
      actions: { tasks_delete: 'allowed' },
      filesAndCommands: 'autonomy',
    },
  } as AgentManifest);
  return dir;
}

/** What landed, and the one line that says so. */
async function expectScreened(dir: string): Promise<void> {
  const manifest = await readManifest(dir);
  expect(manifest?.permissions).toEqual({ areas: { agents: 'blocked' } });
  const lines = emitted.filter((e) => e.eventType === 'permission.changed');
  expect(lines).toHaveLength(1);
  expect(lines[0]!.metadata).toMatchObject({ note: ARRIVAL_NOTE });
}

describe('a folder cannot widen the agent it registers', () => {
  it('through POST /api/mesh/agents', async () => {
    const dir = await wideFolder(
      path.join(base, 'proj'),
      'http-wide',
      '01JKARRIVEHTTP000000000000'
    );
    const res = await request(target.server).post('/api/mesh/agents').send({ path: dir });
    expect(res.status).toBe(201);
    await expectScreened(dir);
  });

  it('through the mesh_register tool', async () => {
    const dir = await wideFolder(
      path.join(base, 'proj'),
      'tool-wide',
      '01JKARRIVETOOL000000000000'
    );
    const register = createMeshRegisterHandler({ meshCore: mesh } as unknown as McpToolDeps);
    const result = await register({ path: dir, name: 'tool-wide', runtime: 'claude-code' });
    expect(result.isError).toBeFalsy();
    await expectScreened(dir);
  });

  it('through the reconciler adopting a folder it found', { timeout: 20_000 }, async () => {
    const dir = await wideFolder(agentsHome, 'found-wide', '01JKARRIVESCAN000000000000');
    mesh.startPeriodicReconciliation(20);
    await vi.waitFor(
      async () =>
        expect((await readManifest(dir))?.permissions).toEqual({ areas: { agents: 'blocked' } }),
      { timeout: 15_000 }
    );
    await expectScreened(dir);
  });

  it('stays on the defaults when its settings file cannot be written back', async () => {
    const dir = await wideFolder(
      path.join(base, 'proj'),
      'locked-wide',
      '01JKARRIVELOCK000000000000'
    );
    const dork = path.join(dir, '.dork');
    await fs.chmod(path.join(dork, 'agent.json'), 0o444);
    await fs.chmod(dork, 0o555);
    try {
      const res = await request(target.server).post('/api/mesh/agents').send({ path: dir });
      expect(res.status).toBe(201);
      // The file still says what the folder wrote…
      expect((await readManifest(dir))?.permissions?.filesAndCommands).toBe('autonomy');
      // …but nothing that reads it for the gate honours that.
      expect(arrivals.isPending(res.body.id)).toBe(true);
      expect(await gateRead(dir)).toEqual({ areas: { agents: 'blocked' } });
      const lines = emitted.filter((e) => e.eventType === 'permission.changed');
      expect(lines).toHaveLength(1);
      expect(lines[0]!.metadata).toMatchObject({ note: ARRIVAL_WRITE_FAILED_NOTE });
    } finally {
      await fs.chmod(dork, 0o755);
      await fs.chmod(path.join(dork, 'agent.json'), 0o644);
    }
  });

  it('screens a new folder that reuses the id of an agent that left', async () => {
    const id = '01JKARRIVEREUSE00000000000';
    const first = await wideFolder(path.join(base, 'proj'), 'first-owner', id);
    const registered = await request(target.server).post('/api/mesh/agents').send({ path: first });
    expect(registered.status).toBe(201);
    // It reads its (screened) settings, so DorkOS has a record of this id.
    await gateRead(first);
    expect((await request(target.server).delete(`/api/mesh/agents/${id}`)).status).toBe(200);

    emitted = [];
    const second = await wideFolder(path.join(base, 'proj'), 'second-owner', id);
    const again = await request(target.server).post('/api/mesh/agents').send({ path: second });
    expect(again.status).toBe(201);
    await expectScreened(second);
  });
});
