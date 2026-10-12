/**
 * `/api/ext/:id/*` on the real `/api` chain: the lookup, and an extension's
 * Express router reached through the bridge (`express-bridge.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { Router } from 'express';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { bridgeExpressRouter } from '../../services/extensions/http/express-bridge.js';
import type { ExtensionHttpHandler } from '../../services/extensions/http/extension-http.js';
import { createExtensionApiRoutes, splitExtensionMount } from '../extension-api.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** A manager whose handlers this file decides. */
function createMockManager() {
  return {
    getServerHandler: vi.fn<(id: string) => ExtensionHttpHandler | null>().mockReturnValue(null),
  };
}

describe('/api/ext/:id/*', () => {
  let manager: ReturnType<typeof createMockManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockManager();
    fixtureTarget.mount(
      honoGroupListener(
        { path: '/api/ext', routes: createExtensionApiRoutes(manager) },
        {
          // Stands in for the session gate's resolved user.
          before: async (c, next) => {
            if (c.req.header('x-test-user')) {
              c.set('user', { userId: 'u1', credential: 'cookie' } as never);
            }
            await next();
          },
        }
      )
    );
  });

  /** Serve `router` as extension `id`, through the bridge. */
  function serve(routers: Record<string, Router>): void {
    const handlers = Object.fromEntries(
      Object.entries(routers).map(([id, router]) => [id, bridgeExpressRouter(router)])
    );
    manager.getServerHandler.mockImplementation((id) => handlers[id] ?? null);
  }

  it('returns 404 when the extension has no server routes', async () => {
    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Extension 'my-ext' has no server routes" });
    expect(manager.getServerHandler).toHaveBeenCalledWith('my-ext');
  });

  it('delegates GET requests to the extension router', async () => {
    const router = Router();
    router.get('/status', (_req, res) => {
      res.json({ ok: true, data: 'from-extension' });
    });
    serve({ 'my-ext': router });

    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: 'from-extension' });
  });

  it('hands the router the JSON body the chain already parsed', async () => {
    const router = Router();
    router.post('/action', (req, res) => {
      res.json({ received: req.body });
    });
    serve({ 'test-ext': router });

    const res = await request(fixtureServer)
      .post('/api/ext/test-ext/action')
      .send({ key: 'value' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { key: 'value' } });
  });

  it('leaves a body the chain does not parse for the router to read', async () => {
    const router = Router();
    router.post('/raw', (req, res) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (text += chunk));
      req.on('end', () => res.json({ text }));
    });
    serve({ 'test-ext': router });

    const res = await request(fixtureServer)
      .post('/api/ext/test-ext/raw')
      .set('content-type', 'text/plain')
      .send('just words');

    expect(res.body).toEqual({ text: 'just words' });
  });

  it('shows the router its mount, nested paths and its own params', async () => {
    const router = Router();
    router.get('/deep/:item/path', (req, res) => {
      res.json({ baseUrl: req.baseUrl, path: req.path, params: req.params });
    });
    serve({ 'my-ext': router });

    const res = await request(fixtureServer).get('/api/ext/my-ext/deep/thing/path?x=1');

    expect(res.body).toEqual({
      baseUrl: '/api/ext/my-ext',
      path: '/deep/thing/path',
      params: { item: 'thing' },
    });
  });

  it('handles the root path of the extension router', async () => {
    const router = Router();
    router.get('/', (_req, res) => {
      res.json({ root: true });
    });
    serve({ 'my-ext': router });

    const res = await request(fixtureServer).get('/api/ext/my-ext');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: true });
  });

  it('gives a path the router does not serve the /api 404', async () => {
    serve({ 'my-ext': Router() });

    const res = await request(fixtureServer).get('/api/ext/my-ext/nothing');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'API_NOT_FOUND' });
  });

  it('answers a route that throws, rejects or hands on an error with the chain’s error', async () => {
    const router = Router();
    router.get('/throws', () => {
      throw new Error('sync failure');
    });
    router.get('/rejects', async () => {
      throw new Error('async failure');
    });
    router.get('/next', (_req, _res, next) => next(new Error('handed on')));
    serve({ 'my-ext': router });

    for (const [path, message] of [
      ['/throws', 'sync failure'],
      ['/rejects', 'async failure'],
      ['/next', 'handed on'],
    ]) {
      const res = await request(fixtureServer).get(`/api/ext/my-ext${path}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: message, code: 'INTERNAL_ERROR' });
    }
  });

  it('puts the caller the chain resolved on res.locals', async () => {
    const router = Router();
    router.get('/who', (_req, res) => {
      res.json({ user: res.locals.user ?? null });
    });
    serve({ 'my-ext': router });

    const anonymous = await request(fixtureServer).get('/api/ext/my-ext/who');
    const signedIn = await request(fixtureServer)
      .get('/api/ext/my-ext/who')
      .set('x-test-user', '1');

    expect(anonymous.body).toEqual({ user: null });
    expect(signedIn.body).toEqual({ user: { userId: 'u1', credential: 'cookie' } });
  });

  it('sends no X-Powered-By header', async () => {
    const router = Router();
    router.get('/status', (_req, res) => {
      res.json({ ok: true });
    });
    serve({ 'my-ext': router });

    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('isolates requests between different extensions', async () => {
    const a = Router();
    a.get('/data', (_req, res) => {
      res.json({ source: 'ext-a' });
    });
    const b = Router();
    b.get('/data', (_req, res) => {
      res.json({ source: 'ext-b' });
    });
    serve({ 'ext-a': a, 'ext-b': b });

    const resA = await request(fixtureServer).get('/api/ext/ext-a/data');
    const resB = await request(fixtureServer).get('/api/ext/ext-b/data');

    expect(resA.body).toEqual({ source: 'ext-a' });
    expect(resB.body).toEqual({ source: 'ext-b' });
  });
});

describe('splitExtensionMount', () => {
  it('splits the mount from the path below it, keeping the path percent-encoded', () => {
    expect(splitExtensionMount('http://localhost/api/ext/my-ext/a%20b/c?x=1', 'my-ext')).toEqual({
      mount: '/api/ext/my-ext',
      subPath: '/a%20b/c',
    });
    expect(splitExtensionMount('http://localhost/api/ext/my-ext', 'my-ext')).toEqual({
      mount: '/api/ext/my-ext',
      subPath: '/',
    });
  });
});
