/**
 * `isAtThisComputer` from `gate-policy.ts`: whether a request is a person at
 * this computer, for the actions reserved for one (signing a runtime in,
 * finishing an MCP sign-in, remote-access settings, the local browser,
 * onboarding). It replaced `isLocalCaller` (DOR-2967, ADR 261015-125850
 * rule 1), and reads the request classifier rather than its own rules.
 *
 * Its own file because it replaces `env.js` wholesale to move
 * `DORKOS_ALLOW_INSECURE_BIND` per test.
 *
 * Every case runs through a real Hono app, reading the request's facts as a
 * route does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import type { RequestFactsEnv } from '../../../../http/request-facts.js';
import type { IngressKind } from '../../remote/ingress-mark.js';
import { honoListener, listeningServer } from '@dorkos/test-utils/listening-server';

// Mutable stand-in so the container flag can be moved one test at a time — the
// reader consults it per request, which is the behaviour under test. Same shape
// `middleware/__tests__/host-guard.test.ts` uses for the same variable.
const mockEnv = vi.hoisted(() => ({
  DORKOS_ALLOW_INSECURE_BIND: false,
  DORKOS_SERVER_ROLE: 'computer' as 'computer' | 'hub',
}));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));
// The gate policy's other inputs. `isAtThisComputer` reads neither: whether
// this computer asks for a password, or an owner exists, never changes WHERE a
// request came from.
vi.mock('../../config-manager.js', () => ({ configManager: { get: () => undefined } }));
vi.mock('../index.js', () => ({ hasAnyUser: () => false }));

const { isAtThisComputer, isOnEncryptedConnection } = await import('../gate-policy.js');
const { honoRequestFacts } = await import('../../../../http/request-facts.js');
const { markIngress } = await import('../../remote/ingress-mark.js');

/**
 * The TCP peer the app reports for the current test. `null` spells "the socket
 * reports no address", which is a DIFFERENT case from "the test did not say" —
 * writing that case as `undefined` would silently re-trigger `probe`'s default
 * parameter and quietly measure a loopback peer instead.
 */
let currentPeer: string | null = '127.0.0.1';

/** The marked listener the current test's request arrived through, if any. */
let viaIngress: IngressKind | null = null;

// One app, one listener: the peer is rewritten per request so a LAN caller can
// be simulated without a second network interface, exactly as the runtime
// connect route's own peer tests do.
const honoApp = new Hono<RequestFactsEnv>();
honoApp.get('/probe', (c) => {
  Object.defineProperty(c.env.incoming.socket, 'remoteAddress', {
    value: currentPeer ?? undefined,
    configurable: true,
  });
  if (viaIngress) markIngress(c.env.incoming, viaIngress);
  return c.json({
    local: isAtThisComputer(honoRequestFacts(c)),
    encrypted: isOnEncryptedConnection(honoRequestFacts(c)),
  });
});

const server = listeningServer(honoListener(honoApp));

beforeEach(() => {
  mockEnv.DORKOS_ALLOW_INSECURE_BIND = false;
  mockEnv.DORKOS_SERVER_ROLE = 'computer';
  currentPeer = '127.0.0.1';
  viaIngress = null;
});

