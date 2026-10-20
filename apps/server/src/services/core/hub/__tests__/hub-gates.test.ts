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
import { request as httpRequest, type Server } from 'node:http';
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
// As in a built DorkOS, so the hub's cookie names apply.
vi.mock('../../auth/cookie-security.js', () => ({ AUTH_COOKIES_SECURE: true }));
vi.mock('../../tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../streams/stream-upgrade-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../streams/stream-upgrade-auth.js')>()),
  authorizeStreamUpgrade: vi.fn(),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createApiApp } = await import('../../../../http/api-chain.js');
const { createFrontDoorServer } = await import('../../../../http/front-door.js');
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
      early.post('/api/change', (c) => c.json({ changed: true }));
      early.get('/api/events', (c) => c.json({ stream: true }));
      early.get('/api/cookie', (c) => {
        c.header(
          'Set-Cookie',
          '__Secure-better-auth.session_token=new; Domain=example.invalid; Path=/api; HttpOnly; Secure'
        );
        return c.json({ cookie: c.req.header('cookie') ?? null });
      });
      early.get('/api/held', () => {
        entered();
        return new Promise<Response>(() => {});
      });
    },
  });
  // Built as the server builds its own listeners, upgrade hooks included.
  server = createFrontDoorServer(app);
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
      {
        name: 'cookie-stream',
        pattern: /^\/api\/cookie-stream$/,
        credential: 'bearer-of-id',
        // Says which sign-in cookie the stream's authorization would read.
        authorize: ({ headers }) => ({
          ok: true,
          open: (ws) => ws.send(String(headers.cookie ?? '(none)')),
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
  headers: [string, string][] = Object.entries(THROUGH_FRONT_DOOR),
  method = 'GET'
): Promise<{ status: number; body: unknown; setCookie?: string[] } | 'dropped'> {
  return new Promise((resolve) => {
    const options = { host: '127.0.0.1', port, path, method, headers: headers.flat() };
    const req = httpRequest(options, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(text || 'null'),
          ...(res.headers['set-cookie'] ? { setCookie: res.headers['set-cookie'] } : {}),
        })
      );
    });
    req.on('error', () => resolve('dropped'));
    req.end();
  });
}

/** The status of one request. */
async function status(
  path: string,
  headers?: [string, string][],
  method?: string
): Promise<number | 'dropped'> {
  const res = await get(path, headers, method);
  return res === 'dropped' ? res : res.status;
}

/** The front-door headers plus `extra`. */
function through(...extra: [string, string][]): [string, string][] {
  return [...(Object.entries(THROUGH_FRONT_DOOR) as [string, string][]), ...extra];
}

/** One upgrade, resolving to its refused status or its first message. */
function upgrade(
  headers: Record<string, string> = { ...THROUGH_FRONT_DOOR, origin: `https://${HOST}` }
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

describe('a serving hub, against other sites (A5)', () => {
  beforeEach(() => serving.setHubServingState(servingWith()));
  const OWN = `https://${HOST}`;

  it('takes a change, a stream or a socket from its own page', async () => {
    const ownPage = through(['origin', OWN], ['sec-fetch-site', 'same-origin']);
    expect(await status('/api/change', ownPage, 'POST')).toBe(200);
    const stream = through(['accept', 'text/event-stream'], ['sec-fetch-site', 'same-origin']);
    expect(await status('/api/events', stream)).toBe(200);
    expect(await upgrade()).toEqual({ message: 'open' });
  });

  it('refuses a change, a stream or a socket from another site', async () => {
    for (const headers of [
      through(['origin', 'https://elsewhere.example.invalid']),
      through(['sec-fetch-site', 'same-site']),
      through(['sec-fetch-site', 'cross-site']),
      through(['origin', 'null']),
    ]) {
      expect(await get('/api/change', headers, 'POST')).toEqual({
        status: 403,
        body: serving.HUB_CROSS_SITE_BODY,
      });
    }
    const stream = through(['accept', 'text/event-stream'], ['sec-fetch-site', 'cross-site']);
    expect(await status('/api/events', stream)).toBe(403);
    const elsewhere = { ...THROUGH_FRONT_DOOR, origin: 'https://elsewhere.example.invalid' };
    expect(await upgrade(elsewhere)).toEqual({ status: 403 });
  });

  it('lets a plain read through from a link anywhere, and a caller that is not a browser', async () => {
    expect(await status('/api/open', through(['sec-fetch-site', 'cross-site']))).toBe(200);
    expect(await status('/api/change', through(), 'POST')).toBe(200);
  });

  it('hands a stream the sign-in cookie under the name the auth stack set', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/cookie-stream`, {
      headers: {
        ...THROUGH_FRONT_DOOR,
        origin: OWN,
        cookie: '__Secure-better-auth.session_token=planted; __Host-better-auth.session_token=real',
      },
    });
    const [message] = await once(ws, 'message');
    ws.terminate();
    expect(String(message)).toBe('__Secure-better-auth.session_token=real');
  });

  it('gives sign-in cookies the __Host- prefix and believes only that one', async () => {
    const cookies =
      '__Secure-better-auth.session_token=planted; __Host-better-auth.session_token=real';
    const res = await get('/api/cookie', through(['cookie', cookies]));
    expect(res).toMatchObject({
      status: 200,
      body: { cookie: '__Secure-better-auth.session_token=real' },
      setCookie: ['__Host-better-auth.session_token=new; HttpOnly; Path=/; Secure'],
    });
  });
});

describe('a person`s own computer', () => {
  it('asks for no proof and no address', async () => {
    role.value = 'computer';
    expect(await status('/api/open', [['host', 'localhost:4242']])).toBe(200);
    expect(await upgrade({ host: 'localhost:4242' })).toEqual({ message: 'open' });
  });
});
