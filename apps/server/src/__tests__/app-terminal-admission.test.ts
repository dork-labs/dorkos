import { createHmac } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import ts from 'typescript';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { ComposioEventClient } from '@dorkos/connector-providers/composio';

const state = vi.hoisted(() => ({ login: false, dist: '', authDispatch: vi.fn() }));
vi.mock('../env.js', async (original) => {
  const { env } = await original<typeof import('../env.js')>();
  return {
    env: {
      ...env,
      NODE_ENV: 'production',
      get CLIENT_DIST_PATH() {
        return state.dist;
      },
    },
  };
});
vi.mock('../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
    set: vi.fn(),
  },
}));
vi.mock('../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../services/core/auth/index.js', async (original) => {
  const actual = await original<typeof import('../services/core/auth/index.js')>();
  return {
    ...actual,
    getAuth: () => ({ api: { getSession: async () => null } }),
    toNodeHandler: () => (_req: unknown, res: import('express').Response) => {
      state.authDispatch();
      res.status(401).json({ error: 'auth fixture refusal' });
    },
  };
});
import { createApp, finalizeApp } from '../app.js';
import { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { logger } from '../lib/logger.js';

const target = swappableServer();
const secret = 'admission-webhook-fixture';
const verifier = new ComposioEventClient({
  apiKey: 'no-network-fixture',
  serverUserId: 'fixture',
  webhookSecret: secret,
});
const accept = vi.fn(async () => 'accepted' as const);
const rawEvent =
  '{"trigger_name":"GMAIL_NEW_MESSAGE","connection_id":"ca_fixture","trigger_id":"tr_fixture","payload":{},"log_id":"log"}';
function signed() {
  const id = 'msg_fixture';
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${rawEvent}`).digest('base64')}`,
  };
}
function boot(admission = new MainRequestAdmission()) {
  const app = createApp({ admission, connectorEventIngress: { verifier: () => verifier, accept } });
  target.mount(app);
  return { admission, app };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function port() {
  return (target.server.address() as import('node:net').AddressInfo).port;
}
function rawGet(url: string, agent?: Agent): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port: port(), path: url, agent }, resolve)
      .on('error', reject)
      .end();
  });
}
async function body(response: IncomingMessage) {
  let result = '';
  for await (const chunk of response) result += chunk;
  return result;
}
function expectTerminal(response: {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
}) {
  expect(response.status).toBe(503);
  expect(response.body).toEqual({
    code: 'SERVER_STOPPING',
    error: 'The server is stopping. Try again after it restarts.',
  });
  expect(response.headers).toMatchObject({
    'cache-control': 'no-store',
    connection: 'close',
    'x-content-type-options': 'nosniff',
  });
  expect(response.headers['retry-after']).toBeUndefined();
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
}