describe('isAtThisComputer', () => {
  /** Ask the probe with a given `Host` header, TCP peer and extra headers. */
  async function probe(
    host: string,
    peer: string | null = '127.0.0.1',
    headers: Record<string, string> = {}
  ): Promise<boolean> {
    currentPeer = peer;
    const res = await request(server).get('/probe').set('Host', host).set(headers);
    expect(res.status).toBe(200);
    return res.body.local as boolean;
  }

  it('admits a loopback peer asking for a loopback host', async () => {
    expect(await probe('localhost:4242')).toBe(true);
    expect(await probe('127.0.0.1:4242')).toBe(true);
    expect(await probe('[::1]:4242', '::1')).toBe(true);
  });

  it('refuses the tunnel: a loopback peer asking for a public host', async () => {
    // The tunnel agent runs on this machine, so the peer IS loopback; only the
    // `Host` header — which the phone's browser writes from the address bar —
    // says the request came from somewhere else.
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

  it('refuses a same-host proxy that adds a forwarding header, though peer and Host read local', async () => {
    // New with the classifier: `isLocalCaller` ignored forwarding headers, so
    // nginx or `ssh -L` rewriting `Host` to localhost read as this computer.
    expect(await probe('localhost:4242', '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).toBe(
      false
    );
    expect(await probe('localhost:4242', '127.0.0.1', { via: '1.1 proxy' })).toBe(false);
  });

  it('refuses a page on another site writing to this computer', async () => {
    expect(await probe('localhost:4242', '127.0.0.1', { origin: 'https://evil.example' })).toBe(
      false
    );
    // A page on this machine, on any port, is still this computer.
    expect(await probe('localhost:4242', '127.0.0.1', { origin: 'http://localhost:6241' })).toBe(
      true
    );
  });

  it('admits a direct network request under DORKOS_ALLOW_INSECURE_BIND: the container is the computer', async () => {
    // Under that flag the container's published port is how its owner reaches
    // it; the gate has already asked for a password whenever an owner exists.
    mockEnv.DORKOS_ALLOW_INSECURE_BIND = true;
    expect(await probe('dorkos.example.com', '172.17.0.1')).toBe(true);
  });

  it('refuses a request the managed ingress admitted, under any Host and any flag', async () => {
    // The forwarding agent is on loopback, so peer and Host could both read
    // local; the ingress mark is what says a person is on another device.
    viaIngress = 'managed';
    expect(await probe('localhost:4242')).toBe(false);
    mockEnv.DORKOS_ALLOW_INSECURE_BIND = true;
    expect(await probe('localhost:4242')).toBe(false);
  });

  it.each<IngressKind>(['own-tunnel', 'wifi', 'relay'])(
    'refuses the %s listener under any Host and any flag, where isLocalCaller admitted it',
    async (kind) => {
      // F1 changed this: the own tunnel and Wi-Fi are other devices, so a
      // loopback `Host` through them no longer reads as this computer, and the
      // container flag never widens a marked listener.
      viaIngress = kind;
      expect(await probe('localhost:4242')).toBe(false);
      expect(await probe('abc.ngrok.app')).toBe(false);
      mockEnv.DORKOS_ALLOW_INSECURE_BIND = true;
      expect(await probe('localhost:4242')).toBe(false);
      expect(await probe('abc.ngrok.app')).toBe(false);
    }
  );

  it('is never true on a hub, even from loopback with a loopback Host (DOR-2934)', async () => {
    expect(await probe('localhost:4242')).toBe(true);
    mockEnv.DORKOS_SERVER_ROLE = 'hub';
    expect(await probe('localhost:4242')).toBe(false);
    mockEnv.DORKOS_ALLOW_INSECURE_BIND = true;
    expect(await probe('localhost:4242')).toBe(false);
  });
});

// Where a signed-in person connects from changes nothing on an encrypted
// connection (DOR-3172). This file runs as a development build: its sign-in
// cookie is not `Secure`, so a proxy counts only when it says `https`.
describe('isOnEncryptedConnection', () => {
  async function encrypted(
    headers: Record<string, string> = {},
    peer: string | null = '127.0.0.1'
  ): Promise<boolean> {
    currentPeer = peer;
    const res = await request(server)
      .get('/probe')
      .set('Host', 'localhost:4242')
      .set(headers);
    expect(res.status).toBe(200);
    return res.body.encrypted as boolean;
  }

  it('counts the own tunnel and managed remote access', async () => {
    for (const ingress of ['own-tunnel', 'managed'] as const) {
      viaIngress = ingress;
      expect(await encrypted()).toBe(true);
    }
  });

  it('never counts plain-http Wi-Fi, the relay or this computer itself', async () => {
    for (const ingress of ['wifi', 'relay'] as const) {
      viaIngress = ingress;
      expect(await encrypted({ 'x-forwarded-proto': 'https' })).toBe(false);
    }
    viaIngress = null;
    expect(await encrypted()).toBe(false);
  });

  it('counts a proxy on this host that says https, and no other', async () => {
    const proxied = { 'x-forwarded-for': '100.64.0.7' };
    expect(await encrypted({ ...proxied, 'x-forwarded-proto': 'https' })).toBe(true);
    // The last value is the proxy's own; an earlier one is the browser's to write.
    expect(await encrypted({ ...proxied, 'x-forwarded-proto': 'http, https' })).toBe(true);
    expect(await encrypted({ ...proxied, 'x-forwarded-proto': 'https, http' })).toBe(false);
    expect(await encrypted({ ...proxied, 'x-forwarded-proto': 'http' })).toBe(false);
    expect(await encrypted(proxied)).toBe(false);
  });

  it('never counts a bare network bind, whatever its headers claim', async () => {
    expect(
      await encrypted(
        { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' },
        '192.168.86.200'
      )
    ).toBe(false);
    expect(await encrypted({ 'x-forwarded-proto': 'https' }, '192.168.86.200')).toBe(false);
  });

  it('never counts a hub: it has its own bar', async () => {
    mockEnv.DORKOS_SERVER_ROLE = 'hub';
    viaIngress = 'own-tunnel';
    expect(await encrypted()).toBe(false);
  });
});
