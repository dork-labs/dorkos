// Codex keeps the locality bar. Claude uses owner identity on every device, tested separately.
/**
 * `GET /api/config` reports `isLocalCaller` (answered by `isAtThisComputer`
 * since DOR-2967) so the app can offer honest guidance
 * instead of a Sign in button that can only 403 from a phone (DOR-1655). A
 * report like that is worth nothing unless it agrees with the refusal it
 * describes, so this file asks BOTH surfaces about the SAME request shape and
 * compares their answers to each other.
 *
 * That comparison is what makes it discriminating. The report is asserted
 * against the LIVE refusal, never against a constant, so hard-coding
 * `isLocalCaller: true` in the config route reds the tunnel and LAN rows.
 *
 * Catching the OTHER regression — reading `req.hostname` instead of the raw
 * `Host` header, the exact bug DOR-532 fixed on the refusal side — is why the
 * tunnel row carries an `X-Forwarded-Host` naming loopback: a read that
 * preferred the forwarded host would call that phone local. Since ADR
 * 261015-125850 rule 1 any forwarding header makes a request another device,
 * so a same-host proxy row (loopback peer, loopback `Host`, a forwarding
 * header) pins that half of the new rule on both surfaces as well.
 *
 * Every request presents a person session, because the `/api` gate asks every
 * other device for one (rule 3); without it the gate would answer 401 before
 * either surface gave its own answer.
 *
 * It lives in its own file rather than inside `runtimes-connect.test.ts`
 * because mounting the config router drags in that route's whole import graph
 * (relay, skills, the config store), and that focused suite should not have to
 * carry it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A browser session the session gate can verify, stood in below. */
const PERSON_SESSION = 'dorkos-test-session=person';

// Stood in at the gate's verifier step only: a request carrying the test
// session is the owner's browser session; everything else is the real gate.
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/core/auth/session-gate.js')>();
  return {
    ...actual,
    decideSessionGate: async (...args: Parameters<typeof actual.decideSessionGate>) => {
      const [, , facts, access] = args;
      const cookie = facts.headers.cookie ?? '';
      if (access !== 'refused' && cookie.includes(PERSON_SESSION)) {
        return { allowed: true, user: { userId: 'user_owner', credential: 'cookie' } };
      }
      return actual.decideSessionGate(...args);
    },
  };
});

// Never spawn a vendor CLI: the login route is one of the two surfaces under
// test and its action would otherwise run `claude auth login` for real.
vi.mock('../../services/runtimes/connect/delegated-login.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/delegated-login.js')>();
  return { ...actual, delegateRuntimeLogin: vi.fn().mockResolvedValue({ ok: true }) };
});

// The test session is the install owner's, as a signed-in browser here is
// (DOR-2969: a runtime's sign-in is the owner's to change).
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user?: { userId: string }) => user?.userId === 'user_owner',
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

// The tunnel is open at the phone's address, so the `/api` host guard trusts
// that name and the request reaches the routes' own answers.
vi.mock('../../lib/trusted-origins.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/trusted-origins.js')>()),
  getTunnelHosts: () => ['quiet-otter-1234.ngrok.app'],
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), getDot: vi.fn(), set: vi.fn() },
}));

// `getBoundary` throws unless `initBoundary()` ran at startup, which a bare test
// app never does. Nothing here reads the value; it only has to exist so the
// config handler reaches the field under test.
vi.mock('../../lib/boundary.js', () => ({
  getBoundary: () => '/Users/test-user',
  expandTilde: (p: string) => (p.startsWith('~/') ? `/Users/test-user/${p.slice(2)}` : p),
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createRuntimesRoutes } from '../runtimes.js';
import configRouter from '../config.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

/** The TCP peer the app reports for the current request. */
let currentPeer = '127.0.0.1';

// Both groups answer from the Hono `/api` app, as the running server routes
// them. The peer is rewritten before the chain sees the request. The Hono chain
// computes its forwarded address with one trusted hop, as `app.ts` sets
// `trust proxy`, so a forwarded host still cannot stand in for the raw `Host`.
const routes = honoGroupListener([
  { path: '/api/config', routes: configRouter },
  { path: '/api/runtimes', routes: createRuntimesRoutes() },
]);
const server = listeningServer((req, res) => {
  Object.defineProperty(req.socket, 'remoteAddress', { value: currentPeer, configurable: true });
  routes(req, res);
});

beforeEach(() => {
  currentPeer = '127.0.0.1';
});

describe('what GET /api/config reports and what the connect routes do (DOR-1655)', () => {
  const CALLERS: Array<{
    name: string;
    peer: string;
    host: string;
    headers?: Record<string, string>;
    local: boolean;
  }> = [
    { name: 'a browser on this machine', peer: '127.0.0.1', host: 'localhost', local: true },
    // The shape the whole change exists for. The tunnel agent runs on this
    // machine, so the TCP peer IS loopback; only the `Host` header — written by
    // the phone's browser from the address bar — gives the caller away. The
    // forwarded host names loopback, so a surface that read `req.hostname`
    // instead of the raw `Host` would call it local.
    {
      name: 'a phone over the tunnel',
      peer: '127.0.0.1',
      host: 'quiet-otter-1234.ngrok.app',
      headers: { 'X-Forwarded-Host': 'localhost' },
      local: false,
    },
    // The LAN peer that defeated the header-only check in the DOR-532 probes.
    { name: 'a browser on the LAN', peer: '192.168.86.200', host: 'localhost', local: false },
    // A proxy on this host: loopback peer, loopback `Host`, and a forwarding
    // header, which makes it another device (ADR 261015-125850 rule 1).
    {
      name: 'a same-host proxy that adds a forwarding header',
      peer: '127.0.0.1',
      host: 'localhost',
      headers: { 'X-Forwarded-Host': 'localhost' },
      local: false,
    },
  ];

  it.each(CALLERS)('$name is told exactly what it would be given', async (caller) => {
    currentPeer = caller.peer;
    const config = await request(server)
      .get('/api/config')
      .set('Host', caller.host)
      .set('Cookie', PERSON_SESSION)
      .set(caller.headers ?? {});
    expect(config.status).toBe(200);

    currentPeer = caller.peer;
    const login = await request(server)
      .post('/api/runtimes/codex/login')
      .set('Host', caller.host)
      .set('Cookie', PERSON_SESSION)
      .set(caller.headers ?? {})
      .send({});

    // The answer the app acts on, and the answer the endpoint actually gives.
    expect(config.body.isLocalCaller).toBe(caller.local);
    expect(config.body.isLocalCaller).toBe(login.status !== 403);

    // A per-caller answer must never be served to a different caller out of a
    // shared cache — a reverse proxy, or the tunnel provider's edge. Handing a
    // phone the answer computed for the machine itself puts back the Sign in
    // button that can only 403, which is the whole bug.
    expect(config.headers['cache-control']).toBe('no-store');
  });
});
