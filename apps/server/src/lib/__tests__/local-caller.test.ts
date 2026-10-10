/**
 * `isLocalCaller` from `lib/caller-authority.ts` — the WHERE half of that module.
 *
 * Its own file beside `caller-authority.test.ts` rather than a describe inside
 * it, because this one replaces `env.js` wholesale to move
 * `DORKOS_ALLOW_INSECURE_BIND` per test. That mock would reach every other
 * assertion in the file next door, which is about who a caller is and reads real
 * config.
 *
 * Every case runs through a real Express app AND a real Hono app (DOR-2794):
 * both chains must call the same caller local.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import type { RequestFactsEnv } from '../../http/request-facts.js';
import { honoListener, listeningServer } from '@dorkos/test-utils/listening-server';

// Mutable stand-in so the container flag can be moved one test at a time — the
// reader consults it per request, which is the behaviour under test. Same shape
// `middleware/__tests__/host-guard.test.ts` uses for the same variable.
const mockEnv = vi.hoisted(() => ({ DORKOS_ALLOW_INSECURE_BIND: false }));
vi.mock('../../env.js', () => ({ env: mockEnv }));

const { isLocalCaller } = await import('../caller-authority.js');
const { honoRequestFacts } = await import('../../http/request-facts.js');
const { markManagedIngress } = await import('../../services/core/remote/ingress-mark.js');

/**
 * The TCP peer the app reports for the current test. `null` spells "the socket
 * reports no address", which is a DIFFERENT case from "the test did not say" —
 * writing that case as `undefined` would silently re-trigger `probe`'s default
 * parameter and quietly measure a loopback peer instead.
 */
let currentPeer: string | null = '127.0.0.1';

/** Whether the current test's request arrived through the managed ingress. */
let viaManagedIngress = false;

// One app, one listener: the peer is rewritten per request so a LAN caller can
// be simulated without a second network interface, exactly as the runtime
// connect route's own peer tests do.
const app = express();
app.use((req, _res, next) => {
  Object.defineProperty(req.socket, 'remoteAddress', {
    value: currentPeer ?? undefined,
    configurable: true,
  });
  if (viaManagedIngress) markManagedIngress(req);
  next();
});
app.get('/probe', (req, res) => res.json({ local: isLocalCaller(req) }));

// The same probe as a moved route would ask it.
const honoApp = new Hono<RequestFactsEnv>();
honoApp.get('/probe', (c) => {
  Object.defineProperty(c.env.incoming.socket, 'remoteAddress', {
    value: currentPeer ?? undefined,
    configurable: true,
  });
  if (viaManagedIngress) markManagedIngress(c.env.incoming);
  return c.json({ local: isLocalCaller(honoRequestFacts(c)) });
});

const servers = {
  express: listeningServer(app),
  hono: listeningServer(honoListener(honoApp)),
};

beforeEach(() => {
  mockEnv.DORKOS_ALLOW_INSECURE_BIND = false;
  currentPeer = '127.0.0.1';
  viaManagedIngress = false;
});

describe.each(['express', 'hono'] as const)('isLocalCaller, through %s', (chain) => {
  /** Ask the probe with a given `Host` header and TCP peer. */
  async function probe(host: string, peer: string | null = '127.0.0.1'): Promise<boolean> {
    currentPeer = peer;
    const res = await request(servers[chain]).get('/probe').set('Host', host);
    expect(res.status).toBe(200);
    return res.body.local as boolean;
  }

  it('admits a loopback peer asking for a loopback host', async () => {
    expect(await probe('localhost:4242')).toBe(true);
    expect(await probe('127.0.0.1:4242')).toBe(true);
    expect(await probe('[::1]:4242', '::1')).toBe(true);
  });

  it('refuses the tunnel: a loopback peer asking for a public host', async () => {
    // The shape this whole change exists for. The tunnel agent runs on this
    // machine, so the peer IS loopback; only the `Host` header — which the
    // phone's browser writes from the address bar and cannot lie about — says
    // the request came from somewhere else.
    expect(await probe('quiet-otter-1234.ngrok.app')).toBe(false);
  });

  it('refuses a LAN browser: a remote peer, whatever it writes in Host', async () => {
    expect(await probe('192.168.86.20:4242', '192.168.86.200')).toBe(false);
    // Forging the header does not help — the peer is the half no caller writes.
    expect(await probe('localhost:4242', '192.168.86.200')).toBe(false);
  });

  it('refuses a request whose socket is already gone', async () => {
    expect(await probe('localhost:4242', null)).toBe(false);
  });

  it('admits everything under DORKOS_ALLOW_INSECURE_BIND, as the connect routes do', async () => {
    // Not a leniency of this reader's own: under that flag the loopback-only
    // endpoints accept, so reporting anything stricter would tell a Docker
    // operator that sign-in needs a computer they cannot walk to.
    mockEnv.DORKOS_ALLOW_INSECURE_BIND = true;
    expect(await probe('dorkos.example.com', '172.17.0.1')).toBe(true);
  });

  it('refuses a request the managed ingress admitted, under any Host and any flag', async () => {
    // The forwarding agent is on loopback, so peer and Host could both read
    // local; the ingress mark is what says a person is on another device.
    viaManagedIngress = true;
    expect(await probe('localhost:4242')).toBe(false);
    mockEnv.DORKOS_ALLOW_INSECURE_BIND = true;
    expect(await probe('localhost:4242')).toBe(false);
  });
});
