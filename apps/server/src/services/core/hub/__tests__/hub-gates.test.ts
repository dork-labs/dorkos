/**
 * The two doors a hub keeps shut until it serves: the request chain
 * (`http/api-chain.ts`) and the stream upgrade router
 * (`services/core/streams/upgrade-router.ts`), over real loopback sockets. A
 * connection opened while the hub served is dropped once it stops.
 *
 * @vitest-environment node
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';

vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => 'hub' }));
vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));
vi.mock('../../tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
vi.mock('../../streams/stream-upgrade-auth.js', () => ({ authorizeStreamUpgrade: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createApiApp } = await import('../../../../http/api-chain.js');
const { MainRequestAdmission } = await import('../../lifecycle/main-request-admission.js');
const { attachUpgradeRouter } = await import('../../streams/upgrade-router.js');
const serving = await import('../hub-serving.js');

const SERVING = {
  state: 'serving',
  assignment: {
    state: 'assigned',
    assignmentId: 'asg_1',
    assignedAt: '2026-11-03T09:00:00Z',
    ownerAccountId: 'acct_1',
    issuer: 'https://accounts.example.invalid',
    address: 'https://hub-1.example.invalid',
    frontDoorProof: { header: 'x-example-proof', secret: 's'.repeat(40) },
  },
} as const;

let server: Server;
let port: number;
let entered: () => void;
let reachedHeld: Promise<void>;

beforeEach(async () => {
  serving.resetHubServingStateForTests();
  reachedHeld = new Promise((resolve) => (entered = resolve));
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    // Before the session gate, so the case needs no signed-in owner.
    beforeBodyParsing: (early) => {
      early.get('/api/health', (c) => c.json({ ok: true }));
      early.get('/api/open', (c) => c.json({ ok: true }));
      early.get('/api/held', () => {
        entered();
        return new Promise<Response>(() => {});
      });
    },
  });
  server = createServer(
    getRequestListener(app.fetch, { overrideGlobalObjects: false, autoCleanupIncoming: false })
  );
  attachUpgradeRouter(
    server,
    [
      {
        name: 'stream',
        pattern: /^\/api\/stream$/,
        credential: 'bearer-of-id',
        authorize: () => ({ ok: true, open: (ws) => ws.send('open') }),
      },
    ],
    new MainRequestAdmission()
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** One GET, resolving to its status, or to `dropped` when the socket closes first. */
function get(path: string): Promise<number | 'dropped'> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host: 'localhost:4242' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on('error', () => resolve('dropped'));
    req.end();
  });
}

/** One upgrade, resolving to its refused status or its first message. */
function upgrade(): Promise<{ status?: number; message?: string; closed?: true }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
  return new Promise((resolve) => {
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.on('message', (raw) => resolve({ message: raw.toString() }));
    ws.on('error', () => {});
    ws.on('close', () => resolve({ closed: true }));
  }).finally(() => ws.terminate()) as Promise<{
    status?: number;
    message?: string;
    closed?: true;
  }>;
}

describe('a hub that does not serve yet', () => {
  it('refuses requests and streams, but answers the health check', async () => {
    expect(await get('/api/open')).toBe(503);
    expect(await get('/api/health')).toBe(200);
    expect(await upgrade()).toEqual({ status: 503 });
  });
});

describe('a hub that serves', () => {
  it('lets requests and streams through', async () => {
    serving.setHubServingState(SERVING);
    expect(await get('/api/open')).toBe(200);
    expect(await upgrade()).toEqual({ message: 'open' });
  });

  it('drops an open request when its assignment ends', async () => {
    serving.setHubServingState(SERVING);
    const held = get('/api/held');
    await reachedHeld;
    serving.setHubServingState({ state: 'ended' });
    expect(await held).toBe('dropped');
    expect(await get('/api/open')).toBe(503);
  });

  it('drops an open stream when it is refused', async () => {
    serving.setHubServingState(SERVING);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
    await once(ws, 'message');
    const closed = once(ws, 'close');
    serving.setHubServingState({ state: 'refused' });
    await closed;
    expect(await upgrade()).toEqual({ status: 503 });
  });
});
