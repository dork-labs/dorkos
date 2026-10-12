/**
 * Who the Activity feed says registered an agent (DOR-1829).
 *
 * Both creation routes are reachable by an agent — `create_agent` is tier `act`,
 * and `dorkos agent create` POSTs to `/api/agents/create` carrying whatever
 * `DORKOS_AGENT_TOKEN` holds — and both hardcoded `actorType: 'user'` with the
 * label `'You'`. So an agent that registered another agent was recorded in the
 * operator's own feed as their own action.
 *
 * Driven through the real router and the REAL identity middleware, with only the
 * token→agent lookup faked, because the subject is that seam: what the middleware
 * leaves for the route, and what the route then writes into the feed. The digest
 * helper stays real so the "no token in the feed" probes exercise the production
 * path that logs an unresolvable token.
 *
 * @module routes/__tests__/agents-activity-actor
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
  expandTilde: vi.fn((p: string) => p),
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

vi.mock('@dorkos/shared/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/manifest')>()),
  readManifest: vi.fn(async () => null),
  writeManifest: vi.fn(async () => undefined),
}));

vi.mock('@dorkos/shared/convention-files-io', () => ({
  readConventionFile: vi.fn(async () => null),
  writeConventionFile: vi.fn(async () => undefined),
  writeConventionFileIfAbsent: vi.fn(async () => true),
}));

vi.mock('../../services/core/agent-created-hook.js', () => ({
  notifyAgentCreated: vi.fn(async () => undefined),
}));

vi.mock('../../services/core/agent-creator.js', () => ({
  createAgentWorkspace: vi.fn(async () => ({
    manifest: { id: 'created-1', name: 'Created Agent' },
    path: '/tmp/agents/created',
  })),
  AgentCreationError: class AgentCreationError extends Error {
    code = 'VALIDATION';
    statusCode = 400;
  },
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
import { createAgentsRoutes } from '../agents.js';
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

/** The routes behind the real `/api` chain: identity resolution, then the group. */
function buildApp(): RequestListener {
  const activity = {
    emit: vi.fn(async (event: EmittedActor) => {
      emitted.push(event);
    }),
  } as unknown as ActivityService;
  return honoGroupListener({ path: '/api/agents', routes: createAgentsRoutes({ activity }) });
}

/** One write on this router, driven with whatever identity headers a test wants. */
type Drive = (headers: Record<string, string>) => Promise<{ status: number }>;

const ROUTES: Array<{ name: string; drive: Drive; expectStatus: number }> = [
  {
    name: 'POST /api/agents',
    expectStatus: 201,
    drive: (headers) =>
      request(fixtureServer)
        .post('/api/agents')
        .set(headers)
        .send({ path: '/tmp/agents/new', name: 'New Agent', runtime: 'claude-code' }),
  },
  {
    name: 'POST /api/agents/create',
    expectStatus: 201,
    drive: (headers) =>
      request(fixtureServer)
        .post('/api/agents/create')
        .set(headers)
        .send({ name: 'Created Agent', directory: '/tmp/agents/created' }),
  },
];

describe('who the Activity feed says registered an agent', () => {
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
      // A probe that only ever searches for a `tok_…` string is weaker than it
      // looks: it would still pass if the route wrote a transformed slice of the
      // credential. The halves are checked too, so a split or truncated copy
      // cannot hide inside JSON escaping.
      await drive({ 'x-dorkos-agent': REAL_SHAPED_TOKEN });

      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(0, 16));
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(-16));
      // The absence above is the route declining to name the token, not the
      // route emitting nothing.
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'system' });
    });
  });
});
