/**
 * The owner's notice about a request to replace them, read through a real connection to a
 * fixture Community over HTTP (DOR-2543). Each connection holds its own grant; the fixture
 * answers the notice read by the role of the member behind that grant, exactly as the Community
 * does, so these tests fail if DorkOS shows a notice to anyone but the owner, keeps one after a
 * refusal, shows an old one for a slow Community, or lets the read stretch the list.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { CommunityWireOwnerReplacementNoticeResponse } from '@dorkos/shared/community-wire';

vi.mock('../room-caller.js', () => ({
  resolveCaller: () => ({ id: 'author-a' }),
}));
vi.mock('../../services/rooms/index.js', () => ({
  getRoomService: () => ({ authorRegistry: { isOwner: (id: string) => id === 'author-a' } }),
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => ({ id: 'author-a' }),
}));
vi.mock('../../lib/caller-authority.js', () => ({
  isLocalCaller: () => true,
  requireOperatorCookieUnderLogin: () => undefined,
}));

/** The real adapter, over the test's own connection store. */
const adapters = vi.hoisted(() => ({
  make: undefined as undefined | ((ref: string, owner: string) => unknown),
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: (ref: string, owner: string) => adapters.make!(ref, owner),
  getRemotePairingService: vi.fn(),
}));

import { createCommunityConnectionsRouter } from '../community-connections.js';
import { RemoteConnectionStore } from '../../services/communities/remote/connection-store.js';
import { RemoteCommunityPairingService } from '../../services/communities/remote/pairing-service.js';
import { RemoteCommunityAdapter } from '../../services/communities/remote/remote-community-adapter.js';
import {
  CommunityAttentionCache,
  COMMUNITY_ATTENTION_BUDGET_MS,
} from '../../services/communities/remote/community-attention-cache.js';
import { CommunityOwnerNoticeCache } from '../../services/communities/remote/community-owner-notice-cache.js';
import { CommunityOwnerNoticeAnnouncer } from '../../services/notifications/emitters/community-owner-replacement.js';

type Role = 'owner' | 'admin' | 'member';
/** How the fixture answers one community's notice read right now. */
type NoticeBehaviour = 'answer' | 'hang' | 403 | 401;

const communities = {
  owner: randomUUID(),
  admin: randomUUID(),
  member: randomUUID(),
} satisfies Record<Role, string>;
const replacementId = randomUUID();
const requestedAt = '2026-09-20T10:00:00.000Z';

let fixture: Server;
let origin: string;
let directory: string;
let store: RemoteConnectionStore;
const refs = new Map<Role, CommunityRef>();
/** The grant each community issued, so the fixture answers only that community's own bearer. */
const tokens = new Map<string, string>();
/** Every notice read the fixture received, by community. */
const noticeReads: string[] = [];
let behaviour: Record<Role, NoticeBehaviour>;
/** Whether the request is still open, or has completed, on the fixture. */
let requestPhase: 'open' | 'completed' | 'ended';
let openServers: Server[] = [];

function roleOf(communityId: string): Role | undefined {
  return (Object.keys(communities) as Role[]).find((role) => communities[role] === communityId);
}

/** What the Community tells a member of this role, as the real route answers it. */
function noticeFor(role: Role): CommunityWireOwnerReplacementNoticeResponse {
  // Every member is told of a completion; only the owner it replaced is told it was theirs.
  if (requestPhase === 'completed')
    return {
      open: null,
      completed: {
        replacementId,
        newOwnerDisplayName: 'Riley',
        completedAt: '2026-10-05T09:00:00.000Z',
        wasYours: role === 'owner',
      },
    };
  if (requestPhase === 'ended' || role === 'member') return { open: null, completed: null };
  const shared = {
    replacementId,
    state: 'waiting' as const,
    reason: 'owner_unreachable' as const,
    requestedAt,
    claimableAfter: '2026-10-04T10:00:00.000Z',
    noticeState: 'accepted' as const,
  };
  return role === 'owner'
    ? {
        open: {
          role: 'owner',
          ...shared,
          reference: 'CASE-12',
          claimReissuedAt: null,
          options: { keep: true, transfer: true, delete: true, needsPassword: false },
          objectionCooldownDays: 90,
        },
        completed: null,
      }
    : { open: { role: 'admin', ...shared }, completed: null };
}

