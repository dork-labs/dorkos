/**
 * Every way an agent arrives, is renamed, or leaves — each one broadcasting
 * exactly once.
 *
 * ## Why this file exists rather than eight assertions spread around
 *
 * The whole argument for putting the observer at the `AgentRegistry` seam,
 * instead of on each route that mutates an agent, is that a seam cannot be
 * forgotten by the ninth caller. That is a claim about coverage, and a claim
 * about coverage is only worth what a test spends proving it. So this drives
 * each entry point through its REAL path — a real `MeshCore` over a real
 * database, real manifests on a real disk, the routes mounted as the server
 * mounts them — and counts the broadcasts.
 *
 * It drives the REAL wiring, `wireLiveChangeBroadcasts`, rather than
 * subscribing to `onAgentsChanged` directly — which would prove the seam and
 * not the wire, the same gap `unregister-cascade.integration.test.ts` was
 * written to close for `onUnregister`. The payload decisions that wiring makes
 * are probed next door in `services/core/__tests__/live-change-broadcasts.test.ts`;
 * this file is about which WRITES reach it. That `index.ts` really calls it is
 * held by `services/core/__tests__/sse-event-allowlist.test.ts`, which scans the
 * server tree for the literal names and fails if `GENERIC_EVENTS` lists one
 * nothing broadcasts.
 *
 * **Run it with a fresh `@dorkos/mesh` build.** `pnpm test` gets one from
 * turbo's `^build`, but the targeted `pnpm vitest run <path>` loop does not, and
 * `apps/server/vitest.config.ts` does not alias this package — by that file's
 * own rule, which scopes aliases to modules whose SOURCE TEXT is the subject of
 * a test, and mesh here is a dependency being exercised rather than read. So a
 * stale dist can hand this file yesterday's observer and pass. If you are
 * changing `packages/mesh` and running this alone:
 * `pnpm --filter @dorkos/mesh build` first.
 *
 * ## The number that matters is ONE
 *
 * Not "at least one": a write that broadcasts twice makes every open window
 * refetch twice, and a five-minute reconciler pass that broadcast once per agent
 * it re-observed would be a polling loop wearing an event's name. Each case
 * asserts the exact count.
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

// Passthrough boundary validation. Every entry point below validates the paths
// it is handed, and the temp directories these cases use are outside whatever
// boundary the ambient environment resolves.
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
import type { Db } from '@dorkos/db';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import { createMeshRouter } from '../mesh.js';
import { createAgentsRouter } from '../agents.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { setOnAgentCreated } from '../../services/core/agent-created-hook.js';
import { wireLiveChangeBroadcasts } from '../../services/core/streams/live-change-broadcasts.js';
import { createMeshRegisterHandler } from '../../services/runtimes/claude-code/mcp-tools/mesh-tools.js';
import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';

/** One bound listener for the file; the app behind it is swapped per case. */
const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const tempDirs: string[] = [];

/** A temp directory removed after the case that made it. */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let db: Db;
let relay: RelayCore;
let mesh: MeshCore;
let app: express.Application;
let base: string;
let agentsHome: string;
/** Every `agents_changed` payload the fan-out carried during a case. */
let broadcasts: Array<Record<string, unknown>>;
let unsubscribe: () => void;

beforeEach(async () => {
  db = createTestDb();
  relay = new RelayCore({ dataDir: await makeTempDir('agents-changed-relay-') });
  base = await makeTempDir('agents-changed-base-');
  agentsHome = await makeTempDir('agents-changed-home-');
  mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base, agentsHomeDir: agentsHome });

  broadcasts = [];
  unsubscribe = eventFanOut.subscribe((eventName, data) => {
    if (eventName === 'agents_changed') broadcasts.push(data as Record<string, unknown>);
  });

  // The REAL wiring, the same call `index.ts` makes. No config manager is
  // needed here — this file is about agent writes — so it gets an inert one.
  wireLiveChangeBroadcasts({
    meshCore: mesh,
    configManager: { onChange: () => () => {} },
    eventFanOut,
  });

  // The agent-created seam is module-level and set by index.ts; nothing here
  // needs it, and leaving another suite's listener attached would run it.
  setOnAgentCreated(null);

  app = express();
  app.use(express.json());
  app.use('/api/mesh', createMeshRouter({ meshCore: mesh }));
  app.use('/api/agents', createAgentsRouter(mesh));
  fixtureTarget.mount(app);
});

