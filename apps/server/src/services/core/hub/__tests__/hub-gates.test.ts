/**
 * The doors a hub keeps: the front door every request enters
 * (`http/front-door.ts`) and the stream upgrade router
 * (`services/core/streams/upgrade-router.ts`), over real loopback sockets.
 *
 * Before it serves, a hub answers only the health check. Once it serves, a
 * request must carry exactly one matching front-door proof, which is removed
 * before the app sees it, and name the assigned address. A connection opened
 * while the hub served is dropped once it stops.
 *
 * @vitest-environment node
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { REMOTE_EDGE_PROOF_OVERLAP_SECONDS } from '@dork-labs/cloud-api';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
// A hub always asks for a sign-in (part 1 pins it), which is what lets the
// host guard leave its address to the front-door check.
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: true } : undefined)),
    set: vi.fn(),
  },
}));
vi.mock('../../tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../streams/stream-upgrade-auth.js', () => ({ authorizeStreamUpgrade: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createApiApp } = await import('../../../../http/api-chain.js');
const { frontDoorListener } = await import('../../../../http/front-door.js');
const { MainRequestAdmission } = await import('../../lifecycle/main-request-admission.js');
const { attachUpgradeRouter } = await import('../../streams/upgrade-router.js');
const serving = await import('../hub-serving.js');

const HOST = 'hub-1.example.invalid';
const PROOF = { header: 'x-example-proof', secret: 'a'.repeat(40) };

/** A serving state for an assignment with the given proof and address. */
function servingWith(proof = PROOF, assignmentId = 'asg_1') {
  return {
    state: 'serving',
    assignment: {
      state: 'assigned',
      assignmentId,
      assignedAt: '2026-11-03T09:00:00Z',
      ownerAccountId: 'acct_1',
      issuer: 'https://accounts.example.invalid',
      address: `https://${HOST}`,
      frontDoorProof: proof,
    },
  } as const;
}

/** The headers a request through the front door carries. */
const THROUGH_FRONT_DOOR = { host: HOST, [PROOF.header]: PROOF.secret };

let server: Server;
let port: number;
let entered: () => void;
let reachedHeld: Promise<void>;

beforeEach(async () => {
  role.value = 'hub';
  serving.resetHubServingStateForTests();
  reachedHeld = new Promise((resolve) => (entered = resolve));
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    // Before the session gate, so the case needs no signed-in owner.
    beforeBodyParsing: (early) => {
      early.get('/api/health', (c) =>
        c.json({ ok: true, proofSeen: c.req.header(PROOF.header) ?? null })
      );
      early.get('/api/open', (c) => c.json({ proofSeen: c.req.header(PROOF.header) ?? null }));
      early.get('/api/held', () => {
        entered();
        return new Promise<Response>(() => {});
      });
    },
  });
  server = createServer(frontDoorListener(app));
  attachUpgradeRouter(
    server,
    [
      {
        name: 'stream',
        pattern: /^\/api\/stream$/,
        credential: 'bearer-of-id',
        // Says whether the proof reached it, which it never should.
        authorize: ({ headers }) => ({
          ok: true,
          open: (ws) => ws.send(headers[PROOF.header] === undefined ? 'open' : 'proof leaked'),
        }),
      },
    ],
    new MainRequestAdmission()
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.useRealTimers();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * One GET with raw headers (a repeated name is sent twice), resolving to its
 * status and body, or to `dropped` when the socket closes first.
 */
function get(
  path: string,
  headers: [string, string][] = Object.entries(THROUGH_FRONT_DOOR)
): Promise<{ status: number; body: unknown } | 'dropped'> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: headers.flat() }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || 'null') })
      );
    });
    req.on('error', () => resolve('dropped'));
    req.end();
  });
}

/** The status of one GET. */
async function status(path: string, headers?: [string, string][]): Promise<number | 'dropped'> {
  const res = await get(path, headers);
  return res === 'dropped' ? res : res.status;
}

/** One upgrade, resolving to its refused status or its first message. */
function upgrade(
  headers: Record<string, string> = THROUGH_FRONT_DOOR
): Promise<{ status?: number; message?: string; closed?: true }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, { headers });
  const outcome = new Promise<{ status?: number; message?: string; closed?: true }>((resolve) => {
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    ws.on('message', (raw) => resolve({ message: raw.toString() }));
    ws.on('error', () => {});
    ws.on('close', () => resolve({ closed: true }));
  });
  return outcome.finally(() => ws.terminate());
}

describe('a hub that does not serve yet', () => {
  it('refuses requests and streams, even with the right proof', async () => {
    expect(await status('/api/open')).toBe(503);
    expect(await upgrade()).toEqual({ status: 503 });
  });

  it('answers the health check at exactly its path, with nothing else', async () => {
    const anyHost: [string, string][] = [['host', '10.0.0.7:4242']];
    expect(await status('/api/health', anyHost)).toBe(200);
    expect(await status('/api/health?probe=1', anyHost)).toBe(200);
    for (const near of ['/api/health/', '/API/health', '/api/health/../open', '//api/health']) {
      expect(await status(near, anyHost), near).toBe(503);
    }
  });
});