function send(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-owner-notice-'));
  fixture = createServer((req, res) => {
    const match = /^\/api\/v1\/communities\/([^/]+)(\/.*)$/.exec(req.url ?? '');
    const role = match ? roleOf(match[1]!) : undefined;
    if (!match || !role) return send(res, { code: 'NOT_FOUND', message: 'Not found.' }, 404);
    const [, communityId, path] = match as unknown as [string, string, string];
    const authorized = req.headers.authorization === `Bearer ${tokens.get(communityId)}`;
    if (path === '/community')
      return send(res, {
        id: communityId,
        name: `${role} community`,
        description: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    if (path === '/pairings/start') {
      const pairingId = randomUUID();
      return send(
        res,
        {
          pairingId,
          approvalUrl: `${origin}/c/${communityId}/pairing?pairingId=${pairingId}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        201
      );
    }
    if (path === '/pairings/poll') return send(res, { status: 'approved', code: 'one-time-code' });
    if (path === '/pairings/exchange') {
      const token = `grant-${role}-${randomUUID()}`;
      tokens.set(communityId, token);
      return send(res, {
        token,
        grant: {
          id: randomUUID(),
          memberId: `${role}-member`,
          installName: 'Test install',
          scopes: ['read', 'post', 'enroll-agent'],
          lifecycle: 'active',
          capabilities: { read: true, post: true, enrollAgent: true, stream: true },
          createdAt: new Date().toISOString(),
        },
      });
    }
    if (!authorized) return send(res, { code: 'UNAUTHENTICATED', message: 'No.' }, 401);
    if (path === '/me/connection-access') {
      const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
      return send(res, {
        access: {
          state: 'verified',
          effective: capabilities,
          lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
        },
      });
    }
    if (path === '/attention') return send(res, { unreadCount: 3, mentionCount: 1 });
    if (path === '/owner-replacement') {
      noticeReads.push(communityId);
      const now = behaviour[role];
      if (now === 'hang') return; // never answers
      if (now === 403) return send(res, { code: 'FORBIDDEN', message: 'No.' }, 403);
      if (now === 401) return send(res, { code: 'UNAUTHENTICATED', message: 'No.' }, 401);
      return send(res, noticeFor(role));
    }
    return send(res, { code: 'NOT_FOUND', message: 'Not found.' }, 404);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('fixture has no port');
  origin = `http://127.0.0.1:${address.port}`;

  store = new RemoteConnectionStore(directory);
  adapters.make = (ref, owner) => new RemoteCommunityAdapter(ref as CommunityRef, owner, store);
  const pairing = new RemoteCommunityPairingService(store);
  for (const role of Object.keys(communities) as Role[]) {
    const started = await pairing.start('author-a', `${origin}/c/${communities[role]}`, 'Test');
    expect((await pairing.poll(started.connection.ref, 'author-a')).status).toBe('connected');
    refs.set(role, started.connection.ref);
  }
});

afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test starts with nothing announced.
  dorkHome = await mkdtemp(join(tmpdir(), 'community-owner-notice-home-'));
  announcers = [];
  behaviour = { owner: 'answer', admin: 'answer', member: 'answer' };
  requestPhase = 'open';
  noticeReads.length = 0;
  raised = [];
});

afterEach(async () => {
  // A list read hands notices to the announcer without waiting; let its ledger writes finish.
  await Promise.all(announcers.map((announcer) => announcer.idle()));
  await rm(dorkHome, { recursive: true, force: true });
  // A hung notice read holds its socket open; let the router's servers go regardless.
  fixture.closeAllConnections();
  for (const server of openServers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  openServers = [];
});

/** Every notification this test's announcers raised, in order. */
let raised: unknown[];
/** This test's own data directory, so no test sees another's announcements. */
let dorkHome: string;
/** This test's announcers, drained before its directory is removed. */
let announcers: CommunityOwnerNoticeAnnouncer[];

/** A fresh router, with its own caches, over the test's connection store. */
async function router(
  noticeCache = new CommunityOwnerNoticeCache(),
  service = new RemoteCommunityPairingService(store)
) {
  // A late announcement from an earlier test lands in that test's array, never this one's.
  const sink = raised;
  const announcer = new CommunityOwnerNoticeAnnouncer(dorkHome, async (payload) => {
    sink.push(payload);
    return { notification: payload, deduped: false };
  });
  announcers.push(announcer);
  const app = express();
  app.use(
    '/api/community-connections',
    createCommunityConnectionsRouter(
      service,
      undefined,
      new CommunityAttentionCache(),
      noticeCache,
      announcer
    )
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  openServers.push(server);
  return server;
}

async function list(server: Server) {
  const started = performance.now();
  const response = await request(server).get('/api/community-connections');
  expect(response.status).toBe(200);
  const byRole = new Map<Role, CommunityConnectionDescriptor>();
  for (const connection of response.body.connections as CommunityConnectionDescriptor[]) {
    const role = [...refs].find(([, ref]) => ref === connection.ref)?.[0];
    if (role) byRole.set(role, connection);
  }
  return { byRole, elapsed: performance.now() - started };
}

describe('the owner notice on a DorkOS connection', () => {
  // Purpose: only the owner's connection carries the notice, with only this owner's options.
  // Fails if an admin's view (which the Community does send) or a member's empty view became a
  // notice, or if the owner's notice dropped the options the copy is built from.
  it('shows the notice on the owner’s connection and on no one else’s', async () => {
    const { byRole } = await list(await router());
    expect(byRole.get('owner')?.ownerNotice).toEqual({
      state: 'open',
      replacementId,
      requestState: 'waiting',
      requestedAt,
      claimableAfter: '2026-10-04T10:00:00.000Z',
      claimReissuedAt: null,
      options: { keep: true, transfer: true, delete: true, needsPassword: false },
    });
    expect(byRole.get('admin')).toBeDefined();
    expect(byRole.get('admin')).not.toHaveProperty('ownerNotice');
    expect(byRole.get('member')).toBeDefined();
    expect(byRole.get('member')).not.toHaveProperty('ownerNotice');
    // The read went to every Community with that Community's own grant.
    expect(new Set(noticeReads)).toEqual(new Set(Object.values(communities)));
  });

  // Purpose: the completion is the owner's because the Community says so (`wasYours`), so it
  // needs nothing remembered from before: a fresh router (a restarted DorkOS) that never saw the
  // request open still tells the owner, and never a member or an admin, who are also told of it.
  it('tells the owner their request completed, even after a restart, and no one else', async () => {
    requestPhase = 'completed';
    const { byRole } = await list(await router());
    expect(byRole.get('owner')?.ownerNotice).toEqual({
      state: 'completed',
      replacementId,
      newOwnerDisplayName: 'Riley',
      completedAt: '2026-10-05T09:00:00.000Z',
    });
    expect(byRole.get('member')).not.toHaveProperty('ownerNotice');
    expect(byRole.get('admin')).not.toHaveProperty('ownerNotice');
  });

  // Purpose: the owner is notified once per request and phase, through the notification registry,
  // however many reads and restarts later the notice is still showing; a member and an admin are
  // never notified. Fails if the route stopped raising, raised per read, or raised for a non-owner.
  it('notifies the owner once per request and phase, across reads and restarts', async () => {
    const server = await router();
    await list(server);
    await list(server);
    await list(await router()); // a restart: a new router and announcer over the same data
    await vi.waitFor(() => expect(raised).toHaveLength(1));
    expect(raised[0]).toEqual({
      ref: refs.get('owner'),
      communityLabel: expect.any(String),
      replacementId,
      phase: 'open',
      claimable: false,
      claimableAfter: '2026-10-04T10:00:00.000Z',
    });
    requestPhase = 'completed';
    await list(server);
    await list(await router());
    await vi.waitFor(() => expect(raised).toHaveLength(2));
    expect(raised[1]).toMatchObject({ phase: 'completed', newOwnerDisplayName: 'Riley' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(raised).toHaveLength(2);
  });

  // Purpose: a request that ended without a new owner (kept, withdrawn) simply stops showing.
  it('stops showing a request that ended without a new owner', async () => {
    const server = await router();
    await list(server);
    requestPhase = 'ended';
    expect((await list(server)).byRole.get('owner')).not.toHaveProperty('ownerNotice');
  });

  // Purpose: a refusal clears what was cached, so a notice from before lost permission never
  // comes back, not even from a later read that merely times out inside the freshness window.
  it.each([403, 401] as const)('clears a cached notice on a %s', async (status) => {
    const server = await router(new CommunityOwnerNoticeCache(100, 60_000));
    expect((await list(server)).byRole.get('owner')?.ownerNotice?.state).toBe('open');
    behaviour.owner = status;
    expect((await list(server)).byRole.get('owner')).not.toHaveProperty('ownerNotice');
    behaviour.owner = 'hang';
    expect((await list(server)).byRole.get('owner')).not.toHaveProperty('ownerNotice');
  });

  // Purpose: the notice rides the per-connection read budget. A Community that never answers
  // the notice read cannot stretch the list past the budget, and costs its counts nothing.
  it('answers within the real budget when the notice read hangs', async () => {
    behaviour.owner = 'hang';
    const { byRole, elapsed } = await list(await router());
    // The access check and the counts share the list with it; the budget bounds the notice.
    expect(elapsed).toBeLessThan(2 * COMMUNITY_ATTENTION_BUDGET_MS + 500);
    expect(byRole.get('owner')).not.toHaveProperty('ownerNotice');
    expect(byRole.get('owner')?.attention).toMatchObject({ state: 'verified', unreadCount: 3 });
  });

  // Purpose: a slow Community shows no notice rather than an old one. Fails if the cache served
  // its last answer however old it was, as the counts do.
  it('shows no old notice when the Community turns slow', async () => {
    let clock = Date.parse('2026-09-30T00:00:00.000Z');
    const server = await router(new CommunityOwnerNoticeCache(100, 65_000, () => clock));
    expect((await list(server)).byRole.get('owner')?.ownerNotice?.state).toBe('open');
    behaviour.owner = 'hang';
    clock += 66_000;
    expect((await list(server)).byRole.get('owner')).not.toHaveProperty('ownerNotice');
  });

  // Purpose: one slow Community is asked once, not by every poll that times out on it.
  it('asks a slow Community once while its read is still out', async () => {
    behaviour.owner = 'hang';
    const server = await router(new CommunityOwnerNoticeCache(50));
    await list(server);
    await list(server);
    expect(noticeReads.filter((id) => id === communities.owner)).toHaveLength(1);
  });

  // Purpose: the real DELETE route forgets the notice it cached. The connection is listed again
  // at once (reconnected under the same ref) while its Community hangs, inside the freshness
  // window, so only the route's forget stands between the owner and the notice from before.
  it('forgets the notice when the Community is disconnected through the route', async () => {
    const service = new RemoteCommunityPairingService(store);
    vi.spyOn(service, 'disconnect').mockResolvedValue({
      remoteRevoked: true,
      agentsNotRemoved: [],
    });
    const server = await router(new CommunityOwnerNoticeCache(100, 60_000), service);
    expect((await list(server)).byRole.get('owner')?.ownerNotice?.state).toBe('open');
    const removed = await request(server).delete(`/api/community-connections/${refs.get('owner')}`);
    expect(removed.status).toBe(200);
    behaviour.owner = 'hang';
    expect((await list(server)).byRole.get('owner')).not.toHaveProperty('ownerNotice');
  });

  // Purpose: a connection that drops out of the list is forgotten by the next list read, so it
  // cannot bring an old notice back when it reappears.
  it('forgets the notice of a connection that left the list', async () => {
    const service = new RemoteCommunityPairingService(store);
    const server = await router(new CommunityOwnerNoticeCache(100, 60_000), service);
    expect((await list(server)).byRole.get('owner')?.ownerNotice?.state).toBe('open');
    const all = await service.list('author-a');
    const listing = vi
      .spyOn(service, 'list')
      .mockResolvedValue(all.filter((item) => item.ref !== refs.get('owner')));
    await list(server);
    listing.mockRestore();
    behaviour.owner = 'hang';
    expect((await list(server)).byRole.get('owner')).not.toHaveProperty('ownerNotice');
  });

  // Purpose: a connection that stops being readable loses its notice at once, and does not get it
  // back when it can read again while its Community is slow. Driven on both reads: the list
  // (which also drops unreadable refs) and the single-connection read, where only the forget for
  // an unreadable connection stands between the owner and the old notice.
  it.each(['list', 'single'] as const)(
    'forgets the notice of a connection that stops being readable (%s read)',
    async (read) => {
      const service = new RemoteCommunityPairingService(store);
      const server = await router(new CommunityOwnerNoticeCache(100, 60_000), service);
      const ownerRef = refs.get('owner')!;
      const one = async () =>
        read === 'list'
          ? (await list(server)).byRole.get('owner')
          : ((await request(server).get(`/api/community-connections/${ownerRef}`)).body
              .connection as CommunityConnectionDescriptor);
      expect((await one())?.ownerNotice?.state).toBe('open');
      const readable = await service.status(ownerRef, 'author-a');
      const unreadable = { read: false, post: false, enrollAgent: false, stream: false };
      const blind =
        readable.access?.state === 'verified'
          ? {
              ...readable,
              access: {
                ...readable.access,
                effective: unreadable,
                lastKnown: readable.access.lastKnown
                  ? { ...readable.access.lastKnown, capabilities: unreadable }
                  : null,
              },
            }
          : readable;
      const all = await service.list('author-a');
      const listing = vi
        .spyOn(service, 'list')
        .mockResolvedValue(all.map((item) => (item.ref === ownerRef ? blind : item)));
      const status = vi.spyOn(service, 'status').mockResolvedValue(blind);
      expect(await one()).not.toHaveProperty('ownerNotice');
      listing.mockRestore();
      status.mockRestore();
      behaviour.owner = 'hang';
      expect(await one()).not.toHaveProperty('ownerNotice');
    }
  );
});
