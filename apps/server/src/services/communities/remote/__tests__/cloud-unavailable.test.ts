/**
 * @vitest-environment node
 *
 * Standalone proof, DorkOS side: every step this app takes in a Community
 * membership journey works with DorkOS Cloud unreachable (spec
 * `community-membership-journeys`, verification matrix: "The full journey works
 * with DorkOS Cloud egress blocked"; task 3.2). The Community server's own half
 * is `apps/community/src/__tests__/tenancy-egress.integration.test.ts`.
 *
 * Before any code opens a socket, this file wraps every TCP/TLS connect, every
 * DNS lookup and direct DNS query (`dns.resolve*`, `Resolver`, both callback
 * and promise forms), and every UDP send or connect in the process (the same
 * guard as the Community's `tenancy-egress` proof). Loopback stays reachable; anything else is
 * recorded and refused, as a firewall that blocks all egress would. That is
 * strictly stronger than blocking DorkOS Cloud alone, and it is proven to
 * catch a real `fetch` to Cloud before the journey starts.
 *
 * The journey then runs through the real local routes, pairing service,
 * encrypted connection store and native adapter, against a Community on
 * 127.0.0.1: connect this installation, wait for approval, list it, read its
 * channels and history, and disconnect it (which revokes the grant on the
 * Community). The recorded list must be empty at the end. Only the owner check
 * is stubbed, exactly as the other route tests stub it.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ---- the egress guard, installed at module evaluation, before any socket opens ----

/** Every outbound attempt the guard refused, as `kind host:port`. */
const refused: string[] = [];

function isLocal(host: string | undefined): boolean {
  return (
    host === undefined ||
    host === '' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.')
  );
}

function connectTarget(args: unknown[]): { host?: string; port?: unknown; path?: string } {
  // net.connect() hands Socket#connect its normalized arguments as one array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') return first as { host?: string; path?: string };
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first)))
    return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (typeof first === 'string') return { path: first };
  return {};
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const target = connectTarget(args);
  if (target.path === undefined && !isLocal(target.host)) {
    refused.push(`connect ${target.host}:${String(target.port)}`);
    const error = Object.assign(new Error('Egress is blocked in this test'), {
      code: 'ECONNREFUSED',
    });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return (originalConnect as (...rest: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

function blockedLookup(hostname: string) {
  refused.push(`dns ${hostname}`);
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
}
const originalLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
  if (!isLocal(hostname)) {
    const callback = rest.at(-1) as (error: Error) => void;
    process.nextTick(() => callback(blockedLookup(hostname)));
    return undefined as ReturnType<typeof dns.lookup>;
  }
  return (originalLookup as (...all: unknown[]) => unknown).call(dns, hostname, ...rest);
} as typeof dns.lookup;
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function guardedPromiseLookup(hostname: string, ...rest: unknown[]) {
  if (!isLocal(hostname)) throw blockedLookup(hostname);
  return (originalPromiseLookup as (...all: unknown[]) => Promise<unknown>).call(
    dns.promises,
    hostname,
    ...rest
  );
} as typeof dns.promises.lookup;

// Direct DNS queries always go to a resolver off the host, so every one is refused.
type Patchable = Record<string, unknown>;
const restores: (() => void)[] = [];
function blockResolvers(target: Patchable, style: 'callback' | 'promise') {
  for (const name of Object.keys(target)) {
    if (!/^(resolve|reverse)/.test(name) || typeof target[name] !== 'function') continue;
    const original = target[name];
    target[name] = function blockedResolve(hostname: string, ...rest: unknown[]) {
      const error = blockedLookup(`${name} ${hostname}`);
      if (style === 'promise') return Promise.reject(error);
      const callback = rest.at(-1) as (error: Error) => void;
      process.nextTick(() => callback(error));
      return undefined;
    };
    restores.push(() => {
      target[name] = original;
    });
  }
}
blockResolvers(dns as unknown as Patchable, 'callback');
blockResolvers(dns.Resolver.prototype as unknown as Patchable, 'callback');
blockResolvers(dns.promises as unknown as Patchable, 'promise');
blockResolvers(dns.promises.Resolver.prototype as unknown as Patchable, 'promise');

// UDP: refuse a send or connect to anything but a local address.
function udpTarget(args: unknown[]): { port?: unknown; host?: string } {
  const portIndex = args.findIndex((arg, index) => index > 0 && typeof arg === 'number');
  const port = args[portIndex];
  const host =
    typeof args[portIndex + 1] === 'string' ? (args[portIndex + 1] as string) : undefined;
  return { port, host };
}
for (const method of ['send', 'connect'] as const) {
  const original = dgram.Socket.prototype[method] as (...args: unknown[]) => unknown;
  (dgram.Socket.prototype as unknown as Patchable)[method] = function guardedUdp(
    this: dgram.Socket,
    ...args: unknown[]
  ) {
    const target =
      method === 'connect'
        ? { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined }
        : udpTarget(args);
    if (!isLocal(target.host)) {
      refused.push(`udp ${target.host}:${String(target.port)}`);
      const callback = args.at(-1);
      const error = Object.assign(new Error('Egress is blocked in this test'), {
        code: 'ECONNREFUSED',
      });
      if (typeof callback === 'function') process.nextTick(() => callback(error));
      return undefined;
    }
    return original.apply(this, args);
  };
  restores.push(() => {
    (dgram.Socket.prototype as unknown as Patchable)[method] = original;
  });
}

// ---- the local owner, stubbed as every community route test stubs it ----

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../../routes/room-caller.js', () => ({
  resolveCaller: () => ({ id: 'owner-a' }),
}));
vi.mock('../../../rooms/index.js', () => ({
  getRoomService: () => ({ authorRegistry: { isOwner: (id: string) => id === 'owner-a' } }),
}));
vi.mock('../../../core/auth/index.js', () => ({
  readOwnerAccount: () => ({ id: 'owner-a' }),
}));
vi.mock('../../../../lib/caller-authority.js', () => ({
  isLocalCaller: () => true,
  requireOperatorCookieUnderLogin: () => undefined,
}));

