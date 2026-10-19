/**
 * @vitest-environment node
 *
 * The Wi-Fi level (F4 part 3, DOR-2969) through real Better Auth, the real
 * chain, the real upgrade router and real sockets: a Wi-Fi sign-in is refused
 * on every surface in the list, a sign-in at this computer reaches each one,
 * and the Wi-Fi sign-in still chats, reads and answers approvals.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RequestListener } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations } from '@dorkos/db';

import { getAuth, initAuth } from '../index.js';
import { NOT_FROM_WIFI, WIFI_REFUSED_ROUTES } from '../sessions/wifi-level.js';
import { decideMcpAuth } from '../../../../middleware/mcp-auth.js';
import { createApiApp } from '../../../../http/api-chain.js';
import { mountBetterAuth } from '../../../../http/better-auth.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { markIngress, type RequestIngress } from '../../remote/ingress-mark.js';
import { attachUpgradeRouter } from '../../streams/upgrade-router.js';
import { env } from '../../../../env.js';
import census from '../../../../http/__tests__/route-census.baseline.json' with { type: 'json' };

const target = swappableServer();
const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const LOCAL = `localhost:${env.DORKOS_PORT}`;
const ORIGIN = `http://${LOCAL}`;
/** Test-only: names the listener the next request arrives through. */
const INGRESS_HEADER = 'x-test-ingress';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Each surface the level refuses, as a request a stub route answers when reached. */
const REFUSED: readonly [string, Method, string][] = [
  ['the terminal', 'post', '/api/terminal'],
  ['a file save', 'put', '/api/files/content'],
  ['a new file', 'post', '/api/files'],
  ["a room's file", 'put', '/api/rooms/r1/files/content'],
  ['remote access', 'post', '/api/remote-access/enrolment'],
  ['the own tunnel', 'post', '/api/tunnel/start'],
  ['Wi-Fi itself', 'post', '/api/lan-access'],
  ['the session relay', 'post', '/api/session-relay/link'],
  ["a runtime's key", 'post', '/api/runtimes/claude-code/credential'],
  ['package sources', 'post', '/api/marketplace/sources'],
  ['trusted sources', 'post', '/api/extensions/trusted-sources'],
  ['a restart', 'post', '/api/admin/restart'],
  ['a package install', 'post', '/api/marketplace/packages/p1/install'],
  ['revealing the MCP token', 'post', '/api/config/mcp/reveal-token'],
  ['signing out everywhere', 'post', '/api/devices/sign-out-all'],
  ['MCP by cookie', 'post', '/mcp'],
  ['A2A by cookie', 'post', '/a2a'],
];

/** What a Wi-Fi sign-in keeps. */
const ALLOWED: readonly [string, Method, string][] = [
  ['chat', 'post', '/api/sessions/s1/messages'],
  ['reading', 'get', '/api/files/content'],
  ['an approval', 'post', '/api/approvals/a1/decide'],
  ['a remote access report', 'get', '/api/remote-access/report'],
  ['ordinary settings', 'patch', '/api/config'],
];

/** The real chain and Better Auth, with a stub at every path above. */
function buildApp(): RequestListener {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeBodyParsing: (early) => mountBetterAuth(early, { auth: getAuth()!, maxAttempts: 1000 }),
  });
  for (const [, method, at] of [...REFUSED, ...ALLOWED]) {
    app.on(method.toUpperCase(), at, (c) => c.json({ reached: true }));
  }
  const chain = frontDoorListener(app);
  return (req, res) => {
    const via = req.headers[INGRESS_HEADER];
    if (typeof via === 'string') markIngress(req, via as never);
    chain(req, res);
  };
}

/** Headers for a request through `ingress` with `cookie`. */
function headersVia(ingress: RequestIngress, cookie: string): Record<string, string> {
  return {
    host: LOCAL,
    origin: ORIGIN,
    cookie,
    ...(ingress === 'direct' ? {} : { [INGRESS_HEADER]: ingress }),
  };
}

