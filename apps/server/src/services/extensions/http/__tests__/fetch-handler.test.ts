/**
 * An extension's `fetch` handler behind `/api/ext/:id/*`, on the real `/api`
 * chain: what the handler is given, and what the caller gets back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { Router } from 'express';
import { Hono } from 'hono';
import {
  readRegisterResult,
  serverEntryRegister,
  type ExtensionFetchHandler,
} from '@dorkos/extension-api/server';

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { createExtensionApiRoutes } from '../../../../routes/extension-api.js';
import { bridgeExpressRouter } from '../express-bridge.js';
import { firstAnswer, type ExtensionHttpHandler } from '../extension-http.js';
import { createFetchHandler } from '../fetch-handler.js';

const fixtureTarget = swappableServer();
const server = fixtureTarget.server;

/**
 * Serve `handler` as extension `my-ext`, behind the front door as the running
 * server does: the door hands each request on as a `Request` of its own,
 * which a handler must never make read the incoming stream again.
 */
function serve(handler: ExtensionHttpHandler): void {
  fixtureTarget.mount(
    honoGroupListener(
      {
        path: '/api/ext',
        routes: createExtensionApiRoutes({
          getServerHandler: (id) => (id === 'my-ext' ? handler : null),
        }),
      },
      { legacy: (_req, res) => res.end('legacy') }
    )
  );
}

/** A handler that describes the request it was given. */
const describeRequest: ExtensionFetchHandler = async (req) => {
  const url = new URL(req.url);
  return Response.json({
    method: req.method,
    path: url.pathname,
    search: url.search,
    contentType: req.headers.get('content-type'),
    custom: req.headers.get('x-custom'),
    body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.text(),
  });
};

describe('an extension served with a fetch handler', () => {
  beforeEach(() => {
    serve(createFetchHandler('My Extension', describeRequest));
  });

  it('gets the path below its mount, with the query', async () => {
    const res = await request(server).get('/api/ext/my-ext/items/7?page=2').set('x-custom', 'yes');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      method: 'GET',
      path: '/items/7',
      search: '?page=2',
      custom: 'yes',
    });
  });

  it('gets / at its mount itself', async () => {
    const res = await request(server).get('/api/ext/my-ext');

    expect(res.body).toMatchObject({ path: '/', search: '' });
  });

  it('gets a JSON body the chain already parsed, as JSON again', async () => {
    const res = await request(server)
      .post('/api/ext/my-ext/things')
      .send({ name: 'one', n: [1, 2] });

    expect(res.body).toMatchObject({
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ name: 'one', n: [1, 2] }),
    });
  });

  it('gets a body the chain does not parse as the caller sent it', async () => {
    const res = await request(server)
      .put('/api/ext/my-ext/notes')
      .set('content-type', 'text/plain')
      .send('just words');

    expect(res.body).toMatchObject({ method: 'PUT', body: 'just words' });
  });

  it('answers with whatever the handler answered, behind the chain’s own headers', async () => {
    serve(
      createFetchHandler(
        'My Extension',
        () => new Response('teapot', { status: 418, headers: { 'x-ext': 'kept' } })
      )
    );

    const res = await request(server).get('/api/ext/my-ext/anything');

    expect(res.status).toBe(418);
    expect(res.text).toBe('teapot');
    expect(res.headers['x-ext']).toBe('kept');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('can answer with a Response whose headers are locked', async () => {
    serve(createFetchHandler('My Extension', () => Response.redirect('http://localhost/x', 302)));

    const res = await request(server).get('/api/ext/my-ext/go').redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost/x');
  });

  it('answers a handler that throws with the chain’s error, and keeps serving', async () => {
    serve(
      createFetchHandler('My Extension', () => {
        throw new Error('the handler broke');
      })
    );

    const res = await request(server).get('/api/ext/my-ext/anything');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'the handler broke', code: 'INTERNAL_ERROR' });
  });

  it('answers a handler that answers with no Response with the chain’s error', async () => {
    serve(createFetchHandler('My Extension', (() => ({ ok: true })) as never));

    const res = await request(server).get('/api/ext/my-ext/anything');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('My Extension answered with something that is not a Response.');
  });
});

describe('a Hono app as the fetch handler', () => {
  it('serves its routes below the mount, exported as the entry’s default', async () => {
    const app = new Hono();
    app.get('/status', (c) => c.json({ ok: true, q: c.req.query('q') }));
    app.post('/items', async (c) => c.json({ got: await c.req.json() }, 201));
    const register = serverEntryRegister({ default: app });
    const { fetch } = readRegisterResult(await register!({} as never, {} as never));
    serve(createFetchHandler('My Extension', fetch!));

    const status = await request(server).get('/api/ext/my-ext/status?q=yes');
    const created = await request(server).post('/api/ext/my-ext/items').send({ a: 1 });
    const missing = await request(server).get('/api/ext/my-ext/nothing');

    expect(status.body).toEqual({ ok: true, q: 'yes' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ got: { a: 1 } });
    expect(missing.status).toBe(404);
  });
});

describe('a router and a fetch handler together', () => {
  it('asks the router first, and gives the fetch handler what it passes on', async () => {
    const router = Router();
    router.get('/from-router', (_req, res) => {
      res.json({ from: 'router' });
    });
    serve(
      firstAnswer(
        bridgeExpressRouter(router),
        createFetchHandler('My Extension', () => Response.json({ from: 'fetch' }))
      )
    );

    expect((await request(server).get('/api/ext/my-ext/from-router')).body).toEqual({
      from: 'router',
    });
    expect((await request(server).get('/api/ext/my-ext/other')).body).toEqual({ from: 'fetch' });
  });

  it('never runs Express for a router with no routes', async () => {
    const handled = await bridgeExpressRouter(Router())({
      c: {} as never,
      mount: '/api/ext/my-ext',
      subPath: '/x',
    });

    expect(handled).toBeNull();
  });
});
