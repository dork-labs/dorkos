import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';

/**
 * The install's owner. `account: false` is an install no one has claimed yet, where a
 * connection has no password to wait for and goes straight to the space (DOR-4355).
 */
const owner = vi.hoisted(() => ({ id: 'author-a', account: true }));

vi.mock('../room-caller.js', () => ({
  resolveCaller: (req: { headers: Record<string, string> }) => {
    if (req.headers['x-dorkos-agent']) throw new Error('Agent identity');
    return { id: req.headers['x-test-author'] ?? 'author-a' };
  },
}));
vi.mock('../../services/rooms/index.js', () => ({
  getRoomService: () => ({ authorRegistry: { isOwner: (id: string) => id === owner.id } }),
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => (owner.account ? { id: owner.id } : null),
  getAuth: () => undefined,
}));
// The `/api` chain these routes run behind reads login and the host allowlist from config.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));
vi.mock('../../lib/caller-authority.js', () => ({
  isLocalCaller: () => true,
  requireOperatorCookieUnderLogin: () => undefined,
  // The limit's confirmation is proved with real sign-ins in teammate-spend-step-up.test.ts.
  refuseFrontDoorChange: () => undefined,
}));

const attentionMock = vi.hoisted(() => ({
  read: vi.fn(),
  adapter: vi.fn(),
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: attentionMock.adapter,
  getRemotePairingService: vi.fn(),
  getRemoteWakePolicy: vi.fn(),
}));

import { createCommunityConnectionsRoutes } from '../community-connections.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { RemoteConnectionStore } from '../../services/communities/remote/connection-store.js';
import {
  RemoteCommunityRateLimitedError,
  RemoteCommunityNameNotFoundError,
  RemoteCommunityPairingService,
  RemotePairingBusyError,
  RemoteCommunitySelectionRequiredError,
  RemoteCommunityUpgradeRequiredError,
} from '../../services/communities/remote/pairing-service.js';
import { RemoteConnectionAuthorizationError } from '../../services/communities/remote/connection-store.js';
import { PinnedHttpError } from '../../services/communities/remote/pinned-origin.js';
import { RemoteWakePolicy } from '../../services/communities/remote/wake/wake-policy.js';
import { RemoteAnswerIn } from '../../services/communities/remote/wake/answer-in.js';
import { AnswerInStore } from '../../services/communities/remote/wake/answer-in-store.js';
import { TeammateSpend } from '../../services/communities/remote/wake/teammate-spend.js';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { z } from 'zod';
import {
  CommunityAttentionCache,
  COMMUNITY_ATTENTION_BUDGET_MS,
} from '../../services/communities/remote/community-attention-cache.js';

let main: ServedRoutes;
let server: Server;
const ref = CommunityRefSchema.parse('remote_owner_a');
const navigation = {
  get: vi.fn(async () => ({ ownerKey: 'author-a', order: [ref], destinations: [] })),
  move: vi.fn(async () => ({ ownerKey: 'author-a', order: [ref], destinations: [] })),
  remember: vi.fn(async () => ({ ownerKey: 'author-a', order: [ref], destinations: [] })),
  rememberInstallation: vi.fn(async (_owner: string, installationDestination: unknown) => ({
    ownerKey: 'author-a',
    installationDestination,
    order: [ref],
    destinations: [],
  })),
  resolve: vi.fn(async () => null),
};

