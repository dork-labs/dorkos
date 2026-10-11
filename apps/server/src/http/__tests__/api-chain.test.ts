/**
 * The two places a moving route group plugs into the Hono chain
 * (`http/api-chain.ts`): routes that must answer before the body is read and
 * before the session gate (Better Auth, signed webhooks), and path-scoped body
 * parsers. The Express chain has both by mount order; these pin that the Hono
 * chain gives a route the same position.
 *
 * Everything else the chain does is held to the Express chain cell for cell
 * by `api-chain-parity.test.ts`.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bodyParser from 'body-parser';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { getRequestListener } from '@hono/node-server';
import request from '@dorkos/test-utils/supertest';

const state = vi.hoisted(() => ({ login: false }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
    set: vi.fn(),
  },
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createApiApp } from '../api-chain.js';
import { readJsonBody, type BodyRule } from '../request-body.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';

const LOOPBACK = 'localhost:4242';
/** Two megabytes of JSON: over the app-wide limit, under the rule's. */
const BIG_BODY = JSON.stringify({ pad: 'x'.repeat(1536 * 1024) });

const recorded: unknown[] = [];

/** A larger limit for one path, the way feedback screenshots get one on Express. */
const largeUploads: BodyRule = {
  matches: (_method, path) => path.toLowerCase().startsWith('/api/large/'),
  parse: bodyParser.json({ limit: '2mb' }),
};

function buildApp() {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    bodyRules: [largeUploads],
    beforeBodyParsing: (early) => {
      early.post('/api/early/echo', async (c) =>
        c.json({ raw: await c.req.text(), user: c.get('user') ?? null })
      );
    },
  });
  app.post('/api/large/echo', (c) => c.json({ size: JSON.stringify(readJsonBody(c)).length }));
  app.post('/api/normal/echo', (c) => c.json({ body: readJsonBody(c, { emptyAs: {} }) }));
  return app;
}

const server = listeningServer(
  getRequestListener(buildApp().fetch, { overrideGlobalObjects: false, autoCleanupIncoming: false })
);

beforeAll(() => {
  const actor = { type: 'person', id: 'owner', name: 'owner' };
  initAuditTrail({
    log: { record: (input: unknown) => (recorded.push(input), input) },
    accounts: { owner: () => actor, forUser: () => actor, system: () => actor },
  } as never);
});
afterAll(() => resetAuditTrail());
beforeEach(() => {
  state.login = false;
  recorded.length = 0;
});

describe('routes registered before the body is parsed', () => {
  it('reach their handler with the body unread and no session gate in front', async () => {
    state.login = true;
    const res = await request(server)
      .post('/api/early/echo')
      .set('Host', LOOPBACK)
      .set('Content-Type', 'application/json')
      .send('{"read":"by the route itself"}');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ raw: '{"read":"by the route itself"}', user: null });
  });

  it('leave no audit fallback row, as Better Auth leaves none on Express', async () => {
    await request(server).post('/api/early/echo').set('Host', LOOPBACK).send('{}');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recorded).toEqual([]);
  });

  it('still sit behind the host guard', async () => {
    const res = await request(server).post('/api/early/echo').set('Host', 'rebound.example');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HOST_NOT_ALLOWED');
  });
});

describe('path-scoped body rules', () => {
  it('replace the app-wide parser on their own paths', async () => {
    const res = await request(server)
      .post('/api/large/echo')
      .set('Host', LOOPBACK)
      .set('Content-Type', 'application/json')
      .send(BIG_BODY);
    expect(res.status).toBe(200);
    expect(res.body.size).toBe(BIG_BODY.length);
  });

  it('leave every other path on the app-wide 1 MB limit', async () => {
    const res = await request(server)
      .post('/api/normal/echo')
      .set('Host', LOOPBACK)
      .set('Content-Type', 'application/json')
      .send(BIG_BODY);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: 'That is too large to send in one request.',
      code: 'REQUEST_TOO_LARGE',
    });
  });

  it('read a request with no body as what the route asks for', async () => {
    const res = await request(server).post('/api/normal/echo').set('Host', LOOPBACK);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: {} });
  });
});
