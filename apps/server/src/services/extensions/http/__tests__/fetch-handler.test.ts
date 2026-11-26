/**
 * An extension's `fetch` handler behind `/api/ext/:id/*`, on the real `/api`
 * chain: what the handler is given, and what the caller gets back.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { Router } from 'express';
import { Hono } from 'hono';
import {
  requirePerson,
  type ExtensionCaller,
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
import { assessPerson } from '../../../../routes/extensions-person-bar.js';
import { setExtensionPersonBar } from '../../inbox/extension-inbox-context.js';

// The person bar every extension route runs, wired as boot wires it.
setExtensionPersonBar(assessPerson);

const fixtureTarget = swappableServer();
const server = fixtureTarget.server;

/**
 * Serve `handler` as extension `my-ext`, behind the front door as the running
 * server does: the door hands each request on as a `Request` of its own,
 * which a handler must never make read the incoming stream again.
 */
function serve(handler: ExtensionHttpHandler): void {
  fixtureTarget.mount(
    honoGroupListener({
      path: '/api/ext',
      routes: createExtensionApiRoutes({
        getServerHandler: (id) => (id === 'my-ext' ? handler : null),
      }),
    })
  );
}

/**
 * Send `target` exactly as written, which supertest would tidy: an
 * absolute-form target, or one with dot segments.
 */