describe('a hub that serves', () => {
  beforeEach(() => serving.setHubServingState(servingWith()));

  it('lets through what came through its front door, without the proof', async () => {
    expect(await get('/api/open')).toEqual({ status: 200, body: { proofSeen: null } });
    expect(await upgrade()).toEqual({ message: 'open' });
  });

  it('refuses a missing, repeated or wrong proof, for requests and streams', async () => {
    const cases: [string, string][][] = [
      [['host', HOST]],
      [
        ['host', HOST],
        [PROOF.header, PROOF.secret],
        [PROOF.header, PROOF.secret],
      ],
      [
        ['host', HOST],
        [PROOF.header, 'b'.repeat(40)],
      ],
    ];
    for (const headers of cases) {
      expect(await get('/api/open', headers)).toEqual({
        status: 403,
        body: serving.HUB_FRONT_DOOR_BODY,
      });
    }
    expect(await upgrade({ host: HOST })).toEqual({ status: 403 });
  });

  it('refuses any address but its own', async () => {
    // A request with no Host at all never gets this far: Node refuses it.
    for (const host of ['localhost:4242', `${HOST}:8443`, `evil.${HOST}`]) {
      const headers: [string, string][] = [
        ['host', host],
        [PROOF.header, PROOF.secret],
      ];
      expect(await status('/api/open', headers), host).toBe(403);
    }
    expect(await upgrade({ host: 'localhost:4242', [PROOF.header]: PROOF.secret })).toEqual({
      status: 403,
    });
  });

  it('takes the address without regard to case, and with an explicit :443', async () => {
    for (const host of [HOST.toUpperCase(), `${HOST}:443`]) {
      const headers: [string, string][] = [
        ['host', host],
        [PROOF.header, PROOF.secret],
      ];
      expect(await status('/api/open', headers), host).toBe(200);
    }
  });

  it('removes the proof from the health check too', async () => {
    expect(await get('/api/health')).toEqual({ status: 200, body: { ok: true, proofSeen: null } });
  });

  it('accepts a new proof and address before confirming, and both until it confirms', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const next = { header: PROOF.header, secret: 'c'.repeat(40) };
    const moved = {
      ...servingWith(next, 'asg_2').assignment,
      address: 'https://hub-2.example.invalid',
    };
    serving.offerHubAssignment(moved);
    const atNew: [string, string][] = [
      ['host', 'hub-2.example.invalid'],
      [next.header, next.secret],
    ];
    expect(await status('/api/open', atNew)).toBe(200);
    // The confirmation failed or its answer was lost: the old keys still work,
    // however long that lasts.
    vi.advanceTimersByTime(10 * REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 1000);
    expect(await status('/api/open')).toBe(200);
    // Confirmed: the overlap starts now, and the old address goes at once.
    serving.setHubServingState({ state: 'serving', assignment: moved });
    expect(await status('/api/open')).toBe(403);
    const oldProofNewHost: [string, string][] = [
      ['host', 'hub-2.example.invalid'],
      [PROOF.header, PROOF.secret],
    ];
    expect(await status('/api/open', oldProofNewHost)).toBe(200);
    vi.advanceTimersByTime(REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 1000);
    expect(await status('/api/open', oldProofNewHost)).toBe(403);
    expect(await status('/api/open', atNew)).toBe(200);
  });

  it('keeps the overlap deadline when the same assignment is read again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const next = { header: PROOF.header, secret: 'c'.repeat(40) };
    const replaced = servingWith(next, 'asg_2');
    serving.offerHubAssignment(replaced.assignment);
    serving.setHubServingState(replaced);
    vi.advanceTimersByTime(REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 500);
    // The next beat reads and confirms the same assignment again.
    serving.offerHubAssignment(replaced.assignment);
    serving.setHubServingState(replaced);
    vi.advanceTimersByTime(REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 500);
    expect(await status('/api/open')).toBe(403);
  });

  it('accepts the replaced proof for the overlap, then only the new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const next = { header: PROOF.header, secret: 'c'.repeat(40) };
    serving.setHubServingState(servingWith(next, 'asg_2'));
    const withNew: [string, string][] = [
      ['host', HOST],
      [next.header, next.secret],
    ];
    expect(await status('/api/open')).toBe(200);
    expect(await status('/api/open', withNew)).toBe(200);
    vi.advanceTimersByTime(REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 1000);
    expect(await status('/api/open')).toBe(403);
    expect(await status('/api/open', withNew)).toBe(200);
  });

  it('drops an open request when its assignment ends', async () => {
    const held = get('/api/held');
    await reachedHeld;
    serving.setHubServingState({ state: 'ended' });
    expect(await held).toBe('dropped');
    expect(await status('/api/open')).toBe(503);
  });

  it('drops an open stream when it is refused', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, { headers: THROUGH_FRONT_DOOR });
    await once(ws, 'message');
    const closed = once(ws, 'close');
    serving.setHubServingState({ state: 'refused' });
    await closed;
    expect(await upgrade()).toEqual({ status: 503 });
  });
});

describe('a person`s own computer', () => {
  it('asks for no proof and no address', async () => {
    role.value = 'computer';
    expect(await status('/api/open', [['host', 'localhost:4242']])).toBe(200);
    expect(await upgrade({ host: 'localhost:4242' })).toEqual({ message: 'open' });
  });
});
