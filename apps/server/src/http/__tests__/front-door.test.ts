/**
 * The front door must be invisible: every request reaches the server's Hono
 * app and leaves as the app answered it, on real sockets.
 *
 * Each case drives real sockets through `createFrontDoorServer`, because the
 * failures this guards against only exist on the wire: a body drained while a
 * route still reads it, a stream cut short, the process-wide `Request`
 * swapped for the adapter's own, an upgrade that never reaches the router, a
 * request the adapter cannot read answered with a bare 400.
 */
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http, { type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { collectDurableEvents } from '@dorkos/test-utils/sse-test-helpers';
import { KeepAwakeStatusSchema } from '@dorkos/shared/schemas';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { attachUpgradeRouter } from '../../services/core/streams/upgrade-router.js';
import { createFrontDoorServer, frontDoorListener } from '../front-door.js';
import type { ApiEnv } from '../api-chain.js';
import { composeFrontDoor } from '../hono-api.js';
import { streamToNodeResponse } from '../raw-node-stream.js';

const TWO_MB = 2 * 1024 * 1024;

/** Every event the fixture stream can send, numbered from 1. */
const STREAM_EVENTS = 5;

/** Requests the fixture app saw end, by path. Filled by the `close` listener. */
const closedRequests: string[] = [];

/** The digest of some bytes, as the fixture reports it. */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A stand-in for the real app: the features the front door must not disturb. */
function fixtureApp(): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.post('/raw', async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    return c.json({ bytes: body.length, sha256: sha256(body) });
  });
  app.post('/json', async (c) => {
    const body = (await c.req.json()) as { blob: string };
    return c.json({ length: body.blob.length });
  });
  // Refuses an oversize body from its declared length, without reading it.
  app.post('/small', (c) =>
    Number(c.req.header('content-length') ?? 0) > 1024
      ? c.json({ error: 'too large' }, 413)
      : c.json({ ok: true })
  );
  app.post('/upload', async (c) => {
    const form = await c.req.formData();
    const file = form.get('file') as File;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return c.json({
      field: form.get('note'),
      name: file.name,
      type: file.type,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  });
  // The durable stream's shape: numbered events, resumed after `Last-Event-ID`.
  app.get('/api/sessions/:id/events', (c) =>
    streamToNodeResponse(
      c,
      (res, { signal }) =>
        new Promise<void>((resolve) => {
          const after = Number(c.req.header('last-event-id') ?? 0);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.flushHeaders();
          let next = after + 1;
          const timer = setInterval(() => {
            if (next > STREAM_EVENTS) {
              clearInterval(timer);
              res.end();
              resolve();
              return;
            }
            res.write(`id: ${next}\nevent: tick\ndata: ${JSON.stringify({ n: next })}\n\n`);
            next += 1;
          }, 5);
          signal.addEventListener('abort', () => {
            clearInterval(timer);
            closedRequests.push(c.req.path);
            resolve();
          });
        })
    )
  );
  app.get('/forever', (c) =>
    streamToNodeResponse(
      c,
      (res, { signal }) =>
        new Promise<void>((resolve) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(': open\n\n');
          signal.addEventListener('abort', () => {
            closedRequests.push(c.req.path);
            resolve();
          });
        })
    )
  );
  app.get('/head', (c) => c.text('a body HEAD must not carry', 200, { 'X-Fixture': 'yes' }));
  app.get('/echo', (c) =>
    c.json({ path: c.req.path, host: c.env.incoming.headers.host ?? null, method: c.req.method })
  );
  app.on('OPTIONS', '/', (c) =>
    c.text(`app saw ${c.req.method} ${c.env.incoming.url}`, 200, { 'X-Fixture': 'yes' })
  );
  // Refuses without reading the body, as an auth check ahead of an upload does.
  app.post('/refuse', (c) => c.json({ error: 'no' }, 401));
  app.get('/boom', () => {
    throw new Error('fixture failure');
  });
  return app;
}