beforeAll(async () => {
  main = await serveRoutes(
    (_service, store) =>
      store.addPending(
        {
          ref,
          ownerKey: 'author-a',
          remoteCommunityId: 'remote-community',
          label: 'Private group',
          pinnedOrigin: 'https://community.example',
          pairingId: 'pairing-private',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        'private-verifier'
      ),
    () => [navigation as never]
  );
  server = main.server;
});
afterAll(() => main.close());
afterEach(() => {
  owner.id = 'author-a';
  owner.account = true;
});

const ALL_ACCESS = { read: true, post: true, enrollAgent: true, stream: true };

/** A connection verified just now with full access and no counts yet. */
function verifiedConnection(target = ref): CommunityConnectionDescriptor {
  return {
    ref: target,
    remoteCommunityId: `remote-${target}`,
    label: `Community ${target}`,
    pinnedOrigin: 'https://community.example',
    status: 'connected',
    connectedHumanMemberId: 'member-a',
    expiresAt: null,
    access: {
      state: 'verified',
      effective: ALL_ACCESS,
      lastKnown: {
        lifecycle: 'active',
        capabilities: ALL_ACCESS,
        verifiedAt: new Date().toISOString(),
      },
    },
    attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
  };
}

/** The route factory's dependencies after the pairing service. */
type RouteDepsAfterService =
  Parameters<typeof createCommunityConnectionsRoutes> extends [unknown?, ...infer Rest]
    ? Rest
    : never;

/** A served copy of the routes, and how to take it down. */
interface ServedRoutes {
  server: Server;
  close: () => Promise<void>;
}

/**
 * Serve the routes around their own pairing service in a fresh folder. `prepare` stubs the
 * service's answers or seeds its store; `deps` builds the route's other dependencies.
 */
async function serveRoutes(
  prepare: (
    service: RemoteCommunityPairingService,
    store: RemoteConnectionStore
  ) => unknown | Promise<unknown>,
  deps: (store: RemoteConnectionStore, folder: string) => RouteDepsAfterService = () => []
): Promise<ServedRoutes> {
  const folder = await mkdtemp(join(tmpdir(), 'community-route-case-'));
  const store = new RemoteConnectionStore(folder);
  const service = new RemoteCommunityPairingService(store);
  await prepare(service, store);
  const caseServer = createServer(
    honoGroupListener({
      path: '/api/community-connections',
      routes: createCommunityConnectionsRoutes(service, ...deps(store, folder)),
    })
  ).listen(0, '127.0.0.1');
  await once(caseServer, 'listening');
  return {
    server: caseServer,
    close: async () => {
      caseServer.closeAllConnections();
      await new Promise<void>((resolve) => caseServer.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

/** Seed `store` with a connection `author-a` finished pairing, verified with full access. */
async function seedConnected(store: RemoteConnectionStore, target: typeof ref): Promise<void> {
  await store.addPending(
    {
      ref: target,
      ownerKey: 'author-a',
      remoteCommunityId: 'remote-community',
      label: 'Makers',
      pinnedOrigin: 'https://community.example',
      pairingId: `pairing-${target}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    `verifier-${target}`
  );
  await store.complete(target, 'author-a', 'remote-owner', 'token', {
    state: 'verified',
    effective: ALL_ACCESS,
    lastKnown: {
      lifecycle: 'active',
      capabilities: ALL_ACCESS,
      verifiedAt: '2026-10-06T00:00:00.000Z',
    },
  });
}

/** Connect `url` as the install's owner, before anyone has claimed the install. */
function connectUnclaimed(target: Server, url: string) {
  // No owner yet, so the connection goes straight to the space and its answer shows.
  owner.account = false;
  return request(target)
    .post('/api/community-connections')
    .set('x-test-author', 'author-a')
    .send({ url, installName: 'Desktop' });
}

describe('local connection route authority and public projection', () => {
  // Purpose: each pairing refusal reaches the client as a stable code and a plain sentence,
  // never the generic "unavailable" 502.
  it.each([
    [
      'an ambiguous origin-only link',
      () => new RemoteCommunitySelectionRequiredError(),
      'https://community.example',
      409,
      {
        code: 'space_choice_required',
        detail: 'That address has more than one space. Use one space’s own link.',
      },
    ],
    [
      'a discovered legacy singleton',
      () => new RemoteCommunityUpgradeRequiredError(),
      'https://community.example',
      426,
      {
        code: 'space_server_outdated',
        detail: 'This space’s server is too old to connect. Ask whoever runs it to update it.',
      },
    ],
    [
      'a short name that resolves to nothing',
      () => new RemoteCommunityNameNotFoundError(),
      'https://community.example/acme',
      404,
      {
        code: 'space_name_not_found',
        detail: 'No space uses that short address there. Check the spelling.',
      },
    ],
  ] as const)('answers %s with a typed refusal', async (_case, refusal, url, status, body) => {
    const routes = await serveRoutes((service) =>
      vi.spyOn(service, 'start').mockRejectedValue(refusal())
    );
    try {
      const response = await connectUnclaimed(routes.server, url);
      expect(response.status).toBe(status);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.body).toMatchObject({ ...body, status });
    } finally {
      await routes.close();
    }
  });

  it('codes a concurrent check of one pairing as busy, so a client keeps waiting', async () => {
    const routes = await serveRoutes((service) =>
      vi.spyOn(service, 'poll').mockRejectedValue(new RemotePairingBusyError())
    );
    try {
      const response = await request(routes.server)
        .post('/api/community-connections/ref-busy/poll')
        .set('x-test-author', 'author-a');
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'pairing_busy',
        detail: 'This pairing is still finishing. Try again in a moment.',
      });
    } finally {
      await routes.close();
    }
  });

  // Purpose: a host rate limit on the name lookup gets its own message, not "unavailable".
  it('answers 429 with a stable code when the host limits name lookups', async () => {
    const routes = await serveRoutes((service) =>
      vi
        .spyOn(service, 'start')
        .mockRejectedValueOnce(new RemoteCommunityRateLimitedError(17))
        .mockRejectedValueOnce(new RemoteCommunityRateLimitedError())
    );
    try {
      const response = await connectUnclaimed(routes.server, 'https://community.example/acme');
      expect(response.status).toBe(429);
      // The host's wait is passed on, as a header and in the body the dialog reads.
      expect(response.headers['retry-after']).toBe('17');
      expect(response.body).toMatchObject({
        code: 'rate_limited',
        detail: 'This DorkOS tried that space too often. Wait, then try again.',
        retryAfterMs: 17_000,
      });
      // A host that named no wait gets no invented one.
      const unnamed = await connectUnclaimed(routes.server, 'https://community.example/acme');
      expect(unnamed.status).toBe(429);
      expect(unnamed.headers['retry-after']).toBeUndefined();
      expect(unnamed.body).toMatchObject({ code: 'rate_limited' });
      expect(unnamed.body.retryAfterMs).toBeUndefined();
    } finally {
      await routes.close();
    }
  });

  // Purpose: a reserved name is refused by the real parser as a bad address (400), before any
  // request leaves this server.
  it('answers 400 for a link whose short name is reserved', async () => {
    const routes = await serveRoutes(() => undefined);
    try {
      const response = await connectUnclaimed(routes.server, 'https://community.example/api');
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'invalid_request',
        detail: 'Enter an accessible HTTPS space address.',
      });
    } finally {
      await routes.close();
    }
  });

  // Purpose: once an owner exists, connecting a space waits for them to confirm it's them
  // (DOR-4355; the confirmation itself is proved with real sign-ins in its own step-up
  // test), so this session-less caller starts nothing.
  it('holds connecting a space for the owner, and starts nothing before they confirm', async () => {
    let start!: ReturnType<typeof vi.spyOn>;
    const routes = await serveRoutes((service) => (start = vi.spyOn(service, 'start')));
    try {
      const response = await request(routes.server)
        .post('/api/community-connections')
        .set('x-test-author', 'author-a')
        .send({ url: 'https://community.example', installName: 'Desktop' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('not-a-person');
      expect(start).not.toHaveBeenCalled();
    } finally {
      await routes.close();
    }
  });

  it('shows only the trusted owner and excludes pairing proof', async () => {
    const response = await request(server)
      .get('/api/community-connections')
      .set('x-test-author', 'author-a');
    expect(response.status).toBe(200);
    expect(response.body.connections).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('pairing-private');
    expect(JSON.stringify(response.body)).not.toContain('private-verifier');
    expect(response.body.connections[0].ref).toBe(ref);
    expect(
      (await request(server).get('/api/community-connections').set('x-test-author', 'author-b'))
        .status
    ).toBe(403);
    expect(
      (
        await request(server)
          .get(`/api/community-connections/${ref}`)
          .set('x-test-author', 'author-b')
      ).status
    ).toBe(403);
    expect(
      (
        await request(server)
          .post(`/api/community-connections/${ref}/poll`)
          .set('x-dorkos-agent', 'agent-token')
      ).status
    ).toBe(403);
  });

  // DOR-2603. Purpose: the Disconnect confirmation names the agents it will remove, read for
  // the local owner only. Fails if another caller can read them or the route stops answering.
  it('says which agents Disconnect would remove, only to the local owner', async () => {
    expect(
      (
        await request(server)
          .get(`/api/community-connections/${ref}/disconnect-impact`)
          .set('x-test-author', 'author-b')
      ).status
    ).toBe(403);
    // Still waiting for approval: no grant yet, so no agent was added through it.
    const pending = await request(server)
      .get(`/api/community-connections/${ref}/disconnect-impact`)
      .set('x-test-author', 'author-a');
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({ agents: [] });
    expect(
      (
        await request(server)
          .get('/api/community-connections/remote_unknown/disconnect-impact')
          .set('x-test-author', 'author-a')
      ).status
    ).toBe(404);

    const agents = [{ localAgentId: 'scout-local', displayName: 'Scout' }];
    let read!: ReturnType<typeof vi.spyOn>;
    const routes = await serveRoutes(
      (service) => (read = vi.spyOn(service, 'disconnectImpact').mockResolvedValue({ agents }))
    );
    try {
      const answered = await request(routes.server)
        .get(`/api/community-connections/${ref}/disconnect-impact`)
        .set('x-test-author', 'author-a');
      expect(answered.status).toBe(200);
      expect(answered.body).toEqual({ agents });
      expect(read).toHaveBeenCalledWith(ref, 'author-a');
    } finally {
      await routes.close();
    }
  });

  it('disconnects only when the trusted caller is the local owner', async () => {
    expect(
      (
        await request(server)
          .delete(`/api/community-connections/${ref}`)
          .set('x-test-author', 'author-b')
      ).status
    ).toBe(403);
    const disconnected = await request(server)
      .delete(`/api/community-connections/${ref}`)
      .set('x-test-author', 'author-a');
    expect(disconnected.status).toBe(200);
    // A pending request never received a grant, so nothing is left on the Community.
    expect(disconnected.body).toEqual({ remoteRevoked: true, agentsNotRemoved: [] });
    expect(
      (await request(server).get('/api/community-connections').set('x-test-author', 'author-a'))
        .body.connections
    ).toEqual([]);
  });

  it('keeps navigation state behind owner authority and static routes', async () => {
    expect(
      (
        await request(server)
          .get('/api/community-connections/navigation')
          .set('x-test-author', 'author-b')
      ).status
    ).toBe(403);
    const response = await request(server)
      .get('/api/community-connections/navigation')
      .set('x-test-author', 'author-a');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ownerKey: 'author-a',
      installationDestination: { path: '/', search: {} },
      order: [ref],
      destinations: [],
    });
    expect(navigation.get).toHaveBeenCalledWith('author-a');

    expect(
      (
        await request(server)
          .post('/api/community-connections/navigation/move')
          .set('x-test-author', 'author-a')
          .send({ ref, direction: 'sideways' })
      ).status
    ).toBe(400);

    const remembered = await request(server)
      .put('/api/community-connections/navigation/installation')
      .set('x-test-author', 'author-a')
      .send({ destination: { path: '/tasks', search: { view: 'board' } } });
    expect(remembered.status).toBe(200);
    expect(navigation.rememberInstallation).toHaveBeenCalledWith('author-a', {
      path: '/tasks',
      search: { view: 'board' },
    });
    expect(
      (
        await request(server)
          .put('/api/community-connections/navigation/installation')
          .set('x-test-author', 'author-a')
          .send({ destination: { path: '/channels', search: { community: ref } } })
      ).status
    ).toBe(400);
  });

  it('rejects a stale browser owner precondition before reading another owner’s data', async () => {
    owner.id = 'author-b';
    const response = await request(server)
      .get('/api/community-connections')
      .set('x-test-author', 'author-b')
      .set('x-dorkos-community-owner', 'author-a');

    // Changed since the page looked: 412, with its own code the app reloads on.
    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({
      code: 'owner_changed',
      detail: 'The owner of this DorkOS changed. Reload to see their spaces.',
    });
  });

  it('serves a request whose owner precondition matches the signed-in owner', async () => {
    // The other half of the fence: a check that refused every request carrying
    // the header would lock the owner out of their own communities.
    for (const path of ['/api/community-connections', '/api/community-connections/navigation']) {
      const response = await request(server)
        .get(path)
        .set('x-test-author', 'author-a')
        .set('x-dorkos-community-owner', 'author-a');
      expect(response.status).toBe(200);
    }
  });
});

describe('owner-scoped attention projection', () => {
  const unavailable = {
    state: 'unavailable' as const,
    unreadCount: null,
    mentionCount: null,
    verifiedAt: null,
  };
  const connected = () => verifiedConnection();
  async function probe(
    connection: CommunityConnectionDescriptor,
    path: string,
    listed: CommunityConnectionDescriptor[] = [connection]
  ) {
    const routes = await serveRoutes((service) => {
      vi.spyOn(service, 'list').mockResolvedValue(listed);
      vi.spyOn(service, 'status').mockResolvedValue(connection);
    });
    try {
      return await request(routes.server).get(path).set('x-test-author', 'author-a');
    } finally {
      await routes.close();
    }
  }
  it.each(['/api/community-connections', `/api/community-connections/${ref}`])(
    'projects verified counts with the trusted owner at %s',
    async (path) => {
      attentionMock.adapter.mockReset().mockReturnValue({ attention: attentionMock.read });
      attentionMock.read.mockReset().mockResolvedValue({ unreadCount: 7, mentionCount: 2 });
      const response = await probe(connected(), path);
      expect(response.status).toBe(200);
      expect(attentionMock.adapter).toHaveBeenCalledWith(ref, 'author-a');
      const result = response.body.connection ?? response.body.connections[0];
      expect(result.attention).toEqual({
        state: 'verified',
        unreadCount: 7,
        mentionCount: 2,
        verifiedAt: expect.any(String),
      });
    }
  );
  it('preserves unavailable attention when the remote request fails', async () => {
    attentionMock.adapter.mockReset().mockReturnValue({ attention: attentionMock.read });
    attentionMock.read.mockReset().mockRejectedValue(new Error('private upstream detail'));
    const response = await probe(connected(), '/api/community-connections');
    expect(response.status).toBe(200);
    expect(response.body.connections[0].attention).toEqual(unavailable);
    expect(JSON.stringify(response.body)).not.toContain('private upstream detail');
  });
  it('keeps every connection listed when one remote reports more mentions than unread', async () => {
    const liarRef = CommunityRefSchema.parse('remote_owner_liar');
    const liar = { ...connected(), ref: liarRef, label: 'Broken group' };
    attentionMock.adapter.mockReset().mockImplementation((target: string) => ({
      attention: async () =>
        target === liarRef
          ? { unreadCount: 1, mentionCount: 2 }
          : { unreadCount: 7, mentionCount: 2 },
    }));
    const response = await probe(connected(), '/api/community-connections', [connected(), liar]);
    expect(response.status).toBe(200);
    const byRef = new Map(
      (response.body.connections as CommunityConnectionDescriptor[]).map((item) => [item.ref, item])
    );
    expect(byRef.get(ref)?.attention).toEqual({
      state: 'verified',
      unreadCount: 7,
      mentionCount: 2,
      verifiedAt: expect.any(String),
    });
    expect(byRef.get(liarRef)).toMatchObject({ status: 'connected', attention: unavailable });
  });
  it('keeps a single connection readable when its remote reports more mentions than unread', async () => {
    attentionMock.adapter.mockReset().mockReturnValue({ attention: attentionMock.read });
    attentionMock.read.mockReset().mockResolvedValue({ unreadCount: 1, mentionCount: 2 });
    const response = await probe(connected(), `/api/community-connections/${ref}`);
    expect(response.status).toBe(200);
    expect(response.body.connection).toMatchObject({ ref, attention: unavailable });
  });
  it.each(['pending', 'unverified', 'no-read'])(
    'does not fetch counts for %s access',
    async (state) => {
      attentionMock.adapter.mockReset();
      const connection = connected();
      if (state === 'pending') {
        connection.status = 'pending';
        connection.access = null;
        connection.attention = null;
      } else if (state === 'unverified') {
        connection.access = {
          state: 'unverified',
          effective: { read: false, post: false, enrollAgent: false, stream: false },
          lastKnown: null,
        };
      } else {
        connection.access!.effective = {
          read: false,
          post: false,
          enrollAgent: false,
          stream: false,
        };
        connection.access!.lastKnown!.capabilities = connection.access!.effective;
        connection.access!.lastKnown!.lifecycle = 'suspended';
      }
      const response = await probe(connection, '/api/community-connections');
      expect(response.status).toBe(200);
      expect(attentionMock.adapter).not.toHaveBeenCalled();
      expect(response.body.connections[0].attention).toEqual(
        state === 'pending' ? null : unavailable
      );
    }
  );
});

describe('attention within a budget, with last confirmed counts as the fallback', () => {
  const slowRef = CommunityRefSchema.parse('remote_owner_slow');
  const failRef = CommunityRefSchema.parse('remote_owner_fail');
  const liarRef = CommunityRefSchema.parse('remote_owner_lying');
  const connected = verifiedConnection;

  type Counts = { unreadCount: number; mentionCount: number };
  /** Each remote answers from whatever behaviour the test sets for it now. */
  let behaviour: Map<string, () => Promise<Counts>>;
  let listed: CommunityConnectionDescriptor[];
  let testServer: Server;
  let close: () => Promise<void>;

  function never(): Promise<Counts> {
    return new Promise<Counts>(() => undefined);
  }
  function deferred() {
    let resolve!: (counts: Counts) => void;
    const promise = new Promise<Counts>((done) => (resolve = done));
    return { promise, resolve };
  }

  async function start(budgetMs: number) {
    const routes = await serveRoutes(
      (service) => {
        vi.spyOn(service, 'list').mockImplementation(async () => listed);
        vi.spyOn(service, 'status').mockImplementation(
          async (target) => listed.find((item) => item.ref === target) ?? listed[0]!
        );
        vi.spyOn(service, 'disconnect').mockImplementation(async (target) => {
          listed = listed.filter((item) => item.ref !== target);
          return { remoteRevoked: true, agentsNotRemoved: [] };
        });
      },
      () => [navigation as never, new CommunityAttentionCache(budgetMs)]
    );
    testServer = routes.server;
    close = routes.close;
  }

  async function list(author = 'author-a') {
    const started = performance.now();
    const response = await request(testServer)
      .get('/api/community-connections')
      .set('x-test-author', author);
    expect(response.status).toBe(200);
    const byRef = new Map(
      (response.body.connections as CommunityConnectionDescriptor[]).map((item) => [
        item.ref as string,
        item.attention,
      ])
    );
    return { byRef, elapsed: performance.now() - started };
  }

  beforeEach(() => {
    behaviour = new Map();
    listed = [connected()];
    attentionMock.adapter.mockReset().mockImplementation((target: string) => ({
      attention: () => {
        const answer = behaviour.get(target);
        return answer ? answer() : Promise.reject(new Error('no behaviour'));
      },
    }));
  });
  afterEach(() => close());

  it('answers within the real budget when one Community hangs, fails or lies', async () => {
    await start(COMMUNITY_ATTENTION_BUDGET_MS);
    listed = [connected(), connected(slowRef), connected(failRef), connected(liarRef)];
    behaviour.set(ref, async () => ({ unreadCount: 3, mentionCount: 1 }));
    behaviour.set(slowRef, never);
    behaviour.set(failRef, () => Promise.reject(new Error('private upstream detail')));
    behaviour.set(liarRef, async () => ({ unreadCount: 1, mentionCount: 5 }));

    const { byRef, elapsed } = await list();

    // The hanging Community is cut off at the budget; nothing waits for its
    // ten-second transport timeout.
    expect(elapsed).toBeLessThan(COMMUNITY_ATTENTION_BUDGET_MS + 500);
    expect(byRef.get(ref)).toEqual({
      state: 'verified',
      unreadCount: 3,
      mentionCount: 1,
      verifiedAt: expect.any(String),
    });
    for (const target of [slowRef, failRef, liarRef]) {
      expect(byRef.get(target)).toEqual({
        state: 'unavailable',
        unreadCount: null,
        mentionCount: null,
        verifiedAt: null,
      });
    }
  });

  it('never makes the list wait on a slow Community when every other answers quickly', async () => {
    await start(100);
    listed = [connected(), connected(slowRef)];
    behaviour.set(ref, async () => ({ unreadCount: 2, mentionCount: 0 }));
    behaviour.set(slowRef, never);
    const { byRef, elapsed } = await list();
    expect(elapsed).toBeLessThan(600);
    expect(byRef.get(ref)?.state).toBe('verified');
    expect(byRef.get(slowRef)?.state).toBe('unavailable');
  });

  it.each([
    ['slow', never],
    ['failing', () => Promise.reject(new Error('down'))],
    ['lying', async () => ({ unreadCount: 0, mentionCount: 4 })],
  ] as const)(
    'shows the last confirmed counts as stale when the Community turns %s',
    async (_kind, next) => {
      await start(100);
      behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
      const first = (await list()).byRef.get(ref);
      expect(first?.state).toBe('verified');

      behaviour.set(ref, next);
      const { byRef, elapsed } = await list();
      expect(elapsed).toBeLessThan(600);
      expect(byRef.get(ref)).toEqual({
        state: 'stale',
        unreadCount: 4,
        mentionCount: 1,
        verifiedAt: first?.verifiedAt,
      });
    }
  );

  it.each([
    ['403', () => new PinnedHttpError(403)],
    ['401', () => new PinnedHttpError(401)],
    ['rejected grant', () => new RemoteConnectionAuthorizationError()],
  ] as const)(
    'never shows counts from before a %s refusal, even as stale',
    async (_kind, refusal) => {
      await start(100);
      behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
      expect((await list()).byRef.get(ref)?.state).toBe('verified');
      behaviour.set(ref, () => Promise.reject(refusal()));
      expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
      // Nor on a later read that merely times out.
      behaviour.set(ref, never);
      expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
    }
  );

  it('drops the counts when a refusal lands after the read stopped waiting', async () => {
    await start(50);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    await list();
    let refuse!: () => void;
    behaviour.set(
      ref,
      () =>
        new Promise<Counts>((_resolve, reject) => (refuse = () => reject(new PinnedHttpError(403))))
    );
    expect((await list()).byRef.get(ref)?.state).toBe('stale');
    refuse();
    await new Promise((resolve) => setTimeout(resolve, 10));
    behaviour.set(ref, never);
    expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
  });

  it('keeps a slow request running and serves its answer on the next read', async () => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 1, mentionCount: 0 }));
    await list();
    const late = deferred();
    const calls = vi.fn(() => late.promise);
    behaviour.set(ref, calls);

    expect((await list()).byRef.get(ref)).toMatchObject({ state: 'stale', unreadCount: 1 });
    // A second poll while the first request is still out joins it instead of
    // asking the slow Community again.
    expect((await list()).byRef.get(ref)).toMatchObject({ state: 'stale', unreadCount: 1 });
    expect(calls).toHaveBeenCalledTimes(1);

    late.resolve({ unreadCount: 6, mentionCount: 2 });
    await vi.waitFor(async () => {
      behaviour.set(ref, never);
      expect((await list()).byRef.get(ref)).toMatchObject({
        state: 'stale',
        unreadCount: 6,
        mentionCount: 2,
      });
    });
  });

  it('does not ask again on its own once a background answer lands', async () => {
    await start(50);
    const late = deferred();
    const calls = vi.fn(() => late.promise);
    behaviour.set(ref, calls);
    await list();
    late.resolve({ unreadCount: 1, mentionCount: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // No announcement, no follow-up read: the answer waits for the next poll.
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('forgets counts when the Community is disconnected', async () => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    await list();
    const removed = await request(testServer)
      .delete(`/api/community-connections/${ref}`)
      .set('x-test-author', 'author-a');
    expect(removed.status).toBe(200);
    // Reconnected, but the Community is down: the old counts must not return.
    listed = [connected()];
    behaviour.set(ref, () => Promise.reject(new Error('down')));
    expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
  });

  it('discards a request still in flight when the Community is disconnected', async () => {
    await start(50);
    const late = deferred();
    behaviour.set(ref, () => late.promise);
    await list();
    await request(testServer)
      .delete(`/api/community-connections/${ref}`)
      .set('x-test-author', 'author-a');
    late.resolve({ unreadCount: 9, mentionCount: 9 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    listed = [connected()];
    behaviour.set(ref, () => Promise.reject(new Error('down')));
    expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
  });

  it.each(['reconnect-required', 'no-read'])('forgets counts once access is %s', async (change) => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    await list();
    const lost = connected();
    const none = { read: false, post: false, enrollAgent: false, stream: false };
    if (change === 'reconnect-required') {
      lost.status = 'reconnect-required';
      lost.access = { state: 'reconnect-required', effective: none, lastKnown: null };
    } else {
      lost.access = {
        state: 'verified',
        effective: none,
        lastKnown: {
          lifecycle: 'suspended',
          capabilities: none,
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    listed = [lost];
    await list();
    listed = [connected()];
    behaviour.set(ref, () => Promise.reject(new Error('down')));
    expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
  });

  it('forgets counts when the local owner changes', async () => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    await list();
    owner.id = 'author-b';
    behaviour.set(ref, () => Promise.reject(new Error('down')));
    expect((await list('author-b')).byRef.get(ref)?.state).toBe('unavailable');
    owner.id = 'author-a';
    expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
  });

  it('forgets counts when the single-connection read finds access lost', async () => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    await list();
    const none = { read: false, post: false, enrollAgent: false, stream: false };
    listed = [
      {
        ...connected(),
        status: 'reconnect-required',
        access: { state: 'reconnect-required', effective: none, lastKnown: null },
      },
    ];
    const lost = await request(testServer)
      .get(`/api/community-connections/${ref}`)
      .set('x-test-author', 'author-a');
    expect(lost.status).toBe(200);
    listed = [connected()];
    behaviour.set(ref, () => Promise.reject(new Error('down')));
    expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
  });

  it('drops the previous owner’s counts on the new owner’s single-connection read', async () => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    await list();
    owner.id = 'author-b';
    behaviour.set(ref, () => Promise.reject(new Error('down')));
    await request(testServer)
      .get(`/api/community-connections/${ref}`)
      .set('x-test-author', 'author-b');
    owner.id = 'author-a';
    expect((await list()).byRef.get(ref)?.state).toBe('unavailable');
  });

  it('keeps the last confirmed counts, without asking, while a Community is offline', async () => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    const first = (await list()).byRef.get(ref);
    const none = { read: false, post: false, enrollAgent: false, stream: false };
    const offline = connected();
    offline.access = {
      state: 'unverified',
      effective: none,
      lastKnown: offline.access!.lastKnown,
    };
    listed = [offline];
    const calls = vi.fn(() => Promise.resolve({ unreadCount: 9, mentionCount: 9 }));
    behaviour.set(ref, calls);
    expect((await list()).byRef.get(ref)).toEqual({
      state: 'stale',
      unreadCount: 4,
      mentionCount: 1,
      verifiedAt: first?.verifiedAt,
    });
    expect(calls).not.toHaveBeenCalled();
    // Back online: fresh counts again.
    listed = [connected()];
    expect((await list()).byRef.get(ref)).toMatchObject({ state: 'verified', unreadCount: 9 });
  });

  it('serves the same fallback on the single-connection read', async () => {
    await start(100);
    behaviour.set(ref, async () => ({ unreadCount: 4, mentionCount: 1 }));
    await list();
    behaviour.set(ref, never);
    const response = await request(testServer)
      .get(`/api/community-connections/${ref}`)
      .set('x-test-author', 'author-a');
    expect(response.status).toBe(200);
    expect(response.body.connection.attention).toMatchObject({
      state: 'stale',
      unreadCount: 4,
      mentionCount: 1,
    });
  });
});

// Spec `official-community-space` D9. Purpose: who may wake an agent in a space is the owner's
// call alone. Each case fails if the route lets an agent's identity, another local person, or
// a malformed body change it, or if the setting ever becomes a config key an agent's
// `config_patch` could reach.
describe('who may wake agents in a space is the owner’s call', () => {
  let wake: ServedRoutes;
  let policy: RemoteWakePolicy;
  const wakeRef = CommunityRefSchema.parse('remote_wake_a');

  beforeAll(async () => {
    wake = await serveRoutes(
      (_service, store) => seedConnected(store, wakeRef),
      (store) => {
        policy = new RemoteWakePolicy(store);
        return [navigation as never, undefined, undefined, undefined, policy];
      }
    );
  });
  afterAll(() => wake.close());

  const path = `/api/community-connections/${wakeRef}/wake-agents-from`;

  it('lets the owner read and change it', async () => {
    const before = await request(wake.server).get(path).set('x-test-author', 'author-a');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ wakeAgentsFrom: 'members' });

    const changed = await request(wake.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ wakeAgentsFrom: 'me' });
    expect(changed.status).toBe(200);
    expect(await policy.get(wakeRef, 'author-a')).toBe('me');

    // Letting members wake them again waits for the owner to confirm it's them (DOR-4355),
    // so this session-less caller is refused and the setting stays.
    const widened = await request(wake.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ wakeAgentsFrom: 'members' });
    expect(widened.status).toBe(403);
    expect(widened.body.code).toBe('not-a-person');
    expect(await policy.get(wakeRef, 'author-a')).toBe('me');
  });

  it('refuses an agent, and the setting stays where the owner put it', async () => {
    await policy.set(wakeRef, 'author-a', 'me');
    const refused = await request(wake.server)
      .put(path)
      .set('x-dorkos-agent', 'agent-token')
      .send({ wakeAgentsFrom: 'members' });
    expect(refused.status).toBe(403);
    expect(await policy.get(wakeRef, 'author-a')).toBe('me');
  });

  it('refuses anyone on this machine who is not the owner', async () => {
    await policy.set(wakeRef, 'author-a', 'me');
    const refused = await request(wake.server)
      .put(path)
      .set('x-test-author', 'author-b')
      .send({ wakeAgentsFrom: 'members' });
    expect(refused.status).toBe(403);
    expect(await policy.get(wakeRef, 'author-a')).toBe('me');
  });

  it('refuses a value that is neither choice', async () => {
    const refused = await request(wake.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ wakeAgentsFrom: 'everyone' });
    expect(refused.status).toBe(400);
  });
});

// Spec `official-community-space` D11. Purpose: where any person's post wakes an agent without
// a mention is the owner's call alone. Each case fails if the route lets an agent's identity,
// another local person, or a malformed body change it, or if the setting ever becomes a config
// key an agent's `config_patch` could reach.
describe('where agents answer without a mention is the owner’s call', () => {
  let answer: ServedRoutes;
  let policy: RemoteWakePolicy;
  const answerRef = CommunityRefSchema.parse('remote_answer_a');

  beforeAll(async () => {
    answer = await serveRoutes(
      (_service, store) => seedConnected(store, answerRef),
      (store, folder) => {
        const answerIn = new RemoteAnswerIn(new AnswerInStore(folder, store), store);
        policy = new RemoteWakePolicy(store, [], undefined, answerIn);
        return [navigation as never, undefined, undefined, undefined, policy];
      }
    );
  });
  afterAll(() => answer.close());

  const path = `/api/community-connections/${answerRef}/answer-in`;

  it('lets the owner read and change it, and the live answer follows at once', async () => {
    const before = await request(answer.server).get(path).set('x-test-author', 'author-a');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ answerIn: [] });

    // Adding a channel waits for the owner to confirm it's them (DOR-4355; proved with real
    // sign-ins in its step-up test), so this session-less caller is refused, nothing changed.
    const added = await request(answer.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ answerIn: ['#Welcome', 'help'] });
    expect(added.status).toBe(403);
    expect(added.body.code).toBe('not-a-person');
    expect(await policy.getAnswerIn(answerRef, 'author-a')).toEqual([]);

    // Narrowing it is immediate, and the live answer follows at once.
    await policy.setAnswerIn(answerRef, 'author-a', ['welcome', 'help', 'general']);
    const changed = await request(answer.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ answerIn: ['#Welcome', 'help'] });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ answerIn: ['welcome', 'help'] });
    expect(await policy.getAnswerIn(answerRef, 'author-a')).toEqual(['welcome', 'help']);
    expect(policy.answersIn(answerRef, 'author-a', 'help')).toBe(true);
    expect(policy.answersIn(answerRef, 'author-a', 'general')).toBe(false);
  });

  it('refuses an agent, and the list stays where the owner put it', async () => {
    await policy.setAnswerIn(answerRef, 'author-a', ['help']);
    const refused = await request(answer.server)
      .put(path)
      .set('x-dorkos-agent', 'agent-token')
      .send({ answerIn: ['help', 'general'] });
    expect(refused.status).toBe(403);
    expect(await policy.getAnswerIn(answerRef, 'author-a')).toEqual(['help']);
    const read = await request(answer.server).get(path).set('x-dorkos-agent', 'agent-token');
    expect(read.status).toBe(403);
  });

  it('refuses anyone on this machine who is not the owner', async () => {
    await policy.setAnswerIn(answerRef, 'author-a', ['help']);
    const refused = await request(answer.server)
      .put(path)
      .set('x-test-author', 'author-b')
      .send({ answerIn: ['general'] });
    expect(refused.status).toBe(403);
    expect(await policy.getAnswerIn(answerRef, 'author-a')).toEqual(['help']);
  });

  it('refuses a list that is not channel names, and a connection that is not there', async () => {
    const malformed = await request(answer.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ answerIn: 'help' });
    expect(malformed.status).toBe(400);
    const missing = await request(answer.server)
      .put('/api/community-connections/remote_missing/answer-in')
      .set('x-test-author', 'author-a')
      .send({ answerIn: ['help'] });
    expect(missing.status).toBe(404);
  });
});

// Purpose: the owner-only space settings live outside the config, so no agent's
// `config_patch` can reach them.
it.each(['wakeAgentsFrom', 'answerIn'])('%s is no config key', (key) => {
  const schema = JSON.stringify(z.toJSONSchema(UserConfigSchema, { unrepresentable: 'any' }));
  expect(schema).not.toContain(key);
});

// DOR-2956: the monthly limit on what teammates' turns in a space may cost is the owner's call
// alone. Each case fails if the route lets an agent's identity, another local person, or a
// malformed body change it.
describe('the teammates’ monthly limit is the owner’s call', () => {
  let served: ServedRoutes;
  let spend: TeammateSpend;
  const spendRef = CommunityRefSchema.parse('remote_spend_a');

  beforeAll(async () => {
    served = await serveRoutes(
      async (_service, store) => {
        await seedConnected(store, spendRef);
      },
      (store, folder) => {
        spend = new TeammateSpend(folder, store);
        return [
          navigation as never,
          undefined,
          undefined,
          undefined,
          new RemoteWakePolicy(store, []),
          spend,
        ];
      }
    );
    await spend.load();
  });
  afterAll(() => served.close());

  const path = `/api/community-connections/${spendRef}/teammate-spend`;

  it('is no limit until the owner sets one, and the gate follows at once', async () => {
    const before = await request(served.server).get(path).set('x-test-author', 'author-a');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      monthlyLimitUsd: null,
      spentUsd: 0,
      approximate: false,
      hasAgentsHere: false,
    });

    const changed = await request(served.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ monthlyLimitUsd: 0.5 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ monthlyLimitUsd: 0.5 });
    await spend.record(spendRef, 'author-a', 0.5);
    expect(spend.allows(spendRef, 'author-a')).toBe(false);

    // Removing the limit is a raise: it waits for the owner's own browser to confirm it
    // (teammate-spend-step-up.test.ts), so this session-less caller is refused, nothing changed.
    const cleared = await request(served.server)
      .put(path)
      .set('x-test-author', 'author-a')
      .send({ monthlyLimitUsd: null });
    expect(cleared.status).toBe(403);
    expect(cleared.body.code).toBe('not-a-person');
    expect(spend.allows(spendRef, 'author-a')).toBe(false);
    await spend.setLimit(spendRef, 'author-a', null);
    expect(spend.allows(spendRef, 'author-a')).toBe(true);
  });

  it('refuses an agent and anyone here who is not the owner, and the limit stays', async () => {
    await spend.setLimit(spendRef, 'author-a', 5);
    for (const header of [
      ['x-dorkos-agent', 'agent-token'],
      ['x-test-author', 'author-b'],
    ] as const) {
      const refused = await request(served.server)
        .put(path)
        .set(header[0], header[1])
        .send({ monthlyLimitUsd: 500 });
      expect(refused.status).toBe(403);
      expect((await request(served.server).get(path).set(header[0], header[1])).status).toBe(403);
    }
    expect((await spend.summary(spendRef, 'author-a')).monthlyLimitUsd).toBe(5);
  });

  it('refuses a limit that is not dollars above zero, and a connection that is not there', async () => {
    // Review B1: a tenth of a cent rounds to nothing and is refused, never saved as $0.
    for (const monthlyLimitUsd of [0, 0.004, -1, 'ten']) {
      const malformed = await request(served.server)
        .put(path)
        .set('x-test-author', 'author-a')
        .send({ monthlyLimitUsd });
      expect(malformed.status).toBe(400);
    }
    const missing = await request(served.server)
      .get('/api/community-connections/remote_missing/teammate-spend')
      .set('x-test-author', 'author-a');
    expect(missing.status).toBe(404);
  });
});