afterEach(async () => {
  unsubscribe();
  setOnAgentCreated(null);
  mesh?.close();
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

/** A project directory under the scan root, with no manifest of its own yet. */
async function makeProjectDir(name: string): Promise<string> {
  const dir = path.join(base, 'proj', name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Register an agent and clear the broadcast it made, so a case starts clean. */
async function registerAndReset(name: string): Promise<{ id: string; dir: string }> {
  const dir = await makeProjectDir(name);
  const manifest = await mesh.registerByPath(dir, { name, runtime: 'claude-code' });
  broadcasts = [];
  return { id: manifest.id, dir };
}

describe('every agent mutation entry point broadcasts agents_changed exactly once', () => {
  it('POST /api/mesh/agents', async () => {
    const dir = await makeProjectDir('http-register');

    const res = await request(fixtureServer)
      .post('/api/mesh/agents')
      .send({ path: dir, overrides: { name: 'http-register', runtime: 'claude-code' } });

    expect(res.status).toBe(201);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      kind: 'registered',
      agentId: res.body.id,
      name: 'http-register',
    });
    expect(typeof broadcasts[0].changedAt).toBe('string');
  });

  it('PATCH /api/mesh/agents/:id', async () => {
    const { id } = await registerAndReset('http-patch');

    const res = await request(fixtureServer)
      .patch(`/api/mesh/agents/${id}`)
      .send({ displayName: 'Renamed By The Operator' });

    expect(res.status).toBe(200);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      kind: 'updated',
      agentId: id,
      displayName: 'Renamed By The Operator',
    });
  });

  it('DELETE /api/mesh/agents/:id', async () => {
    const { id } = await registerAndReset('http-delete');

    const res = await request(fixtureServer).delete(`/api/mesh/agents/${id}`);

    expect(res.status).toBe(200);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ kind: 'removed', agentId: id, name: 'http-delete' });
    // The row really is gone, so the event is not describing a write that did
    // not happen.
    expect(mesh.get(id)).toBeUndefined();
  });

  it('POST /api/agents — the create-by-writing-a-manifest route', async () => {
    const dir = await makeProjectDir('agents-post');

    const res = await request(fixtureServer)
      .post('/api/agents')
      .send({ path: dir, name: 'agents-post', runtime: 'claude-code' });

    expect(res.status).toBe(201);
    // It writes the manifest itself and then syncs the DB cache (ADR-0043), so
    // the one broadcast comes from the sync rather than from the route.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ kind: 'registered', agentId: res.body.id });
  });

  it('PATCH /api/agents/current — an agent editing ITSELF through agent-updater', async () => {
    const { id, dir } = await registerAndReset('self-edit');

    const res = await request(fixtureServer)
      .patch('/api/agents/current')
      .query({ path: dir })
      .send({ displayName: 'What I Call Myself' });

    expect(res.status).toBe(200);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      kind: 'updated',
      agentId: id,
      displayName: 'What I Call Myself',
    });
  });

  it('MeshCore.syncFromDisk — a manifest edited outside DorkOS', async () => {
    const { id, dir } = await registerAndReset('sync-from-disk');
    const manifest = await readManifest(dir);
    await writeManifest(dir, { ...manifest!, description: 'edited by hand' });

    expect(await mesh.syncFromDisk(dir)).toBe('synced');

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ kind: 'updated', agentId: id });
  });

  it('the reconciler adopting a manifest it found on disk', async () => {
    // A `.dork/agent.json` appears in the managed agents home — a marketplace
    // install, a `git clone`, a person copying a folder — and nothing told
    // DorkOS. The five-minute pass is what finds it, and until now that
    // adoption was invisible until someone reloaded the page.
    const adopted = path.join(agentsHome, 'adopted');
    await fs.mkdir(adopted, { recursive: true });
    await writeManifest(adopted, {
      id: '01JKADOPTED00000000000000',
      name: 'adopted',
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'user',
      personaEnabled: true,
      enabledToolGroups: {},
      mcpServers: [],
      workspace: { mode: 'home' },
    });

    mesh.startPeriodicReconciliation(20);

    await vi.waitFor(() => expect(broadcasts).toHaveLength(1), { timeout: 5_000 });
    expect(broadcasts[0]).toMatchObject({
      kind: 'registered',
      agentId: '01JKADOPTED00000000000000',
      name: 'adopted',
    });

    // …and the passes after it say NOTHING, because re-seeing a known agent is
    // not news. This is the property that keeps `agents_changed` from becoming a
    // timer: the scanner re-yields every manifest-bearing directory it walks
    // past, on every pass.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(broadcasts).toHaveLength(1);
  });

  it('the in-session mesh_register MCP tool', async () => {
    const dir = await makeProjectDir('mcp-register');
    const meshRegister = createMeshRegisterHandler({ meshCore: mesh } as unknown as McpToolDeps);

    const result = await meshRegister({ path: dir, name: 'mcp-register', runtime: 'claude-code' });

    expect(result.isError).toBeFalsy();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ kind: 'registered', name: 'mcp-register' });
  });
});

describe('what must NOT reach the wire', () => {
  it('a heartbeat says nothing — it happens on every message an agent sends', async () => {
    const { id, dir } = await registerAndReset('heartbeat');

    await request(fixtureServer).post(`/api/mesh/agents/${id}/heartbeat`).send({});
    mesh.updateLastSeen(id, 'message_sent');

    expect(broadcasts).toEqual([]);
    // Two controls, because silence proves nothing on its own. First: the
    // health write really landed, so this is the contract and not a no-op
    // passing for one. Second: this fixture CAN still speak — an identity write
    // on the same agent, right after, is heard. Without the second, a broken
    // subscription would pass this case.
    expect(mesh.agentRegistry.getWithHealth(id)!.lastSeenEvent).toBe('message_sent');
    await request(fixtureServer)
      .patch('/api/agents/current')
      .query({ path: dir })
      .send({ displayName: 'Still Listening' });
    expect(broadcasts).toHaveLength(1);
  });

  it('the payload carries names and ids — not the manifest body, not the path', async () => {
    const dir = await makeProjectDir('payload-shape');
    await request(fixtureServer)
      .post('/api/mesh/agents')
      .send({
        path: dir,
        overrides: {
          name: 'payload-shape',
          runtime: 'claude-code',
          description: 'a description nobody on the stream should receive',
          capabilities: ['code-review'],
        },
      });

    expect(broadcasts).toHaveLength(1);
    expect(Object.keys(broadcasts[0]).sort()).toEqual([
      'agentId',
      'changedAt',
      'displayName',
      'kind',
      'name',
    ]);
    expect(JSON.stringify(broadcasts[0])).not.toContain('a description nobody');
    expect(JSON.stringify(broadcasts[0])).not.toContain('code-review');
    // The directory is on the IN-PROCESS event and off the wire: this frame is
    // global, an agent's connection receives it, and nothing on the client
    // reads the payload at all.
    expect(JSON.stringify(broadcasts[0])).not.toContain(dir);
    expect(mesh.getProjectPath((broadcasts[0] as { agentId: string }).agentId)).toBe(dir);
  });
});
