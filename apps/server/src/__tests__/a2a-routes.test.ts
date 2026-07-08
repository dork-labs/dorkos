/**
 * @vitest-environment node
 */
// NOTE: this file resolves @dorkos/a2a-gateway from its built dist — run
// `pnpm --filter @dorkos/a2a-gateway build` first, or a stale/missing dist
// fails these tests with confusing module-resolution or assertion errors.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createA2aRouter } from '../routes/a2a.js';
import { buildA2aRateLimiters } from '../middleware/a2a-rate-limit.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01HZB1AGENTULID0000001',
    name: 'backend-bot',
    description: 'An expert in REST API design',
    runtime: 'claude-code',
    capabilities: ['code-review', 'testing'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    namespace: 'default',
    registeredAt: '2026-03-22T00:00:00.000Z',
    registeredBy: 'kai',
    personaEnabled: true,
    enabledToolGroups: {},
    ...overrides,
  };
}

const AGENT_ALPHA = makeManifest({
  id: '01HZB1ALPHA000000000001',
  name: 'alpha-agent',
  description: 'Alpha does code review',
  capabilities: ['code-review', 'linting'],
  namespace: 'platform',
});

const AGENT_BETA = makeManifest({
  id: '01HZB1BETA0000000000001',
  name: 'beta-agent',
  description: '',
  runtime: 'cursor',
  capabilities: ['testing'],
  namespace: 'qa',
});

// ---------------------------------------------------------------------------
// Mock Factories
// ---------------------------------------------------------------------------

function makeMockMeshCore(agents: AgentManifest[] = []) {
  return {
    get: vi.fn((id: string) => agents.find((a) => a.id === id)),
    list: vi.fn(() => agents),
  };
}

function makeMockRelay() {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'relay-msg-001', deliveredTo: 1 }),
    subscribe: vi.fn().mockReturnValue(vi.fn()),
  };
}

function makeMockDb() {
  // SqliteTaskStore calls db.select/insert/etc. but these tests never hit
  // the JSON-RPC handler's task persistence, so a minimal stub suffices.
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    }),
  };
}

const BASE_URL = 'http://localhost:4242';
const VERSION = '0.1.0';

