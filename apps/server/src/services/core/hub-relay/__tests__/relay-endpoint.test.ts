/**
 * @vitest-environment node
 *
 * The hub's `/api/relay/computer` endpoint: only a serving hub answers it, only
 * a linked computer's relay secret opens it, never a browser, and never before
 * the hub has its signing key. The last case dials it for real, through the
 * upgrade router and the hub's front door, with the computer's own dialer.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { SESSION_RELAY_FEATURES } from '@dorkos/shared/session-relay';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../streams/stream-upgrade-auth.js', () => ({
  authorizeStreamUpgrade: vi.fn(),
  upgradeFacts: vi.fn(() => ({ headers: {} })),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { attachUpgradeRouter } = await import('../../streams/upgrade-router.js');
const { MainRequestAdmission } = await import('../../lifecycle/main-request-admission.js');
const serving = await import('../../hub/hub-serving.js');
const { pinnableKey } = await import('../../session-relay/channel.js');
const { RelayDialer } = await import('../../session-relay/relay-dialer.js');
const { relaySecretHash } = await import('../computer-store.js');
const { linkComputer } = await import('../index.js');
const { hubRelayComputerRoute, setHubRelaySigner } = await import('../relay-endpoint.js');
const { computerConnection } = await import('../hub-relay-registry.js');
type Deps = import('../relay-endpoint.js').HubRelayEndpointDeps;
type Attempt = import('../../streams/upgrade-router.js').UpgradeAttempt;

const HOST = 'hub-1.example.invalid';
const ORIGIN = `https://${HOST}`;
const PROOF = { header: 'x-example-proof', secret: 'a'.repeat(40) };
const SECRET = randomBytes(32).toString('base64url');
const COMPUTER = {
  v: 1 as const,
  computerId: 'computer-1',
  secretHash: relaySecretHash(SECRET),
  computerKey: 'A'.repeat(43),
  linkedAt: '2026-10-16T21:00:00.000Z',
};

/** The route with every dependency answering yes, and `overrides` on top. */
function route(overrides: Partial<Deps> = {}) {
  const accept = vi.fn();
  const deps: Deps = {
    isHub: () => true,
    servingOrigin: () => ORIGIN,
    findComputer: (secret) => (secret === SECRET ? COMPUTER : null),
    sign: () => () => Buffer.alloc(64),
    accept,
    ...overrides,
  };
  return { route: hubRelayComputerRoute(deps), accept };
}

/** Ask the route about an upgrade with these headers. */
async function decide(
  headers: Record<string, string>,
  overrides: Partial<Deps> = {}
): Promise<{ status?: number; message?: string; ok: boolean }> {
  const { route: r } = route(overrides);
  const attempt = { headers, url: new URL('http://x/'), match: [] as unknown, locals: {} };
  const decision = await r.authorize(attempt as Attempt);
  return decision.ok
    ? { ok: true }
    : { ok: false, status: decision.status, message: decision.message };
}

const BEARER = { authorization: `Bearer ${SECRET}` };

describe('the relay endpoint', () => {
  it('claims exactly the computer path', () => {
    const { route: r } = route();
    expect(r.pattern.test('/api/relay/computer')).toBe(true);
    expect(r.pattern.test('/api/relay/computer/x')).toBe(false);
    expect(r.pattern.test('/api/relay/computerx')).toBe(false);
  });

  it('accepts a linked computer on a serving hub that has its key', async () => {
    expect(await decide(BEARER)).toEqual({ ok: true });
  });

  it('is not there on a person’s own computer', async () => {
    expect(await decide(BEARER, { isHub: () => false })).toMatchObject({ status: 404 });
  });

  it('refuses while the hub does not serve, and while it has no signing key', async () => {
    expect(await decide(BEARER, { servingOrigin: () => null })).toMatchObject({ status: 503 });
    expect(await decide(BEARER, { sign: () => null })).toMatchObject({ status: 503 });
  });

  it('refuses anything a browser sent, even with the right secret', async () => {
    expect(await decide({ ...BEARER, origin: ORIGIN })).toMatchObject({ status: 403 });
    expect(await decide({ ...BEARER, 'sec-fetch-site': 'same-origin' })).toMatchObject({
      status: 403,
    });
  });

  it.each([
    ['no secret', {}],
    ['a wrong secret', { authorization: `Bearer ${randomBytes(32).toString('base64url')}` }],
    ['another scheme', { authorization: `Basic ${SECRET}` }],
    ['a stray suffix', { authorization: `Bearer ${SECRET} x` }],
    ['the stored hash', { authorization: `Bearer ${relaySecretHash(SECRET)}` }],
  ])('answers %s with the same bare 401', async (_label, headers) => {
    expect(await decide(headers)).toEqual({ ok: false, status: 401, message: 'Unauthorized' });
  });

  it('answers a right and a wrong secret the same while it has no key', async () => {
    const lookups = vi.fn(() => COMPUTER);
    const noKey = { sign: () => null, findComputer: lookups };
    expect(await decide(BEARER, noKey)).toEqual({
      ok: false,
      status: 503,
      message: 'Service Unavailable',
    });
    expect(await decide({}, noKey)).toEqual({
      ok: false,
      status: 503,
      message: 'Service Unavailable',
    });
    expect(lookups).not.toHaveBeenCalled();
  });
});