/** Sign in through one route; returns the cookie pairs it set. */
async function signInVia(ingress: RequestIngress): Promise<string> {
  const res = await request(target.server)
    .post('/api/auth/sign-in/email')
    .set(headersVia(ingress, ''))
    .send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  return ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** One call through `ingress` with `cookie`. */
function call(method: Method, at: string, ingress: RequestIngress, cookie: string) {
  return request(target.server)[method](at).set(headersVia(ingress, cookie)).send({});
}

/**
 * Open a socket at `at`, marked as arriving through `ingress` (the upgrade
 * router reads the same mark), and resolve with how it ended.
 */
function openSocket(at: string, ingress: RequestIngress, cookie: string): Promise<string> {
  return new Promise((resolve) => {
    const port = (target.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${at}`, {
      headers: headersVia(ingress, cookie),
    });
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(`refused ${res.statusCode}`);
      ws.terminate();
    });
    ws.once('error', () => resolve('error'));
  });
}

describe('the Wi-Fi level, end to end', () => {
  let tmpDir: string;
  let wifi: string;
  let local: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-wifi-level-'));
    initConfigManager(tmpDir);
    // Ask at this computer too, so every request here proves a sign-in.
    configManager.set('auth', { enabled: true });
    const db = createDb(path.join(tmpDir, 'auth.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
    const listener = buildApp();
    target.mount(listener);
    // Mark upgrades too, as the Wi-Fi listener does before handing them on.
    target.server.prependListener('upgrade', (req) => {
      const via = req.headers[INGRESS_HEADER];
      if (typeof via === 'string') markIngress(req, via as never);
    });
    attachUpgradeRouter(
      target.server,
      [
        {
          name: 'terminal',
          pattern: /^\/api\/terminal\/([^/]+)\/socket$/,
          credential: 'bearer-of-id',
          authorize: () => ({ ok: true, open: () => {} }),
        },
        {
          name: 'session-stream',
          pattern: /^\/api\/sessions\/[^/]+\/socket$/,
          credential: 'required',
          authorize: () => ({ ok: true, open: () => {} }),
        },
      ],
      new MainRequestAdmission()
    );
    const signUp = await request(target.server)
      .post('/api/auth/sign-up/email')
      .set(headersVia('direct', ''))
      .send({ email: EMAIL, password: PASSWORD, name: 'Owner' });
    expect(signUp.status).toBe(200);
    wifi = await signInVia('wifi');
    local = await signInVia('direct');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(REFUSED)('refuses %s to a Wi-Fi sign-in, in a plain sentence', async (_l, method, at) => {
    const res = await call(method, at, 'wifi', wifi);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(NOT_FROM_WIFI);
    expect(res.body.error).toMatch(/^[A-Z].*\.$/);
  });

  it.each(REFUSED)('lets a sign-in at this computer reach %s', async (_l, method, at) => {
    const res = await call(method, at, 'direct', local);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it.each(ALLOWED)('lets a Wi-Fi sign-in keep %s', async (_l, method, at) => {
    const res = await call(method, at, 'wifi', wifi);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it('refuses API keys over Wi-Fi, reads included, before Better Auth sees them', async () => {
    const list = await call('get', '/api/auth/api-key/list', 'wifi', wifi);
    expect(list.status).toBe(403);
    expect(list.body.code).toBe(NOT_FROM_WIFI);
    const create = await call('post', '/api/auth/api-key/create', 'wifi', wifi);
    expect(create.status).toBe(403);
    expect(create.body.code).toBe(NOT_FROM_WIFI);
    expect((await call('get', '/api/auth/api-key/list', 'direct', local)).status).toBe(200);
  });

  it('refuses signing out everywhere through Better Auth, and keeps signing out yourself', async () => {
    const all = await call('post', '/api/auth/revoke-other-sessions', 'wifi', wifi);
    expect(all.status).toBe(403);
    expect(all.body.code).toBe(NOT_FROM_WIFI);
    const who = await call('get', '/api/auth/get-session', 'wifi', wifi);
    expect(who.status).toBe(200);
    expect(who.body.session.route).toBe('wifi');
  });

  it('refuses a Wi-Fi sign-in at /mcp even with a junk bearer beside it', async () => {
    const res = await request(target.server)
      .post('/mcp')
      .set({ ...headersVia('wifi', wifi), authorization: 'Bearer not-a-real-key' })
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(NOT_FROM_WIFI);
  });

  it('never takes a Wi-Fi cookie as the identity at /mcp or A2A, only a valid key', async () => {
    const made = await request(target.server)
      .post('/api/auth/api-key/create')
      .set(headersVia('direct', local))
      .send({ name: 'tools' });
    expect(made.status).toBe(200);
    const facts = (authorization: string) => ({
      method: 'POST',
      headers: { host: LOCAL, cookie: wifi, authorization },
      peerAddress: '127.0.0.1',
      ingress: 'wifi' as const,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    for (const surface of ['mcp', 'a2a'] as const) {
      expect((await decideMcpAuth(surface, facts('Bearer junk'))).allowed).toBe(false);
      expect(await decideMcpAuth(surface, facts(`Bearer ${made.body.key}`))).toMatchObject({
        allowed: true,
        user: { credential: 'api-key' },
      });
    }
    // Over HTTP, a valid key with no cookie passes the level and the gate.
    const res = await request(target.server)
      .post('/mcp')
      .set({ ...headersVia('wifi', ''), authorization: `Bearer ${made.body.key}` })
      .send({});
    expect(res.status).toBe(200);
  });

  it("refuses the terminal's socket over Wi-Fi and opens it at this computer", async () => {
    expect(await openSocket('/api/terminal/t1/socket', 'wifi', wifi)).toBe('refused 403');
    expect(await openSocket('/api/terminal/t1/socket', 'direct', local)).toBe('open');
  });

  it("keeps a chat's stream socket for a Wi-Fi sign-in", async () => {
    expect(await openSocket('/api/sessions/s1/socket', 'wifi', wifi)).toBe('open');
  });

  it('names only routes that exist: every pattern matches a mounted route', () => {
    // The census lists every mounted route; Better Auth's own endpoints sit
    // behind its one `ALL /api/auth/*` mount, so they are read from the instance.
    const mounted = (census.routes as string[]).map((route) =>
      route
        .split(' ')[1]!
        .replace(/:[A-Za-z]+(?:\{[^}]*\})?/g, 'x')
        .replace(/\*$/, 'x/y')
        .toLowerCase()
    );
    const authApi = getAuth()!.api as Record<string, { path?: string }>;
    const authPaths = Object.values(authApi)
      .map((endpoint) => endpoint.path)
      .filter((p): p is string => typeof p === 'string')
      .map((p) => `/api/auth${p}`.toLowerCase());
    for (const route of WIFI_REFUSED_ROUTES) {
      const hit = [...mounted, ...authPaths].some((p) => route.pattern.test(p));
      expect(hit, String(route.pattern)).toBe(true);
    }
  });
});
