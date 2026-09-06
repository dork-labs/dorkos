/**
 * @vitest-environment node
 *
 * The Agent Card and the gate have to agree (DOR-1824).
 *
 * An A2A peer reads the card, sees `securityRequirements`, and decides from it
 * whether to attach a credential. The card used to derive that field from
 * `authConfigured` — a NETWORK-reachable credential (`MCP_API_KEY`, the legacy
 * compat key, or login) — which deliberately excludes the per-instance local
 * token. In the default login-off posture the card therefore advertised nothing
 * while every JSON-RPC `POST` demanded the local token, so a client that
 * trusted the card got a `401` it had been told not to expect.
 *
 * This file pins the invariant across all three postures the surface has: the
 * served card advertises the bearer requirement, AND an uncredentialed `POST` is
 * refused. Neither assertion alone is the property — a card can only be honest
 * relative to what the gate actually does, so both are asserted together.
 *
 * NOTE: this file resolves @dorkos/a2a-gateway from its built dist — run
 * `pnpm --filter @dorkos/a2a-gateway build` first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// Mock env before importing the middleware, so MCP_API_KEY is drivable.
vi.mock('../env.js', () => ({
  env: {
    MCP_API_KEY: undefined as string | undefined,
  },
}));

vi.mock('../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn() },
}));

// The shared credential verifier (session cookie → per-user Better Auth key).
// Mocked so the login-on posture can be driven without a live auth instance;
// the real end-to-end path is covered by mcp-auth.integration.test.ts.
vi.mock('../services/core/auth/index.js', () => ({
  verifyRequestAuth: vi.fn(),
}));

// The per-instance local token — mocked to a known value so the login-off
// acceptor is deterministic and never touches the filesystem.
vi.mock('../services/core/auth/mcp-local-token.js', () => ({
  getMcpLocalToken: vi.fn(),
  getMcpLocalTokenPath: vi.fn(),
}));

import { createA2aRouter } from '../routes/a2a.js';
import { createMcpAuth } from '../middleware/mcp-auth.js';
import { buildA2aRateLimiters } from '../middleware/a2a-rate-limit.js';
import { env } from '../env.js';
import { configManager } from '../services/core/config-manager.js';
import { verifyRequestAuth } from '../services/core/auth/index.js';
import { getMcpLocalToken, getMcpLocalTokenPath } from '../services/core/auth/mcp-local-token.js';

const fixtureTarget = swappableServer();

/** A valid local token (dork_mcp_local_ + 64 hex) the login-off acceptor takes. */
const LOCAL_TOKEN = `dork_mcp_local_${'a'.repeat(64)}`;
/** A static headless-deployment override key. */
const ENV_KEY = 'env-key-value';
const BASE_URL = 'http://localhost:4242';
const VERSION = '0.1.0';

const AGENT: AgentManifest = {
  workspace: { mode: 'home' },
  id: '01HZB1ALPHA000000000001',
  name: 'alpha-agent',
  description: 'Alpha does code review',
  runtime: 'claude-code',
  capabilities: ['code-review'],
  behavior: { responseMode: 'always' },
  namespace: 'platform',
  registeredAt: '2026-03-22T00:00:00.000Z',
  registeredBy: 'kai',
  personaEnabled: true,
  enabledToolGroups: {},
  mcpServers: [],
};

/** Mock configManager.get keyed by the two keys the middleware reads. */
function mockConfig(opts: { authEnabled?: boolean } = {}): void {
  vi.mocked(configManager.get).mockImplementation((key: string) => {
    if (key === 'mcp') return { apiKey: null } as never;
    if (key === 'auth') return { enabled: opts.authEnabled ?? false } as never;
    return undefined as never;
  });
}

/**
 * The A2A chain exactly as `index.ts` wires it: rate limiter, then the real
 * `createMcpAuth({ surface: 'a2a' })`, then the real router. Only Mesh, Relay
 * and the DB are stubs — nothing about auth or card generation is faked.
 */
function buildApp(): express.Express {
  const { rpc: rpcRateLimiter, card: cardRateLimiter } = buildA2aRateLimiters({
    rpcMaxPerMinute: 1000,
    cardMaxPerMinute: 1000,
  });

  const { router, fleetCardHandler } = createA2aRouter({
    meshCore: {
      get: (id: string) => (id === AGENT.id ? AGENT : undefined),
      list: () => [AGENT],
    } as never,
    relay: { publish: vi.fn(), subscribe: vi.fn(() => vi.fn()) } as never,
    db: {
      select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
    } as never,
    baseUrl: BASE_URL,
    version: VERSION,
    rpcRateLimiter,
    cardRateLimiter,
  });

  const a2aAuth = createMcpAuth({ surface: 'a2a' });
  const app = express();
  app.use(express.json());
  app.get('/.well-known/agent-card.json', cardRateLimiter, a2aAuth, fleetCardHandler);
  app.use('/a2a', a2aAuth, router);
  return app;
}

