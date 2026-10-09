/**
 * The front door must be invisible: every request it hands to Express has to
 * arrive and leave exactly as it did when Express was the listener itself.
 *
 * Each case drives real sockets through `createFrontDoorServer`, because the
 * failures this guards against only exist on the wire: a body drained while
 * Express still reads it, a stream cut short, the process-wide `Request`
 * swapped for the adapter's own, an upgrade that never reaches the router.
 */
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http, { type RequestListener, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import multer from 'multer';
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
import { createApp, finalizeApp } from '../../app.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { attachUpgradeRouter } from '../../services/core/streams/upgrade-router.js';
import { createFrontDoor, createFrontDoorServer, frontDoorListener } from '../front-door.js';

const TWO_MB = 2 * 1024 * 1024;

/** Every event the fixture stream can send, numbered from 1. */
const STREAM_EVENTS = 5;

/** Requests the fixture app saw end, by path. Filled by the `close` listener. */
const closedRequests: string[] = [];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * TWO_MB } });

/** A stand-in for the real app: the Express features the front door must not disturb. */
function fixtureApp(): express.Express {
  const app = express();
  app.post('/raw', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
    const body = req.body as Buffer;
    res.json({ bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  });
  app.post('/json', express.json({ limit: '5mb' }), (req, res) => {
    res.json({ length: (req.body as { blob: string }).blob.length });
  });
  app.post('/small', express.json({ limit: '1kb' }), (_req, res) => res.json({ ok: true }));
  app.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file!;
    res.json({
      field: (req.body as { note: string }).note,
      name: file.originalname,
      type: file.mimetype,
      bytes: file.size,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
    });
  });
  // The durable stream's shape: numbered events, resumed after `Last-Event-ID`.
  app.get('/api/sessions/:id/events', (req, res) => {
    const after = Number(req.get('Last-Event-ID') ?? 0);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    let next = after + 1;
    const timer = setInterval(() => {
      if (next > STREAM_EVENTS) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(`id: ${next}\nevent: tick\ndata: ${JSON.stringify({ n: next })}\n\n`);
      next += 1;
    }, 5);
    req.on('close', () => {
      clearInterval(timer);
      closedRequests.push(req.path);
    });
  });
  app.get('/forever', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': open\n\n');
    req.on('close', () => closedRequests.push(req.path));
  });
  app.get('/head', (_req, res) => {
    res.set('X-Fixture', 'yes').send('a body HEAD must not carry');
  });
  // Refuses without reading the body, as an auth check ahead of an upload does.
  app.post('/refuse', (_req, res) => {
    res.status(401).json({ error: 'no' });
  });
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

/** Serve `legacy` through the front door on an ephemeral loopback port. */
async function serveThroughFrontDoor(legacy: RequestListener): Promise<string> {
  const server = createFrontDoorServer(createFrontDoor(legacy));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('front door', () => {
  it('leaves the platform Request and Response in place', async () => {
    const before = { Request: globalThis.Request, Response: globalThis.Response };
    await serveThroughFrontDoor(fixtureApp());
    expect(globalThis.Request).toBe(before.Request);
    expect(globalThis.Response).toBe(before.Response);
  });

  it('hands Express a 2 MB body byte for byte', async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const body = randomBytes(TWO_MB);
    const res = await fetch(`${base}/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bytes: TWO_MB,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  });

  it('hands Express a 2 MB JSON body to parse', async () => {
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

  it("keeps Express's own 413, and the next request still works", async () => {
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

  it('hands multer a multipart upload intact', async () => {
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
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('streams SSE, and a Last-Event-ID reconnect resumes after it', async () => {
    const listener = frontDoorListener(createFrontDoor(fixtureApp()));

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

  it('tells Express when a client hangs up on a stream', async () => {
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

  /** Send raw bytes to the front door and return the status line and the rest. */
  async function rawRequest(base: string, request: string): Promise<string> {
    const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
    socket.end(request);
    let raw = '';
    socket.setEncoding('utf8').on('data', (chunk: string) => (raw += chunk));
    await once(socket, 'close');
    return raw;
  }

  it.each([
    ['no Host at all (HTTP/1.0)', 'GET /head HTTP/1.0\r\n\r\n'],
    ['a Host in capitals', 'GET /head HTTP/1.1\r\nHost: LocalHost:1\r\nConnection: close\r\n\r\n'],
    [
      'a port out of range',
      'GET /head HTTP/1.1\r\nHost: localhost:99999\r\nConnection: close\r\n\r\n',
    ],
    [
      'a Host with a path in it',
      'GET /head HTTP/1.1\r\nHost: example.com/x\r\nConnection: close\r\n\r\n',
    ],
  ])('hands Express a request Hono cannot read: %s', async (_name, request) => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const raw = await rawRequest(base, request);
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(raw).toMatch(/x-fixture: yes/i);
  });

  it('hands Express an OPTIONS * request', async () => {
    const legacy: RequestListener = (req, res) => res.end(`legacy saw ${req.method} ${req.url}`);
    const base = await serveThroughFrontDoor(legacy);
    const raw = await rawRequest(
      base,
      'OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(raw).toMatch(/legacy saw OPTIONS \*$/);
  });

  it('keeps the connection when Express answers before a slow body has arrived', async () => {
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

  it("keeps Express's own error answer", async () => {
    const base = await serveThroughFrontDoor(fixtureApp());
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
  });

  it('lets the upgrade router claim a WebSocket on the same server', async () => {
    const server = createFrontDoorServer(createFrontDoor(fixtureApp()));
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

    // An HTTP request to the same server still reaches Express.
    const res = await fetch(`http://127.0.0.1:${port}/head`);
    expect(res.headers.get('x-fixture')).toBe('yes');
  });

  describe('with the real app behind it', () => {
    const app = createApp({ admission: new MainRequestAdmission() });
    finalizeApp(app);

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
  });
});
