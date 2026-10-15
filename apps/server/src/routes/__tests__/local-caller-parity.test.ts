/**
 * `GET /api/config` reports `isLocalCaller` so the app can offer honest guidance
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
 * `Host` header, the exact bug DOR-532 fixed on the refusal side — took two
 * deliberate pieces of setup, because without them this file could not see it
 * at all: `trust proxy` on the app, and an `X-Forwarded-Host` on every request.
 * Express only prefers the forwarded header when both are present, so on a bare
 * app `req.hostname` and `Host` are always equal and the mutation is invisible.
 * With them, the tunnel row reds. Verified in both directions rather than
 * assumed — an earlier version of this header claimed the coverage without
 * having it.
 *
 * It lives in its own file rather than inside `runtimes-connect.test.ts`
 * because mounting the config router drags in that route's whole import graph
 * (relay, skills, the config store), and that focused suite should not have to
 * carry it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Never spawn a vendor CLI: the login route is one of the two surfaces under
// test and its action would otherwise run `claude auth login` for real.
vi.mock('../../services/runtimes/connect/delegated-login.js', async (orig) => {
  const actual = await orig<typeof import('../../services/runtimes/connect/delegated-login.js')>();
  return { ...actual, delegateRuntimeLogin: vi.fn().mockResolvedValue({ ok: true }) };
});

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
  const CALLERS = [
    { name: 'a browser on this machine', peer: '127.0.0.1', host: 'localhost', local: true },
    // The shape the whole change exists for. The tunnel agent runs on this
    // machine, so the TCP peer IS loopback; only the `Host` header — written by
    // the phone's browser from the address bar — gives the caller away.
    {
      name: 'a phone over the tunnel',
      peer: '127.0.0.1',
      host: 'quiet-otter-1234.ngrok.app',
      local: false,
    },
    // The LAN peer that defeated the header-only check in the DOR-532 probes.
    { name: 'a browser on the LAN', peer: '192.168.86.200', host: 'localhost', local: false },
  ];

  it.each(CALLERS)('$name is told exactly what it would be given', async (caller) => {
    // Both requests carry a forwarded host naming loopback, which is what a
    // caller-controlled header looks like — a tunnel or proxy hop writes one,
    // and so can anyone. Only the RAW `Host` may decide, so this is the input
    // that separates the correct read from `req.hostname`.
    currentPeer = caller.peer;
    const config = await request(server)
      .get('/api/config')
      .set('Host', caller.host)
      .set('X-Forwarded-Host', 'localhost');
    expect(config.status).toBe(200);

    currentPeer = caller.peer;
    const login = await request(server)
      .post('/api/runtimes/claude-code/login')
      .set('Host', caller.host)
      .set('X-Forwarded-Host', 'localhost')
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
