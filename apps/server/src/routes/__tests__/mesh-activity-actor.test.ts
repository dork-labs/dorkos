/**
 * Who the Activity feed says registered or removed an agent (DOR-1829).
 *
 * These are the highest-stakes verbs the feed reports — one of them deletes
 * another agent's `.dork` directory — and all three hardcoded `actorType: 'user'`
 * with the label `'You'`, with no caller check anywhere on the router. So an agent
 * removing another agent was recorded in the operator's own feed as their own
 * doing, which is worse than silence because a feed is believed.
 *
 * Driven through the real router and the REAL identity middleware, with only the
 * token→agent lookup faked: the subject is that seam, not the mesh registry.
 *
 * @module routes/__tests__/mesh-activity-actor
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The one token the faked identity service knows about. */
const KNOWN_TOKEN = 'tok_known_agent';

/** A token in the shape agent identity actually mints — bare hex, no prefix. */
const REAL_SHAPED_TOKEN = 'a3f9c1e2b70d48a6915ce4d2f8b03c7e';

const IDENTITY = {
  agentPath: '/Users/dev/agents/researcher',
  displayName: 'Researcher',
  createdAt: '2026-09-01T00:00:00.000Z',
};

vi.mock('../../services/core/agent-identity/agent-identity-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/core/agent-identity/agent-identity-service.js')
  >()),
  getAgentIdentityService: () => ({
    resolve: async (token: string) => (token === KNOWN_TOKEN ? IDENTITY : null),
  }),
}));

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

// Keep the rest of the manifest module real; a whole-module factory blanks
// `MANIFEST_DIR`/`MANIFEST_FILE` for the mesh package's own git-tracked guard.
vi.mock('@dorkos/shared/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/manifest')>()),
  removeDorkDirectory: vi.fn(async () => undefined),
  probeManifest: vi.fn(async () => ({ state: 'present' })),
}));

vi.mock('@dorkos/mesh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/mesh')>()),
  // The real one shells out to git; the delete-with-data route only cares about
  // the answer.
  isManifestGitTracked: vi.fn(async () => false),
}));

vi.mock('../../services/mesh/orphaned-installs.js', () => ({
  logOrphanedInstalls: vi.fn(async () => undefined),
}));

vi.mock('../../services/core/agent-created-hook.js', () => ({
  notifyAgentCreated: vi.fn(async () => undefined),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The `/api` chain reads config (login, the host allowlist); nothing is set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { RequestListener } from 'node:http';
import type { MeshCore } from '@dorkos/mesh';
import { createMeshRoutes } from '../mesh.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Every actor field an emitted event carried. */
interface EmittedActor {
  actorType: string;
  actorId?: string | null;
  actorLabel: string;
  summary: string;
}

let emitted: EmittedActor[];

const REGISTERED = {
  id: 'agent-1',
  name: 'Test Agent',
  runtime: 'claude-code' as const,
  isSystem: false,
};

/** The activity feed, recording what each write emitted. */
function recordingActivity(): ActivityService {
  return {
    emit: vi.fn(async (event: EmittedActor) => {
      emitted.push(event);
    }),
  } as unknown as ActivityService;
}

/** The routes behind the real `/api` chain: identity resolution, then the group. */
function buildApp(): RequestListener {
  const meshCore = {
    registerByPath: vi.fn(async () => REGISTERED),
    unregister: vi.fn(async () => ({ manifestKept: false })),
    get: vi.fn(() => REGISTERED),
    getProjectPath: vi.fn(() => '/tmp/projects/agent-1'),
  };

  return honoGroupListener({
    path: '/api/mesh',
    routes: createMeshRoutes({
      meshCore: meshCore as unknown as MeshCore,
      activity: recordingActivity(),
    }),
  });
}

/** One write on this router, driven with whatever identity headers a test wants. */
type Drive = (headers: Record<string, string>) => Promise<{ status: number }>;

const ROUTES: Array<{ name: string; drive: Drive; expectStatus: number }> = [
  {
    name: 'POST /api/mesh/agents',
    expectStatus: 201,
    drive: (headers) =>
      request(fixtureServer)
        .post('/api/mesh/agents')
        .set(headers)
        .send({ path: '/tmp/projects/agent-1' }),
  },
  {
    name: 'DELETE /api/mesh/agents/:id/data',
    expectStatus: 200,
    drive: (headers) =>
      request(fixtureServer).delete('/api/mesh/agents/agent-1/data').set(headers).send(),
  },
  {
    name: 'DELETE /api/mesh/agents/:id',
    expectStatus: 200,
    drive: (headers) =>
      request(fixtureServer).delete('/api/mesh/agents/agent-1').set(headers).send(),
  },
];

describe('who the Activity feed says registered or removed an agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitted = [];
    fixtureTarget.mount(buildApp());
  });

  describe.each(ROUTES)('$name', ({ drive, expectStatus }) => {
    it('records a browser write as the person', async () => {
      const res = await drive({});

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'user', actorLabel: 'You' });
      expect(emitted[0].actorId).toBeUndefined();
    });

    it('records an identified agent as that agent, not as the person', async () => {
      const res = await drive({ 'x-dorkos-agent': KNOWN_TOKEN });

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'agent',
        actorId: IDENTITY.agentPath,
        actorLabel: 'Researcher',
      });
    });

    it('records a token that resolves to nothing as an unidentified caller', async () => {
      const res = await drive({ 'x-dorkos-agent': 'tok_nobody_knows' });

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
      expect(emitted[0].actorId).toBeUndefined();
    });

    it('never writes a real-shaped presented token into the feed', async () => {
      await drive({ 'x-dorkos-agent': REAL_SHAPED_TOKEN });

      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(0, 16));
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(-16));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'system' });
    });
  });

  // The heartbeat route is the one emit here that must NOT follow the caller:
  // nobody asked for it, DorkOS noticed the transition and is reporting it.
  it('still records a health transition as the system, even for an identified agent', async () => {
    const health = { status: 'active', name: 'Test Agent' };
    const meshCore = {
      getAgentHealth: vi
        .fn()
        .mockReturnValueOnce({ ...health, status: 'stale' })
        .mockReturnValue(health),
      updateLastSeen: vi.fn(),
    };
    fixtureTarget.mount(
      honoGroupListener({
        path: '/api/mesh',
        routes: createMeshRoutes({
          meshCore: meshCore as unknown as MeshCore,
          activity: recordingActivity(),
        }),
      })
    );

    const res = await request(fixtureServer)
      .post('/api/mesh/agents/agent-1/heartbeat')
      .set({ 'x-dorkos-agent': KNOWN_TOKEN })
      .send({});

    expect(res.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ actorType: 'system', actorLabel: 'System' });
  });
});