/** Census actual mounts in both composition files, including conditional/later mounts. */
function mountPaths() {
  const paths = new Set<string>();
  for (const filename of ['../app.ts', '../index.ts']) {
    const source = ts.createSourceFile(
      filename,
      readFileSync(new URL(filename, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'app' &&
        ['use', 'get', 'post', 'all'].includes(node.expression.name.text) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        paths.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...paths].map((mount) => mount.replace(/:[A-Za-z]+|\*[A-Za-z]+/g, 'admission-fixture'));
}

beforeAll(() => {
  state.dist = mkdtempSync(path.join(tmpdir(), 'admission-static-'));
  writeFileSync(path.join(state.dist, 'index.html'), '<!doctype html>admission fixture');
});
afterAll(() => rmSync(state.dist, { recursive: true, force: true }));
beforeEach(() => {
  state.login = false;
  vi.clearAllMocks();
});

describe('main HTTP admission through the real app', () => {
  // A1: passive state changes no process/domain resources and cannot reopen.
  it('is passive, monotonic and idempotent', () => {
    const admission = new MainRequestAdmission();
    expect(admission.isClosed).toBe(false);
    admission.close();
    admission.close();
    expect(admission.isClosed).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });

  // A5: an app constructed after terminal closure must receive the existing closed instance.
  it('refuses requests when the real app is constructed after admission closed', async () => {
    const admission = new MainRequestAdmission();
    admission.close();
    const { app } = boot(admission);
    const handler = vi.fn();
    app.get('/late-app', (_req, res) => {
      handler();
      res.end();
    });
    expectTerminal(await request(target.server).get('/late-app'));
    expectTerminal(await request(target.server).get('/api/health'));
    expect(handler).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  // A1: one connection must be checked per request, not just when TCP connects.
  it('refuses a later request on the same keep-alive socket and a later-mounted route', async () => {
    const { admission, app } = boot();
    const entered = vi.fn();
    app.get('/admission-late', (_req, res) => {
      entered();
      res.send('running');
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await rawGet('/admission-late', agent);
      const socket = first.socket;
      expect(await body(first)).toBe('running');
      expect(entered).toHaveBeenCalledTimes(1);
      admission.close();
      const second = await rawGet('/admission-late', agent);
      expect(second.socket).toBe(socket);
      expect(second.statusCode).toBe(503);
      expect(JSON.parse(await body(second))).toMatchObject({ code: 'SERVER_STOPPING' });
      expect(entered).toHaveBeenCalledTimes(1);
    } finally {
      agent.destroy();
    }
  });

  // A2: enumerate source mounts rather than blessing a short representative allowlist.
  it('refuses every discovered mount, all methods, SPA /x and unknown paths before first contact or parsing', async () => {
    const { admission, app } = boot();
    const late = vi.fn();
    app.use('/mcp', (_req, res) => {
      late();
      res.send('mcp');
    });
    app.use('/a2a', (_req, res) => {
      late();
      res.send('a2a');
    });
    finalizeApp(app);
    expect((await request(target.server).get('/mcp')).text).toBe('mcp');
    expect((await request(target.server).get('/a2a')).text).toBe('a2a');
    expect((await request(target.server).get('/x/fixture')).text).toContain('admission fixture');
    expect(late).toHaveBeenCalledTimes(2);
    vi.mocked(logger.info).mockClear();
    admission.close();
    const mounts = mountPaths();
    expect(mounts).toContain('/api/projects');
    expect(mounts).toContain('/api/auth/admission-fixture');
    expect(mounts).toContain('/api/connectors/webhooks/admission-fixture');
    expect(mounts).toHaveLength(65);
    for (const mount of [...mounts, '/', '/x/fixture', '/unknown']) {
      expectTerminal(
        await request(target.server).get(mount).set('Origin', 'https://untrusted.example')
      );
    }
    for (const method of ['post', 'put', 'patch', 'delete', 'options'] as const) {
      expectTerminal(
        await request(target.server)
          [method]('/api/projects')
          .set('content-type', 'application/json')
          .send('{invalid')
      );
    }
    const head = await request(target.server).head('/x/fixture');
    expect(head.status).toBe(503);
    expect(head.text).toBeUndefined();
    expect(head.headers).toMatchObject({
      'cache-control': 'no-store',
      connection: 'close',
      'x-content-type-options': 'nosniff',
    });
    expect(late).toHaveBeenCalledTimes(2);
    expect(state.authDispatch).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  // A2: real host/session/CORS policies and signed-ingress dispatch still work while open.
  it('preserves running security and blocks auth/webhook/parser effects once closed', async () => {
    const { admission, app } = boot();
    const ordinary = vi.fn();
    app.post('/admission-json', (_req, res) => {
      ordinary();
      res.json({ ok: true });
    });
    expect(
      (await request(target.server).post('/admission-json').send({ valid: true })).status
    ).toBe(200);
    expect(ordinary).toHaveBeenCalledTimes(1);
    expect((await request(target.server).get('/api/auth/session')).status).toBe(401);
    expect(state.authDispatch).toHaveBeenCalledTimes(1);
    expect(
      (await request(target.server).get('/api/projects').set('Host', 'evil.example')).status
    ).toBe(403);
    state.login = true;
    expect((await request(target.server).get('/api/projects')).status).toBe(401);
    expect(
      (
        await request(target.server)
          .post('/admission-json')
          .set('content-type', 'application/json')
          .send('{invalid')
      ).status
    ).toBe(400);
    expect(
      (
        await request(target.server)
          .post('/api/connectors/webhooks/fixture')
          .set(signed())
          .set('content-type', 'application/json')
          .send(rawEvent)
      ).status
    ).toBe(202);
    expect(accept).toHaveBeenCalledTimes(1);
    admission.close();
    expectTerminal(await request(target.server).get('/api/auth/session'));
    expectTerminal(
      await request(target.server)
        .post('/api/connectors/webhooks/fixture')
        .set(signed())
        .set('content-type', 'application/json')
        .send(rawEvent)
    );
    expectTerminal(
      await request(target.server)
        .post('/admission-json')
        .set('content-type', 'application/json')
        .send('{invalid')
    );
    expect(ordinary).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(state.authDispatch).toHaveBeenCalledTimes(1);
  });

  // The request passed admission before its JSON parser finished, so closure cannot revoke it.
  it('preserves admission while an incomplete body is still being parsed', async () => {
    const { admission, app } = boot();
    const handled = vi.fn();
    app.post('/admission-partial-body', (req, res) => {
      handled(req.body);
      res.json(req.body);
    });
    const dispatched = once(target.server, 'request');
    let send!: ReturnType<typeof httpRequest>;
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      send = httpRequest(
        {
          host: '127.0.0.1',
          port: port(),
          path: '/admission-partial-body',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '11' },
        },
        resolve
      );
      send.on('error', reject);
    });
    send.write('{"ok":');
    // The server's app listener ran before this later request listener; parsing awaits the tail.
    await dispatched;
    expect(handled).not.toHaveBeenCalled();
    admission.close();
    send.end('true}');
    const finished = await response;
    expect(finished.statusCode).toBe(200);
    expect(JSON.parse(await body(finished))).toEqual({ ok: true });
    expect(handled).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expectTerminal(
      await request(target.server).post('/admission-partial-body').send({ ok: false })
    );
    expect(handled).toHaveBeenCalledTimes(1);
  });

  // A3: closing admission is neither cancellation nor a drain of work already admitted.
  it('lets an admitted handler and established SSE stream finish after closure', async () => {
    const { admission, app } = boot();
    const entered = deferred<void>();
    const release = deferred<void>();
    const handlers = vi.fn();
    app.get('/admission-held', async (_req, res) => {
      handlers();
      entered.resolve();
      await release.promise;
      res.send('finished');
    });
    const stream = deferred<import('express').Response>();
    app.get('/admission-sse', (_req, res) => {
      handlers();
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      stream.resolve(res);
    });
    const held = rawGet('/admission-held');
    await entered.promise;
    const sse = await rawGet('/admission-sse');
    const outgoing = await stream.promise;
    admission.close();
    expectTerminal(await request(target.server).get('/admission-held'));
    expectTerminal(await request(target.server).get('/admission-sse'));
    expect(handlers).toHaveBeenCalledTimes(2);
    const event = once(sse, 'data');
    outgoing.write('data: survived\n\n');
    expect(String((await event)[0])).toBe('data: survived\n\n');
    const ended = once(sse, 'end');
    sse.resume();
    outgoing.end();
    await ended;
    release.resolve();
    expect(await body(await held)).toBe('finished');
    expect(handlers).toHaveBeenCalledTimes(2);
  });
});