/** The bearer requirement a card must carry — protobuf JSON drops the empty scope list. */
const BEARER_REQUIREMENT = [{ schemes: { bearerAuth: {} } }];

/** Where this instance's credential lives, and the credential values themselves. */
const CREDENTIAL_LEAK_PATTERN = new RegExp(
  [LOCAL_TOKEN, ENV_KEY, 'dork_mcp_local_', 'mcp-local-token', '\\.dork\\b'].join('|')
);

/**
 * Assert the served card bytes carry the bearer requirement and leak nothing
 * about where the credential comes from. Measured over the WHOLE response body,
 * not just the scheme description: the promise is about the card, so a field
 * added later that named a token path has to red here (DOR-1824 review).
 */
function expectHonestCard(body: unknown): void {
  expect((body as { securityRequirements?: unknown }).securityRequirements).toEqual(
    BEARER_REQUIREMENT
  );
  expect(JSON.stringify(body)).not.toMatch(CREDENTIAL_LEAK_PATTERN);
}

/** A `message/send` body with no target — routing rejects it AFTER auth passes. */
const UNTARGETED_SEND = {
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'test-msg-1',
      parts: [{ kind: 'text', text: 'Hi.' }],
    },
  },
};

beforeEach(() => {
  (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = undefined;
  vi.mocked(configManager.get).mockReturnValue(undefined as never);
  vi.mocked(verifyRequestAuth).mockResolvedValue(null);
  vi.mocked(getMcpLocalToken).mockReturnValue(LOCAL_TOKEN);
  vi.mocked(getMcpLocalTokenPath).mockReturnValue('/tmp/dork/mcp-local-token');
});

describe('the Agent Card is honest about the gate — posture: login off, local token', () => {
  it('advertises the bearer requirement on a card anyone may read', async () => {
    mockConfig({ authEnabled: false });
    const server = fixtureTarget.mount(buildApp());

    const res = await request(server).get('/.well-known/agent-card.json');

    // The card GET itself stays credential-free here (ADR 260717-021653): the
    // requirement describes contacting the AGENT — the interfaces the card
    // lists — not fetching the discovery document.
    expect(res.status).toBe(200);
    expectHonestCard(res.body);
  });

  it('refuses an uncredentialed POST — which is what the card just warned about', async () => {
    mockConfig({ authEnabled: false });
    const server = fixtureTarget.mount(buildApp());

    const res = await request(server)
      .post('/a2a')
      .set('Content-Type', 'application/json')
      .send(UNTARGETED_SEND);

    expect(res.status).toBe(401);
  });

  it('lets the advertised credential through to routing', async () => {
    mockConfig({ authEnabled: false });
    const server = fixtureTarget.mount(buildApp());

    const res = await request(server)
      .post('/a2a')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${LOCAL_TOKEN}`)
      .send(UNTARGETED_SEND);

    // Past auth: the fleet endpoint's own untargeted-message rejection, not 401.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
  });
});

describe('the Agent Card is honest about the gate — posture: MCP_API_KEY', () => {
  it('advertises the bearer requirement and refuses an uncredentialed POST', async () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = ENV_KEY;
    mockConfig({ authEnabled: false });
    const server = fixtureTarget.mount(buildApp());

    const card = await request(server).get('/.well-known/agent-card.json');
    expect(card.status).toBe(200);
    expectHonestCard(card.body);

    const rpc = await request(server)
      .post('/a2a')
      .set('Content-Type', 'application/json')
      .send(UNTARGETED_SEND);
    expect(rpc.status).toBe(401);
  });

  it('lets the static key through to routing', async () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = ENV_KEY;
    mockConfig({ authEnabled: false });
    const server = fixtureTarget.mount(buildApp());

    const res = await request(server)
      .post('/a2a')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${ENV_KEY}`)
      .send(UNTARGETED_SEND);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
  });
});

describe('the Agent Card is honest about the gate — posture: login on', () => {
  it('advertises the bearer requirement on the card a credentialed peer fetches', async () => {
    mockConfig({ authEnabled: true });
    vi.mocked(verifyRequestAuth).mockResolvedValue({ userId: 'user-1' } as never);
    const server = fixtureTarget.mount(buildApp());

    const res = await request(server)
      .get('/.well-known/agent-card.json')
      .set('Authorization', 'Bearer per-user-key');

    expect(res.status).toBe(200);
    expectHonestCard(res.body);
  });

  it('refuses an uncredentialed POST', async () => {
    mockConfig({ authEnabled: true });
    const server = fixtureTarget.mount(buildApp());

    const res = await request(server)
      .post('/a2a')
      .set('Content-Type', 'application/json')
      .send(UNTARGETED_SEND);

    expect(res.status).toBe(401);
  });

  it('refuses an uncredentialed card GET too — login closes discovery', async () => {
    mockConfig({ authEnabled: true });
    const server = fixtureTarget.mount(buildApp());

    const res = await request(server).get('/.well-known/agent-card.json');

    expect(res.status).toBe(401);
  });
});
