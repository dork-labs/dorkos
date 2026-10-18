/**
 * @vitest-environment node
 *
 * Signing out ends what that sign-in had open, and the signed-in devices
 * routes (F4 part 2, DOR-2969), through real Better Auth, the real chain, the
 * real upgrade router and real sockets.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RequestListener } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { STREAM_CLOSE_CODE_BASE } from '@dorkos/shared/stream-socket';
import { createDb, runMigrations, session, type Db } from '@dorkos/db';

// Every audit row, kept here: one device sign-out must write exactly one.
const audited = vi.hoisted(() => [] as { action: string }[]);
vi.mock('../../../audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../audit/audit-trail.js')>()),
  // Any account lookup answers a stand-in actor.
  auditTrail: () => ({
    accounts: new Proxy({}, { get: () => (id?: string) => ({ type: 'account', id }) }),
  }),
  recordAudit: (row: { action: string }) => audited.push(row),
}));

import { getAuth, initAuth, verifyRequestAuth } from '../index.js';
import { inRestartWindow } from '../sessions/live-connections.js';
import { sweepLiveConnections } from '../sessions/live-connections.js';
import { liveSessionIds } from '../sessions/signed-in-devices.js';
import { createApiApp } from '../../../../http/api-chain.js';
import { mountBetterAuth } from '../../../../http/better-auth.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { streamToNodeResponse } from '../../../../http/raw-node-stream.js';
import { createDevicesRoutes } from '../../../../routes/devices.js';
import { NEEDS_PERSON_AT_THIS_COMPUTER } from '../../../../lib/caller-authority.js';
import { createTerminalRoutes } from '../../../../routes/terminal.js';
import type { TerminalManager } from '../../../terminal/index.js';
import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { markIngress, type RequestIngress } from '../../remote/ingress-mark.js';
import { attachUpgradeRouter } from '../../streams/upgrade-router.js';
import { env } from '../../../../env.js';

const target = swappableServer();
const EMAIL = 'owner' + '@' + 'dork.test';
const PASSWORD = 'correct-horse-battery-staple';
const LOCAL = `localhost:${env.DORKOS_PORT}`;
const ORIGIN = `http://${LOCAL}`;
/** Test-only: names the listener the next request arrives through. */
const INGRESS_HEADER = 'x-test-ingress';

/** A terminal manager that only records what was made and torn down. */
function fakeTerminals() {
  const hooks = new Map<string, () => void>();
  const destroyed: string[] = [];
  let next = 0;
  const manager = {
    create: async (_req: unknown, opts: { onDestroyed?: () => void } = {}) => {
      const id = `term-${++next}`;
      if (opts.onDestroyed) hooks.set(id, opts.onDestroyed);
      return id;
    },
    destroy: (id: string) => {
      if (destroyed.includes(id)) return;
      destroyed.push(id);
      hooks.get(id)?.();
    },
  };
  return { manager: manager as unknown as TerminalManager, destroyed };
}

const terminals = fakeTerminals();

/** The real chain, a test stream, the terminal and devices routes. */
function buildApp(): RequestListener {
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeBodyParsing: (early) => mountBetterAuth(early, { auth: getAuth()!, maxAttempts: 1000 }),
  });
  app.get('/api/test/stream', (c) =>
    streamToNodeResponse(c, (res, { signal }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    })
  );
  app.route('/api/terminal', createTerminalRoutes(terminals.manager));
  app.route('/api/devices', createDevicesRoutes());
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

/** The port the test server listens on. */
function port(): number {
  return (target.server.address() as AddressInfo).port;
}

/** An open event stream, and whether the server has closed it. */
interface OpenStream {
  status: number;
  closed: () => boolean;
  whenClosed: Promise<void>;
}