import { createCommunityConnectionsRouter } from '../../../../routes/community-connections.js';
import { createRemoteCommunitiesRouter } from '../../../../routes/remote-communities.js';
import {
  getRemotePairingService,
  setRemoteCommunityDb,
  setRemoteCommunityLifecycle,
} from '../state.js';

// ---- a Community on loopback, speaking the v1 wire contract ----

const communityId = randomUUID();
const channelId = randomUUID();
const tenant = `/api/v1/communities/${communityId}`;
const bearer = `grant-${randomUUID()}`;
const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
let approved = false;
const revocations: string[] = [];
let community: Server;
let origin: string;
let app: Server;

function channel() {
  return {
    id: channelId,
    name: 'general',
    description: null,
    visibility: 'public',
    archived: false,
    createdAt: '2026-09-23T12:00:00.000Z',
    joined: true,
    unreadCount: 1,
  };
}

beforeAll(async () => {
  home.dir = await mkdtemp(join(tmpdir(), 'community-cloud-unavailable-'));
  process.env.DORK_HOME = home.dir;
  community = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const path = new URL(req.url ?? '/', 'http://community.test').pathname;
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const authorized = req.headers.authorization === `Bearer ${bearer}`;
    if (path === `${tenant}/community`)
      return send({
        id: communityId,
        name: 'First Place',
        description: null,
        createdAt: '2026-09-23T12:00:00.000Z',
      });
    if (path === `${tenant}/pairings/start`) {
      const pairingId = randomUUID();
      return send(
        {
          pairingId,
          approvalUrl: `${origin}/c/${communityId}/pairing?pairingId=${pairingId}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        201
      );
    }
    if (path === `${tenant}/pairings/poll`)
      return send(approved ? { status: 'approved', code: 'one-time-code' } : { status: 'pending' });
    if (path === `${tenant}/pairings/exchange`)
      return send({
        token: bearer,
        grant: {
          id: randomUUID(),
          memberId: 'member-ria',
          installName: 'Studio desktop',
          scopes: ['read', 'post', 'enroll-agent'],
          lifecycle: 'active',
          capabilities,
          createdAt: new Date().toISOString(),
        },
      });
    if (!authorized) return send({ code: 'UNAUTHENTICATED', message: 'Sign in.' }, 401);
    if (path === `${tenant}/me/connection-access`)
      return send({
        access: {
          state: 'verified',
          effective: capabilities,
          lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
        },
      });
    if (path === `${tenant}/attention`) return send({ unreadCount: 1, mentionCount: 0 });
    if (path === `${tenant}/channels`) return send({ channels: [channel()] });
    if (path === `${tenant}/channels/${channelId}`) return send({ channel: channel() });
    if (path === `${tenant}/channels/${channelId}/entries`)
      return send({
        entries: [
          {
            id: 'entry-1',
            channelId,
            seq: 1,
            authorMemberId: 'member-kai',
            authorDisplayName: 'Kai',
            authorKind: 'human',
            text: 'Welcome in.',
            mentions: [],
            parentEntryId: null,
            threadRootEntryId: null,
            createdAt: '2026-09-23T12:00:00.000Z',
            cursor: 'resume-1',
            attachments: [],
          },
        ],
        nextCursor: null,
      });
    if (req.method === 'DELETE' && path === `${tenant}/me/connection`) {
      revocations.push(path);
      res.statusCode = 204;
      return res.end();
    }
    send({ code: 'NOT_FOUND', message: 'Not found.' }, 404);
  });
  await new Promise<void>((resolve) => community.listen(0, '127.0.0.1', resolve));
  const address = community.address();
  if (!address || typeof address === 'string') throw new Error('No Community test port');
  origin = `http://127.0.0.1:${address.port}`;

  // The startup wiring the routes read: a real (in-memory) database for agent
  // enrollment state, and a mirror lifecycle nothing in this journey reaches.
  setRemoteCommunityDb(createTestDb());
  setRemoteCommunityLifecycle({ revokeConnection: async () => undefined } as never);
  const navigation = {
    get: async () => ({ ownerKey: 'owner-a', order: [], destinations: [] }),
  };
  const routes = express();
  routes.use(express.json());
  routes.use(
    '/api/community-connections',
    createCommunityConnectionsRouter(getRemotePairingService(), navigation as never)
  );
  routes.use('/api/communities', createRemoteCommunitiesRouter());
  // Supertest dials 127.0.0.1, so bind exactly that.
  app = routes.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

afterAll(async () => {
  app?.closeAllConnections();
  await new Promise<void>((resolve) => app?.close(() => resolve()));
  community?.closeAllConnections();
  await new Promise<void>((resolve) => community?.close(() => resolve()));
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  dns.promises.lookup = originalPromiseLookup;
  for (const restore of restores) restore();
  if (home.dir) await rm(home.dir, { recursive: true, force: true });
});

describe('Community membership in this DorkOS with Cloud unreachable', () => {
  it('refuses TCP, DNS lookups, direct DNS queries and UDP, so an empty record below means something', async () => {
    await expect(fetch('https://dorkos.ai/api/health')).rejects.toThrow();
    await expect(dns.promises.lookup('dorkos.ai')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(dns.promises.resolve4('dorkos.ai')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(new dns.promises.Resolver().resolveTxt('dorkos.ai')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
    await expect(
      new Promise((resolve, reject) =>
        dns.resolve6('dorkos.ai', (error, value) => (error ? reject(error) : resolve(value)))
      )
    ).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(
      new Promise((resolve, reject) =>
        new dns.Resolver().resolveAny('dorkos.ai', (error, value) =>
          error ? reject(error) : resolve(value)
        )
      )
    ).rejects.toMatchObject({ code: 'ENOTFOUND' });
    const udp = dgram.createSocket('udp4');
    try {
      await expect(
        new Promise((resolve, reject) =>
          udp.send('ping', 53, '192.0.2.53', (error) => (error ? reject(error) : resolve(null)))
        )
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      udp.close();
    }
    expect(refused).toEqual([
      'connect dorkos.ai:443',
      'dns dorkos.ai',
      'dns resolve4 dorkos.ai',
      'dns resolveTxt dorkos.ai',
      'dns resolve6 dorkos.ai',
      'dns resolveAny dorkos.ai',
      'udp 192.0.2.53:53',
    ]);
    refused.length = 0;
  });

  it('connects, reads and disconnects an installation without one outbound connection', async () => {
    const started = await request(app)
      .post('/api/community-connections')
      .send({ url: `${origin}/c/${communityId}`, installName: 'Studio desktop' });
    expect(started.status).toBe(201);
    expect(new URL(started.body.approvalUrl).origin).toBe(origin);
    const ref = started.body.connection.ref as string;

    const waiting = await request(app).post(`/api/community-connections/${ref}/poll`);
    expect(waiting.body.status).toBe('pending');
    approved = true; // the member approves in the Community's own browser page
    const connected = await request(app).post(`/api/community-connections/${ref}/poll`);
    expect(connected.body.status).toBe('connected');

    const listed = await request(app).get('/api/community-connections');
    expect(listed.status).toBe(200);
    expect(listed.body.connections).toEqual([
      expect.objectContaining({
        ref,
        status: 'connected',
        access: expect.objectContaining({ state: 'verified' }),
        attention: expect.objectContaining({ state: 'verified', unreadCount: 1 }),
      }),
    ]);

    const rooms = await request(app).get(`/api/communities/${ref}/rooms`);
    expect(rooms.status).toBe(200);
    expect(rooms.body.rooms.map((room: { title: string }) => room.title)).toEqual(['general']);
    const history = await request(app).get(`/api/communities/${ref}/rooms/${channelId}/entries`);
    expect(history.status).toBe(200);
    expect(history.body.entries.map((entry: { text: string }) => entry.text)).toEqual([
      'Welcome in.',
    ]);

    const disconnected = await request(app).delete(`/api/community-connections/${ref}`);
    expect(disconnected.status).toBe(200);
    expect(disconnected.body).toEqual({ remoteRevoked: true });
    expect(revocations).toEqual([`${tenant}/me/connection`]);
    expect((await request(app).get('/api/community-connections')).body.connections).toEqual([]);

    expect(refused).toEqual([]);
  });
});