function rawGet(target: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: target,
        headers: { host: `localhost:${port}` },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
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
    host: url.host,
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

  it('never gets a URL off the app’s own origin from a doubled slash', async () => {
    const res = await request(server).get('/api/ext/my-ext//evil.com/login?x=1');

    expect(res.body.host).not.toBe('evil.com');
    expect(res.body).toMatchObject({ path: '//evil.com/login', search: '?x=1' });
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

  it('answers a body over 1 MB with 413, before the handler runs', async () => {
    const handler = vi.fn(describeRequest);
    serve(createFetchHandler('My Extension', handler));

    const res = await request(server)
      .put('/api/ext/my-ext/notes')
      .set('content-type', 'text/plain')
      .send('x'.repeat(1024 * 1024 + 1));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: 'request_too_large',
      detail: 'That request is too large.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers a streamed body that grows past 1 MB with 413, before the handler runs', async () => {
    const handler = vi.fn(describeRequest);
    serve(createFetchHandler('My Extension', handler));
    const { port } = server.address() as AddressInfo;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/ext/my-ext/upload',
          headers: { 'content-type': 'application/octet-stream' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      const chunk = Buffer.alloc(256 * 1024, 1);
      for (let i = 0; i < 5; i++) req.write(chunk);
      req.end();
    });

    expect(status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
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

  it('moves a redirect to one of its own paths under its mount, never onto a DorkOS route', async () => {
    serve(
      createFetchHandler(
        'My Extension',
        () => new Response(null, { status: 302, headers: { location: '/api/config?x=1' } })
      )
    );

    const res = await request(server).get('/api/ext/my-ext/go').redirects(0);

    expect(res.headers.location).toBe('/api/ext/my-ext/api/config?x=1');
  });

  it('answers a handler that throws with the chain’s error, and keeps serving', async () => {
    serve(
      createFetchHandler('My Extension', () => {
        throw new Error('the handler broke');
      })
    );

    const res = await request(server).get('/api/ext/my-ext/anything');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(res.body)).not.toContain('the handler broke');
  });
});

describe('the headers a fetch handler’s answer may carry', () => {
  it('keeps content and caching headers and other x- headers', async () => {
    serve(
      createFetchHandler(
        'My Extension',
        () =>
          new Response('{}', {
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              etag: '"v1"',
              'x-ext': 'kept',
            },
          })
      )
    );

    const res = await request(server).get('/api/ext/my-ext/data');

    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBe('"v1"');
    expect(res.headers['x-ext']).toBe('kept');
  });

  it('drops anything DorkOS’s origin would act on, and always sandboxes the answer', async () => {
    const headers = new Headers({
      'clear-site-data': '"cookies"',
      refresh: '0;url=https://evil.example',
      'www-authenticate': 'Basic realm="x"',
      'access-control-allow-origin': 'https://evil.example',
      'content-security-policy': "default-src *; script-src 'unsafe-inline'",
      'strict-transport-security': 'max-age=0',
      'x-dorkos-agent': 'agent-1',
    });
    headers.append('set-cookie', 'dorkos.session=stolen; Path=/');
    headers.append('set-cookie', 'other=1; Path=/');
    serve(createFetchHandler('My Extension', () => new Response('ok', { headers })));

    const res = await request(server).get('/api/ext/my-ext/data');

    expect(res.text).toBe('ok');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['clear-site-data']).toBeUndefined();
    expect(res.headers.refresh).toBeUndefined();
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['x-dorkos-agent']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe(
      "sandbox; default-src 'none', frame-ancestors 'none'"
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each([
    ['another site', 'https://evil.example/login'],
    ['a protocol-relative host', '//evil.example/login'],
    ['a script', 'javascript:alert(1)'],
    ['a path with a backslash', '/\\evil.example/login'],
  ])('drops a redirect to %s', async (_label, location) => {
    serve(
      createFetchHandler(
        'My Extension',
        () => new Response(null, { status: 302, headers: { location } })
      )
    );

    const res = await request(server).get('/api/ext/my-ext/go').redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBeUndefined();
  });
});

describe('who is asking, as a fetch handler is told', () => {
  /** A handler that answers with the caller it was given. */
  const describeCaller: ExtensionFetchHandler = (_req, caller) =>
    Response.json({ caller, frozen: Object.isFrozen(caller) && Object.isFrozen(caller.person) });

  beforeEach(() => {
    serve(createFetchHandler('My Extension', describeCaller));
  });

  it('tells it a person is asking', async () => {
    const res = await request(server).get('/api/ext/my-ext/who');

    expect(res.body).toEqual({ caller: { person: { ok: true } }, frozen: true });
  });

  it('tells it an agent is not a person, with the refusal worded for this extension', async () => {
    const res = await request(server).get('/api/ext/my-ext/who').set('x-dorkos-agent', 'agent-1');

    expect(res.body.caller).toEqual({
      person: {
        ok: false,
        status: 403,
        body: {
          type: 'urn:dorkos:problem:person_only',
          title: expect.any(String),
          status: 403,
          code: 'person_only',
          detail: expect.stringContaining('Only a person can change My Extension'),
        },
      },
    });
  });
});

describe('a Hono app as the fetch handler', () => {
  /** A Hono app with one open route and one only a person may use. */
  function settingsApp(): Hono<{ Bindings: ExtensionCaller }> {
    const app = new Hono<{ Bindings: ExtensionCaller }>();
    app.get('/settings', (c) => c.json({ theme: 'dark', person: c.env.person.ok }));
    app.put('/settings', requirePerson(), async (c) => c.json({ saved: await c.req.json() }));
    return app;
  }

  it('lets a person through requirePerson()', async () => {
    serve(createFetchHandler('My Extension', settingsApp().fetch));

    const res = await request(server).put('/api/ext/my-ext/settings').send({ theme: 'light' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: { theme: 'light' } });
  });

  it('answers an agent at requirePerson() with the extension’s own words, and never runs the route', async () => {
    const app = settingsApp();
    const route = vi.fn();
    app.put('/other', requirePerson(), (c) => {
      route();
      return c.json({});
    });
    serve(createFetchHandler('My Extension', app.fetch));

    const settings = await request(server)
      .put('/api/ext/my-ext/settings')
      .set('x-dorkos-agent', 'agent-1')
      .send({ theme: 'light' });
    const other = await request(server)
      .put('/api/ext/my-ext/other')
      .set('x-dorkos-agent', 'agent-1');
    const read = await request(server)
      .get('/api/ext/my-ext/settings')
      .set('x-dorkos-agent', 'agent-1');

    expect(settings.status).toBe(403);
    expect(settings.headers['content-type']).toBe('application/problem+json');
    expect(settings.body).toMatchObject({
      code: 'person_only',
      detail: expect.stringContaining("Only a person can change My Extension's settings."),
    });
    expect(other.status).toBe(403);
    expect(route).not.toHaveBeenCalled();
    // A route without the bar still answers, and can read the caller itself.
    expect(read.body).toEqual({ theme: 'dark', person: false });
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

describe('the mount and path a handler is given', () => {
  beforeEach(() => {
    serve(async ({ mount, subPath }) => Response.json({ mount, subPath }));
  });

  it('names the extension that serves the request, after dot segments are resolved', async () => {
    const res = await rawGet('/api/ext/other/../my-ext/x');

    expect(res.body).toEqual({ mount: '/api/ext/my-ext', subPath: '/x' });
  });
});