/** Open the test event stream through `ingress` with `cookie`. */
function openStream(ingress: RequestIngress, cookie: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path: '/api/test/stream',
        headers: headersVia(ingress, cookie),
      },
      (res) => {
        let closed = false;
        const whenClosed = new Promise<void>((done) => {
          const end = (): void => {
            closed = true;
            done();
          };
          res.once('close', end);
          res.once('error', end);
        });
        res.on('data', () => {});
        // Resolve once the body has started, so the route is registered.
        if (res.statusCode !== 200) {
          resolve({ status: res.statusCode ?? 0, closed: () => closed, whenClosed });
          return;
        }
        res.once('data', () =>
          resolve({ status: res.statusCode ?? 0, closed: () => closed, whenClosed })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Open a credential-gated stream socket at this computer with `cookie`. */
function openSocket(cookie: string): Promise<{ ws: WebSocket; closeCode: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port()}/api/test/socket`, {
      headers: { host: LOCAL, cookie },
    });
    const closeCode = new Promise<number>((done) => ws.once('close', (code) => done(code)));
    ws.once('open', () => resolve({ ws, closeCode }));
    ws.once('error', reject);
  });
}

/** Wait a moment for a close the server sent to cross the socket. */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Better Auth call through `ingress` with `cookie`. */
function authCall(url: string, ingress: RequestIngress, cookie: string, body: object = {}) {
  return request(target.server)
    .post(`/api/auth/${url}`)
    .set(headersVia(ingress, cookie))
    .send(body);
}

/** A devices call through `ingress` with `cookie`. */
function devices(
  method: 'get' | 'delete' | 'post',
  url: string,
  ingress: RequestIngress,
  cookie: string
) {
  return request(target.server)[method](`/api/devices${url}`).set(headersVia(ingress, cookie));
}

/** The opaque id the list gives the sign-in `cookie` is. */
async function idOf(cookie: string, ingress: RequestIngress): Promise<string> {
  const res = await devices('get', '/sessions', ingress, cookie);
  return (res.body.sessions as { id: string; current: boolean }[]).find((s) => s.current)!.id;
}

describe('signing out ends what that sign-in had open', () => {
  let tmpDir: string;
  let db: Db;
  let ownerId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-live-connections-'));
    initConfigManager(tmpDir);
    // Ask at this computer too, so every request here proves a sign-in.
    configManager.set('auth', { enabled: true });
    db = createDb(path.join(tmpDir, 'auth.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
    target.mount(buildApp());
    attachUpgradeRouter(
      target.server,
      [
        {
          name: 'test-socket',
          pattern: /^\/api\/test\/socket$/,
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
    ownerId = signUp.body.user.id;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('closes the stream, the socket and the terminal of that sign-in, and no other', async () => {
    const leaving = await signInVia('direct');
    const staying = await signInVia('direct');
    const stream = await openStream('direct', leaving);
    const socket = await openSocket(leaving);
    const otherStream = await openStream('direct', staying);
    const otherSocket = await openSocket(staying);
    const made = await request(target.server)
      .post('/api/terminal')
      .set(headersVia('direct', leaving))
      .send({ cwd: tmpDir });
    expect(made.status).toBe(201);
    expect(stream.status).toBe(200);

    expect((await authCall('sign-out', 'direct', leaving)).status).toBe(200);
    // The terminal is torn down before the sign-out answers.
    expect(terminals.destroyed).toContain(made.body.id);
    await settle();
    expect(stream.closed()).toBe(true);
    expect(await socket.closeCode).toBe(STREAM_CLOSE_CODE_BASE + 401);
    expect(otherStream.closed()).toBe(false);
    expect(otherSocket.ws.readyState).toBe(WebSocket.OPEN);

    // The cookie's cached snapshot no longer opens anything.
    expect((await openStream('direct', leaving)).status).toBe(401);
    otherSocket.ws.close();
  });

  it('lists your own sign-ins without a single token', async () => {
    const here = await signInVia('direct');
    const phone = await signInVia('wifi');
    const res = await devices('get', '/sessions', 'direct', here);
    expect(res.status).toBe(200);
    expect(res.body.canSignOutOthers).toBe(true);
    const tokens = db
      .select({ token: session.token, id: session.id })
      .from(session)
      .where(eq(session.userId, ownerId))
      .all();
    const text = JSON.stringify(res.body);
    for (const row of tokens) {
      expect(text).not.toContain(row.token);
      expect(text).not.toContain(row.id);
    }
    const current = res.body.sessions.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    expect(res.body.sessions[0]).toMatchObject({ current: true, route: 'local' });
    expect(res.body.sessions.map((s: { route: string }) => s.route)).toContain('wifi');

    const fromPhone = await devices('get', '/sessions', 'wifi', phone);
    expect(fromPhone.status).toBe(200);
    expect(fromPhone.body.canSignOutOthers).toBe(false);
  });

  it('signs out another device only from this computer, and your own from anywhere', async () => {
    const here = await signInVia('direct');
    const phone = await signInVia('wifi');
    const tablet = await signInVia('wifi');
    const phoneStream = await openStream('wifi', phone);
    const tabletStream = await openStream('wifi', tablet);
    const tabletId = await idOf(tablet, 'wifi');

    const refused = await devices('delete', `/sessions/${tabletId}`, 'wifi', phone);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);
    expect((await devices('post', '/sign-out-all', 'wifi', phone)).status).toBe(403);
    expect(tabletStream.closed()).toBe(false);

    // Your own, from Wi-Fi.
    const phoneId = await idOf(phone, 'wifi');
    expect((await devices('delete', `/sessions/${phoneId}`, 'wifi', phone)).status).toBe(204);
    await settle();
    expect(phoneStream.closed()).toBe(true);
    expect(tabletStream.closed()).toBe(false);

    // Another, from this computer: one audit row, naming a device sign-out.
    audited.length = 0;
    expect((await devices('delete', `/sessions/${tabletId}`, 'direct', here)).status).toBe(204);
    // (The chain's own `http.delete` request row is every write's, not a sign-out's.)
    const signOutRows = audited.filter((row) => row.action.startsWith('auth.'));
    expect(signOutRows.map((row) => row.action)).toEqual(['auth.device_signed_out']);
    await settle();
    expect(tabletStream.closed()).toBe(true);
    expect((await devices('delete', `/sessions/${tabletId}`, 'direct', here)).status).toBe(404);
  });

  it('signs out everywhere else from this computer, keeping this one', async () => {
    const here = await signInVia('direct');
    const away = await signInVia('wifi');
    const hereStream = await openStream('direct', here);
    const awayStream = await openStream('wifi', away);
    const res = await devices('post', '/sign-out-all', 'direct', here);
    expect(res.status).toBe(200);
    expect(res.body.signedOut).toBeGreaterThan(0);
    await settle();
    expect(awayStream.closed()).toBe(true);
    expect(hereStream.closed()).toBe(false);
    const left = await devices('get', '/sessions', 'direct', here);
    expect(left.body.sessions).toHaveLength(1);
  });

  it("closes the others when Better Auth's revoke-other-sessions runs", async () => {
    const here = await signInVia('direct');
    const away = await signInVia('wifi');
    const awayStream = await openStream('wifi', away);
    expect((await authCall('revoke-other-sessions', 'direct', here)).status).toBe(200);
    await settle();
    expect(awayStream.closed()).toBe(true);
  });

  it('closes every stream after a reset outside this process, within a sweep', async () => {
    const a = await signInVia('direct');
    const b = await signInVia('wifi');
    const aStream = await openStream('direct', a);
    const bStream = await openStream('wifi', b);
    // What `dorkos auth reset-password` does: delete the rows directly.
    db.delete(session).where(eq(session.userId, ownerId)).run();
    expect(aStream.closed()).toBe(false);
    expect(await sweepLiveConnections((ids) => liveSessionIds(getAuth()!, ids))).toBe(2);
    await settle();
    expect(aStream.closed()).toBe(true);
    expect(bStream.closed()).toBe(true);
  });

  it('just after a restart, reads every sign-in from the store, not its cached copy', async () => {
    // This process started moments ago, as a restarted server has.
    expect(inRestartWindow()).toBe(true);
    const ended = await signInVia('direct');
    expect(ended).toMatch(/\.session_data=/);
    const facts = { headers: { host: LOCAL, cookie: ended }, peerAddress: '127.0.0.1' };
    expect(await verifyRequestAuth({ ...facts, ingress: 'direct' })).not.toBeNull();
    // Ended where no hook saw it, as before a restart: the cached copy is fresh.
    db.delete(session).where(eq(session.userId, ownerId)).run();
    expect(await verifyRequestAuth({ ...facts, ingress: 'direct' })).toBeNull();
  });

  it('refuses agents and API keys', async () => {
    const here = await signInVia('direct');
    const asAgent = await request(target.server)
      .get('/api/devices/sessions')
      .set({ ...headersVia('direct', here), 'x-dorkos-agent': 'not-a-real-token' });
    expect(asAgent.status).toBe(403);
    const { key } = await getAuth()!.api.createApiKey({ body: { userId: ownerId, name: 'k' } });
    for (const [method, url] of [
      ['get', '/sessions'],
      ['post', '/sign-out-all'],
    ] as const) {
      const res = await request(target.server)
        [method](`/api/devices${url}`)
        .set({ host: LOCAL, authorization: `Bearer ${key}` });
      expect(res.status).toBe(403);
    }
  });
});