describe('a computer dialing its hub for real', () => {
  let server: Server;
  let port: number;
  let home: string;
  const dialers: { close(): void }[] = [];

  beforeEach(async () => {
    role.value = 'hub';
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-relay-e2e-'));
    vi.stubEnv('DORK_HOME', home);
    serving.resetHubServingStateForTests();
    serving.setHubServingState({
      state: 'serving',
      assignment: {
        state: 'assigned',
        assignmentId: 'asg_1',
        assignedAt: '2026-11-03T09:00:00Z',
        ownerAccountId: 'acct_1',
        issuer: 'https://accounts.example.invalid',
        address: ORIGIN,
        frontDoorProof: PROOF,
      },
    } as Parameters<typeof serving.setHubServingState>[0]);
    server = createServer();
    attachUpgradeRouter(server, [hubRelayComputerRoute()], new MainRequestAdmission());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const dialer of dialers.splice(0)) dialer.close();
    setHubRelaySigner(null);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    serving.resetHubServingStateForTests();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A computer pinned to this hub, dialing through the front door. */
  async function computer(hubKey = generateKeyPairSync('ed25519').privateKey) {
    const computerKey = generateKeyPairSync('ed25519').privateKey;
    const relaySecret = randomBytes(32).toString('base64url');
    await linkComputer({
      computerId: 'computer-1',
      secretHash: relaySecretHash(relaySecret),
      computerKey: pinnableKey(computerKey),
    });
    const dialer = new RelayDialer({
      readPin: () => ({
        v: 1,
        computerId: 'computer-1',
        hubOrigin: ORIGIN,
        hubKey: pinnableKey(hubKey),
        relaySecret,
        pinnedAt: '2026-10-16T21:00:00.000Z',
      }),
      ownerExists: () => true,
      computerKey: () => computerKey,
      appVersion: '0.118.0',
      server: {
        features: () => SESSION_RELAY_FEATURES,
        handle: (frame, emit) => {
          if (frame.type === 'request' && frame.request.op === 'chats.list') {
            emit({ type: 'result', id: frame.id, ok: true, body: { chats: [] } });
          }
        },
        closeAll: () => undefined,
        endStream: () => false,
      },
      // The front door adds its proof and the assigned Host on the way in.
      connect: (url, headers) => {
        expect(url).toBe(`wss://${HOST}/api/relay/computer`);
        return new WebSocket(`ws://127.0.0.1:${port}/api/relay/computer`, {
          headers: { ...headers, host: HOST, [PROOF.header]: PROOF.secret },
          perMessageDeflate: false,
        }) as never;
      },
    });
    dialers.push(dialer);
    return { dialer, hubKey };
  }

  it('connects, proves both ends and answers a request through the hub', async () => {
    const hubKey = generateKeyPairSync('ed25519').privateKey;
    setHubRelaySigner((data) => sign(null, data, hubKey));
    const { dialer } = await computer(hubKey);
    expect(dialer.onViewerOpen('2099-01-01T00:00:00.000Z')).toBe('applied');
    await vi.waitFor(() => expect(computerConnection('computer-1')).not.toBeNull());
    expect(dialer.connected).toBe(true);
    const result = await computerConnection('computer-1')!.request({
      op: 'chats.list',
      agentId: '01KJXYKJYW4N8QGQ5W4GB6YM9J',
    });
    expect(result).toEqual({ ok: true, body: { chats: [] } });
  });

  it('closes a computer’s connection when it is linked again with a new key', async () => {
    const hubKey = generateKeyPairSync('ed25519').privateKey;
    setHubRelaySigner((data) => sign(null, data, hubKey));
    const { dialer } = await computer(hubKey);
    dialer.onViewerOpen('2099-01-01T00:00:00.000Z');
    await vi.waitFor(() => expect(computerConnection('computer-1')).not.toBeNull());
    await linkComputer({
      computerId: 'computer-1',
      secretHash: relaySecretHash(randomBytes(32).toString('base64url')),
      computerKey: pinnableKey(generateKeyPairSync('ed25519').privateKey),
    });
    expect(computerConnection('computer-1')).toBeNull();
    await vi.waitFor(() => expect(dialer.connected).toBe(false));
  });

  it('refuses every dial while the hub has no signing key', async () => {
    const statuses = await Promise.all([dialRaw({ authorization: 'Bearer x' }), dialRaw({})]);
    expect(statuses).toEqual([503, 503]);
    const { dialer } = await computer();
    dialer.onViewerOpen('2099-01-01T00:00:00.000Z');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dialer.connected).toBe(false);
    expect(computerConnection('computer-1')).toBeNull();
  });

  it('keeps the front door: no proof, no relay', async () => {
    setHubRelaySigner(() => Buffer.alloc(64));
    const linked = randomBytes(32).toString('base64url');
    await linkComputer({
      computerId: 'computer-2',
      secretHash: relaySecretHash(linked),
      computerKey: pinnableKey(generateKeyPairSync('ed25519').privateKey),
    });
    expect(await dialRaw({ authorization: `Bearer ${linked}` }, false)).toBe(403);
    expect(await dialRaw({ authorization: `Bearer ${linked}`, origin: ORIGIN })).toBe(403);
    expect(await dialRaw({ authorization: `Bearer ${linked}` })).toBe(101);
  });

  /** One raw dial; resolves to the refused status, or 101 when it opened. */
  function dialRaw(headers: Record<string, string>, frontDoor = true): Promise<number> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/computer`, {
      headers: { host: HOST, ...(frontDoor ? { [PROOF.header]: PROOF.secret } : {}), ...headers },
    });
    return new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      ws.on('open', () => resolve(101));
      ws.on('error', () => resolve(0));
    }).finally(() => ws.terminate());
  }
});