/** Build a `message/send` JSON-RPC request body for routing-rejection tests. */
function messageSend(text: string, opts: { agentId?: string; taskId?: string } = {}) {
  return {
    jsonrpc: '2.0',
    id: 99,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'test-msg-1',
        parts: [{ kind: 'text', text }],
        ...(opts.agentId ? { metadata: { agentId: opts.agentId } } : {}),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test App Builder
// ---------------------------------------------------------------------------

interface BuildOptions {
  /** Whether cards advertise a security requirement (default false — pass-through). */
  authRequired?: boolean;
  /** Per-minute RPC/card limits (default high enough not to trip in tests). */
  rpcMaxPerMinute?: number;
  cardMaxPerMinute?: number;
}

function buildTestApp(agents: AgentManifest[] = [], options: BuildOptions = {}) {
  const meshCore = makeMockMeshCore(agents);
  const relay = makeMockRelay();
  const db = makeMockDb();

  const { rpc: rpcRateLimiter, card: cardRateLimiter } = buildA2aRateLimiters({
    rpcMaxPerMinute: options.rpcMaxPerMinute ?? 1000,
    cardMaxPerMinute: options.cardMaxPerMinute ?? 1000,
  });

  const { router, fleetCardHandler } = createA2aRouter({
    meshCore: meshCore as never,
    relay: relay as never,
    db: db as never,
    baseUrl: BASE_URL,
    version: VERSION,
    authRequired: options.authRequired ?? false,
    rpcRateLimiter,
    cardRateLimiter,
  });

  const app = express();
  app.use(express.json());
  // Mirrors index.ts: spec path (AGENT_CARD_PATH) plus the legacy alias
  app.get('/.well-known/agent-card.json', cardRateLimiter, fleetCardHandler);
  app.get('/.well-known/agent.json', cardRateLimiter, fleetCardHandler);
  app.use('/a2a', router);

  return { app, meshCore, relay, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2A Express routes', () => {
  // -----------------------------------------------------------------------
  // GET /.well-known/agent.json (Fleet Card)
  // -----------------------------------------------------------------------

  describe('GET /.well-known/agent-card.json', () => {
    it('serves the fleet card at the A2A spec well-known path', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get('/.well-known/agent-card.json');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.name).toBe('DorkOS Agent Fleet');
    });
  });

  describe('GET /.well-known/agent.json (legacy alias)', () => {
    it('returns 200 with valid JSON', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get('/.well-known/agent.json');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('returns a card with required A2A fields', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get('/.well-known/agent.json');
      const card = res.body;

      expect(card.name).toBe('DorkOS Agent Fleet');
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.url).toBe(`${BASE_URL}/a2a`);
      expect(card.version).toBe(VERSION);
      expect(card.capabilities).toEqual(
        expect.objectContaining({
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: true,
        })
      );
      expect(card.defaultInputModes).toContain('text/plain');
      expect(card.defaultOutputModes).toContain('text/plain');
    });

    it('populates skills from registered agents', async () => {
      const { app } = buildTestApp([AGENT_ALPHA, AGENT_BETA]);

      const res = await request(app).get('/.well-known/agent.json');
      const { skills } = res.body;

      expect(skills).toHaveLength(2);

      const alphaSkill = skills.find((s: { id: string }) => s.id === '01HZB1ALPHA000000000001');
      expect(alphaSkill).toBeDefined();
      expect(alphaSkill.name).toBe('alpha-agent');
      expect(alphaSkill.description).toBe('Alpha does code review');
      expect(alphaSkill.tags).toContain('claude-code');
      expect(alphaSkill.tags).toContain('platform');

      const betaSkill = skills.find((s: { id: string }) => s.id === '01HZB1BETA0000000000001');
      expect(betaSkill).toBeDefined();
      expect(betaSkill.name).toBe('beta-agent');
    });

    it('returns empty skills array when no agents are registered', async () => {
      const { app } = buildTestApp([]);

      const res = await request(app).get('/.well-known/agent.json');
      const card = res.body;

      expect(card.skills).toHaveLength(0);
      expect(card.name).toBe('DorkOS Agent Fleet');
      expect(card.description).toContain('no agents registered yet');
    });

    it('reflects current agent state on each request', async () => {
      const agents = [AGENT_ALPHA];
      const { app, meshCore } = buildTestApp(agents);

      // First request: one agent
      const res1 = await request(app).get('/.well-known/agent.json');
      expect(res1.body.skills).toHaveLength(1);

      // Simulate agent registration by updating the mock
      meshCore.list.mockReturnValue([AGENT_ALPHA, AGENT_BETA]);

      // Second request: two agents
      const res2 = await request(app).get('/.well-known/agent.json');
      expect(res2.body.skills).toHaveLength(2);
    });

    it('describes the http/bearer scheme without a requirement in pass-through mode', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get('/.well-known/agent.json');
      const card = res.body;

      expect(card.securitySchemes?.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
      expect(card.security).toBeUndefined();
    });

    it('advertises a bearer security requirement when auth is enforced', async () => {
      const { app } = buildTestApp([AGENT_ALPHA], { authRequired: true });

      const res = await request(app).get('/.well-known/agent.json');
      const card = res.body;

      expect(card.securitySchemes?.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
      expect(card.security).toEqual([{ bearerAuth: [] }]);
    });
  });

  // -----------------------------------------------------------------------
  // GET /a2a/agents/:id/card (Per-Agent Card)
  // -----------------------------------------------------------------------

  describe('GET /a2a/agents/:id/card', () => {
    it('returns 200 with a valid agent card for a known agent', async () => {
      const { app } = buildTestApp([AGENT_ALPHA, AGENT_BETA]);

      const res = await request(app).get(`/a2a/agents/${AGENT_ALPHA.id}/card`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('returns agent-specific name and description', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get(`/a2a/agents/${AGENT_ALPHA.id}/card`);
      const card = res.body;

      expect(card.name).toBe('alpha-agent');
      expect(card.description).toBe('Alpha does code review');
    });

    it('maps agent capabilities to skills', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get(`/a2a/agents/${AGENT_ALPHA.id}/card`);
      const { skills } = res.body;

      expect(skills).toHaveLength(2);

      const reviewSkill = skills.find((s: { id: string }) => s.id === 'code-review');
      expect(reviewSkill).toBeDefined();
      expect(reviewSkill.name).toBe('Code Review');
      expect(reviewSkill.tags).toContain('code-review');
      expect(reviewSkill.tags).toContain('claude-code');

      const lintSkill = skills.find((s: { id: string }) => s.id === 'linting');
      expect(lintSkill).toBeDefined();
      expect(lintSkill.name).toBe('Linting');
    });

    it('returns 404 for an unknown agent ID', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get('/a2a/agents/nonexistent-id/card');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
    });

    it('includes protocol metadata on per-agent card', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).get(`/a2a/agents/${AGENT_ALPHA.id}/card`);
      const card = res.body;

      expect(card.protocolVersion).toBe('0.3.0');
      // Per-agent card advertises the agent's own JSON-RPC endpoint (F5).
      expect(card.url).toBe(`${BASE_URL}/a2a/agents/${AGENT_ALPHA.id}`);
      expect(card.version).toBe(VERSION);
      expect(card.preferredTransport).toBe('JSONRPC');
    });

    it('returns empty skills when agent has no capabilities', async () => {
      const noCaps = makeManifest({
        id: '01HZB1NOCAPS00000000001',
        name: 'nocaps-agent',
        capabilities: [],
      });
      const { app } = buildTestApp([noCaps]);

      const res = await request(app).get(`/a2a/agents/${noCaps.id}/card`);

      expect(res.status).toBe(200);
      expect(res.body.skills).toHaveLength(0);
    });

    it('falls back to generated description when agent description is empty', async () => {
      const { app } = buildTestApp([AGENT_BETA]);

      const res = await request(app).get(`/a2a/agents/${AGENT_BETA.id}/card`);

      expect(res.body.description).toBe('DorkOS agent: beta-agent');
    });
  });

  // -----------------------------------------------------------------------
  // POST /a2a (JSON-RPC)
  // -----------------------------------------------------------------------

  describe('POST /a2a', () => {
    it('returns JSON-RPC error for unknown method', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app).post('/a2a').set('Content-Type', 'application/json').send({
        jsonrpc: '2.0',
        id: 1,
        method: 'invalid/method',
        params: {},
      });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBeDefined();
    });

    it('returns JSON-RPC response for tasks/get with nonexistent task', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app)
        .post('/a2a')
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tasks/get',
          params: { id: 'nonexistent-task-id' },
        });

      // The SDK returns a JSON-RPC response (error for missing task, or 200)
      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.id).toBe(2);
    });

    it('rejects a message with no metadata.agentId with an actionable error (never guesses)', async () => {
      const { app, relay } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app)
        .post('/a2a')
        .set('Content-Type', 'application/json')
        .send(messageSend('Hi.'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('metadata.agentId');
      // Routing is never guessed — nothing is published to a relay subject.
      expect(relay.publish).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // POST /a2a/agents/:id (per-agent JSON-RPC — deterministic binding, F5)
  // -----------------------------------------------------------------------

  describe('POST /a2a/agents/:id', () => {
    it('returns a JSON-RPC 404 error for an unknown agent', async () => {
      const { app } = buildTestApp([AGENT_ALPHA]);

      const res = await request(app)
        .post('/a2a/agents/no-such-agent')
        .set('Content-Type', 'application/json')
        .send(messageSend('Hi.'));

      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('not found');
    });

    it('rejects a metadata.agentId that conflicts with the endpoint agent', async () => {
      const { app } = buildTestApp([AGENT_ALPHA, AGENT_BETA]);

      const res = await request(app)
        .post(`/a2a/agents/${AGENT_ALPHA.id}`)
        .set('Content-Type', 'application/json')
        .send(messageSend('Hi.', { agentId: AGENT_BETA.id }));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('conflicts');
    });
  });

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  describe('rate limiting', () => {
    it('returns 429 with a JSON-RPC body once the card limit is exceeded', async () => {
      const { app } = buildTestApp([AGENT_ALPHA], { cardMaxPerMinute: 2 });
      const path = `/a2a/agents/${AGENT_ALPHA.id}/card`;

      expect((await request(app).get(path)).status).toBe(200);
      expect((await request(app).get(path)).status).toBe(200);
      const limited = await request(app).get(path);

      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe(-32029);
    });
  });
});
