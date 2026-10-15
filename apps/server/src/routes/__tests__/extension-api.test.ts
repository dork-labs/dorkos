/**
 * `/api/ext/:id/*` on the real `/api` chain: the lookup, and an extension's
 * fetch handler (`fetch-handler.ts`) reached through it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { Hono } from 'hono';
import type { ExtensionCaller } from '@dorkos/extension-api/server';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { ExtensionHttpHandler } from '../../services/extensions/http/extension-http.js';
import { createFetchHandler } from '../../services/extensions/http/fetch-handler.js';
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
      honoGroupListener({ path: '/api/ext', routes: createExtensionApiRoutes(manager) })
    );
  });

  /** Serve each Hono `app` as extension `id`, through its fetch handler. */
  function serve(apps: Record<string, Hono<{ Bindings: ExtensionCaller }>>): void {
    const handlers = Object.fromEntries(
      Object.entries(apps).map(([id, app]) => [id, createFetchHandler(id, app.fetch)])
    );
    manager.getServerHandler.mockImplementation((id) => handlers[id] ?? null);
  }

  it('returns 404 when the extension has no server routes', async () => {
    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Extension 'my-ext' has no server routes" });
    expect(manager.getServerHandler).toHaveBeenCalledWith('my-ext');
  });

  it('delegates GET requests to the extension', async () => {
    const app = new Hono<{ Bindings: ExtensionCaller }>();
    app.get('/status', (c) => c.json({ ok: true, data: 'from-extension' }));
    serve({ 'my-ext': app });

    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: 'from-extension' });
  });

  it('hands it the JSON body the chain already parsed, as JSON', async () => {
    const app = new Hono<{ Bindings: ExtensionCaller }>();
    app.post('/action', async (c) => c.json({ received: await c.req.json() }));
    serve({ 'test-ext': app });

    const res = await request(fixtureServer)
      .post('/api/ext/test-ext/action')
      .send({ key: 'value' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: { key: 'value' } });
  });

  it('hands it a body the chain does not parse as it was sent', async () => {
    const app = new Hono<{ Bindings: ExtensionCaller }>();
    app.post('/raw', async (c) => c.json({ text: await c.req.text() }));
    serve({ 'test-ext': app });

    const res = await request(fixtureServer)
      .post('/api/ext/test-ext/raw')
      .set('content-type', 'text/plain')
      .send('just words');

    expect(res.body).toEqual({ text: 'just words' });
  });

  it('shows it nested paths, its own params and the query, below the mount', async () => {
    const app = new Hono<{ Bindings: ExtensionCaller }>();
    app.get('/deep/:item/path', (c) =>
      c.json({ path: c.req.path, item: c.req.param('item'), x: c.req.query('x') })
    );
    serve({ 'my-ext': app });

    const res = await request(fixtureServer).get('/api/ext/my-ext/deep/thing/path?x=1');

    expect(res.body).toEqual({ path: '/deep/thing/path', item: 'thing', x: '1' });
  });

  it('handles the root path of the extension', async () => {
    const app = new Hono<{ Bindings: ExtensionCaller }>();
    app.get('/', (c) => c.json({ root: true }));
    serve({ 'my-ext': app });

    const res = await request(fixtureServer).get('/api/ext/my-ext');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: true });
  });

  it('gives a request every handler passes on the /api 404', async () => {
    manager.getServerHandler.mockReturnValue(async () => null);

    const res = await request(fixtureServer).get('/api/ext/my-ext/nothing');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'API_NOT_FOUND' });
  });

  it('answers a handler that throws or rejects with the chain’s error', async () => {
    for (const [id, fetch] of [
      [
        'throws',
        () => {
          throw new Error('sync failure');
        },
      ],
      ['rejects', async () => Promise.reject(new Error('async failure'))],
    ] as const) {
      manager.getServerHandler.mockImplementation(() => createFetchHandler(id, fetch));
      const res = await request(fixtureServer).get(`/api/ext/${id}/x`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: id === 'throws' ? 'sync failure' : 'async failure',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  it('sends no X-Powered-By header, and sandboxes the answer', async () => {
    const app = new Hono<{ Bindings: ExtensionCaller }>();
    app.get('/status', (c) => c.json({ ok: true }));
    serve({ 'my-ext': app });

    const res = await request(fixtureServer).get('/api/ext/my-ext/status');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('isolates requests between different extensions', async () => {
    const a = new Hono<{ Bindings: ExtensionCaller }>();
    a.get('/data', (c) => c.json({ source: 'ext-a' }));
    const b = new Hono<{ Bindings: ExtensionCaller }>();
    b.get('/data', (c) => c.json({ source: 'ext-b' }));
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