const servers: Server[] = [];

afterEach(async () => {
  closedRequests.length = 0;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Serve `app` through the front door on an ephemeral loopback port. */
async function serveThroughFrontDoor(app: Hono<ApiEnv>): Promise<string> {
  const server = createFrontDoorServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Send raw bytes to the front door and return the status line and the rest. */
async function rawRequest(base: string, request: string): Promise<string> {
  const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
  socket.end(request);
  let raw = '';
  socket.setEncoding('utf8').on('data', (chunk: string) => (raw += chunk));
  await once(socket, 'close');
  return raw;
}

describe('front door', () => {
  it('leaves the platform Request and Response in place', async () => {
    const before = { Request: globalThis.Request, Response: globalThis.Response };
    await serveThroughFrontDoor(fixtureApp());
    expect(globalThis.Request).toBe(before.Request);
    expect(globalThis.Response).toBe(before.Response);
  });

  it('hands a route a 2 MB body byte for byte', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const body = randomBytes(TWO_MB);
    const res = await fetch(`${base}/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: TWO_MB, sha256: sha256(body) });
  });

  it('hands a route a 2 MB JSON body to parse', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const blob = 'x'.repeat(TWO_MB);
    const res = await fetch(`${base}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: TWO_MB });
  });

  it('keeps a route’s own 413, and the next request still works', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const tooBig = await fetch(`${base}/small`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(TWO_MB) }),
    });
    expect(tooBig.status).toBe(413);
    await tooBig.arrayBuffer();
    const ok = await fetch(`${base}/small`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('hands a route a multipart upload intact', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const bytes = randomBytes(TWO_MB);
    const form = new FormData();
    form.append('note', 'hello from the form');
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'picture.png');
    const res = await fetch(`${base}/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      field: 'hello from the form',
      name: 'picture.png',
      type: 'image/png',
      bytes: TWO_MB,
      sha256: sha256(bytes),
    });
  });

  it('streams SSE, and a Last-Event-ID reconnect resumes after it', async () => {
    const listener = frontDoorListener(fixtureApp());

    const first = await collectDurableEvents(listener, 'fixture', {
      until: (frames) => frames.length >= 2,
    });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('text/event-stream');
    expect(first.frames.map((f) => f.id)).toEqual(['1', '2']);

    const resumed = await collectDurableEvents(listener, 'fixture', {
      lastEventId: first.frames.at(-1)!.id,
    });
    expect(resumed.frames.map((f) => f.data)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
  });

  it('tells a route when a client hangs up on a stream', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const req = http.get(`${base}/forever`);
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    await once(res, 'data');
    req.destroy();
    await vi.waitFor(() => expect(closedRequests).toContain('/forever'));
  });

  it('answers HEAD with the headers and no body', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const res = await fetch(`${base}/head`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-fixture')).toBe('yes');
    expect(await res.text()).toBe('');
  });

  it.each([
    ['no Host at all (HTTP/1.0)', 'GET /head HTTP/1.0\r\n\r\n'],
    [
      'a port out of range',
      'GET /head HTTP/1.1\r\nHost: localhost:99999\r\nConnection: close\r\n\r\n',
    ],
    [
      'a Host with a path in it',
      'GET /head HTTP/1.1\r\nHost: example.com/x\r\nConnection: close\r\n\r\n',
    ],
  ])('still serves a request the adapter cannot read: %s', async (_name, request) => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const raw = await rawRequest(base, request);
    expect(raw.split('\r\n')[0]).toMatch(/^HTTP\/1\.[01] 200 OK$/);
    expect(raw).toMatch(/x-fixture: yes/i);
  });

  it('leaves the raw Host of an unreadable request as it came, for the guards to judge', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const raw = await rawRequest(
      base,
      'GET /echo HTTP/1.1\r\nHost: example.com/x\r\nConnection: close\r\n\r\n'
    );
    expect(raw).toContain('{"path":"/echo","host":"example.com/x","method":"GET"}');
  });

  it('keeps a path that starts with two slashes a path, not a host', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const raw = await rawRequest(base, 'GET //echo HTTP/1.0\r\n\r\n');
    expect(raw.split('\r\n')[0]).toMatch(/ 404 /);
  });

  it('lower-cases a Host in capitals, so a route still answers it', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const raw = await rawRequest(
      base,
      'GET /echo HTTP/1.1\r\nHost: LocalHost:1\r\nConnection: close\r\n\r\n'
    );
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(raw).toContain('{"path":"/echo","host":"localhost:1","method":"GET"}');
  });

  it('serves an OPTIONS * request, at the root', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const raw = await rawRequest(
      base,
      'OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(raw).toMatch(/app saw OPTIONS \*$/);
  });

  it('keeps the connection when a route answers before a slow body has arrived', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
    let raw = '';
    socket.setEncoding('utf8').on('data', (chunk: string) => (raw += chunk));
    const half = 'x'.repeat(1024);
    socket.write(
      `POST /refuse HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${half.length * 2}\r\n\r\n`
    );
    socket.write(half);
    await vi.waitFor(() => expect(raw).toMatch(/^HTTP\/1\.1 401/));
    // The rest of the body arrives well after the reply, as an upload over a
    // slow link would. Node reads and discards it, and the socket stays usable.
    await new Promise((resolve) => setTimeout(resolve, 700));
    socket.write(half);
    socket.end('GET /head HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await once(socket, 'close');
    expect(raw).toMatch(/HTTP\/1\.1 200 OK[\s\S]*x-fixture: yes/i);
  });

  it('keeps a route’s error answer', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
  });

  it('lets the upgrade router claim a WebSocket on the same server', async () => {
    const server = createFrontDoorServer(fixtureApp());
    servers.push(server);
    attachUpgradeRouter(
      server,
      [
        {
          name: 'echo',
          pattern: /^\/ws\/echo$/,
          credential: 'bearer-of-id',
          authorize: () => ({
            ok: true,
            open: (socket) => socket.on('message', (data) => socket.send(`echo:${data}`)),
          }),
        },
      ],
      new MainRequestAdmission()
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/echo`);
    await once(ws, 'open');
    ws.send('ping');
    const [reply] = (await once(ws, 'message')) as [Buffer];
    expect(reply.toString()).toBe('echo:ping');
    ws.close();
    await once(ws, 'close');

    // An HTTP request to the same server still reaches the app.
    const res = await fetch(`http://127.0.0.1:${port}/head`);
    expect(res.headers.get('x-fixture')).toBe('yes');
  });

  describe('with the real app behind it', () => {
    const admission = new MainRequestAdmission();
    const app = composeFrontDoor(admission);

    it('answers a real route in its documented shape', async () => {
      const base = await serveThroughFrontDoor(app);
      const res = await fetch(`${base}/api/keep-awake`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(KeepAwakeStatusSchema.parse(body)).toEqual(body);
    });

    it('keeps the app-wide 1 MB JSON limit', async () => {
      const base = await serveThroughFrontDoor(app);
      const res = await fetch(`${base}/api/no-such-route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blob: 'x'.repeat(TWO_MB) }),
      });
      expect(res.status).toBe(413);
    });

    it('keeps the /api 404', async () => {
      const base = await serveThroughFrontDoor(app);
      const res = await fetch(`${base}/api/no-such-route`);
      expect(res.status).toBe(404);
    });

    it('refuses an /api request with no Host at all, as the host guard always has', async () => {
      const base = await serveThroughFrontDoor(app);
      const raw = await rawRequest(base, 'GET /api/no-such-route HTTP/1.0\r\n\r\n');
      expect(raw.split('\r\n')[0]).toMatch(/ 403 /);
      expect(raw).toContain('HOST_NOT_ALLOWED');
    });
  });
});
