import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';

const owner = vi.hoisted(() => ({ id: 'author-a' }));

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
  readOwnerAccount: () => ({ id: owner.id }),
}));
vi.mock('../../lib/caller-authority.js', () => ({
  isLocalCaller: () => true,
  requireOperatorCookieUnderLogin: () => undefined,
}));

const attentionMock = vi.hoisted(() => ({
  read: vi.fn(),
  adapter: vi.fn(),
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: attentionMock.adapter,
  getRemotePairingService: vi.fn(),
}));

import { createCommunityConnectionsRouter } from '../community-connections.js';
import { RemoteConnectionStore } from '../../services/communities/remote/connection-store.js';
import {
  RemoteCommunityNameNotFoundError,
  RemoteCommunityPairingService,
  RemoteCommunitySelectionRequiredError,
  RemoteCommunityUpgradeRequiredError,
} from '../../services/communities/remote/pairing-service.js';
import { RemoteConnectionAuthorizationError } from '../../services/communities/remote/connection-store.js';
import { PinnedHttpError } from '../../services/communities/remote/pinned-origin.js';
import {
  CommunityAttentionCache,
  COMMUNITY_ATTENTION_BUDGET_MS,
} from '../../services/communities/remote/community-attention-cache.js';

let directory: string;
let app: ReturnType<typeof express>;
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
  directory = await mkdtemp(join(tmpdir(), 'community-route-'));
  const store = new RemoteConnectionStore(directory);
  await store.addPending(
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
  );
  app = express();
  app.use(express.json());
  app.use(
    '/api/community-connections',
    createCommunityConnectionsRouter(new RemoteCommunityPairingService(store), navigation as never)
  );
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
afterEach(() => {
  owner.id = 'author-a';
});

describe('local connection route authority and public projection', () => {
  it('returns a typed selection refusal for an ambiguous origin-only link', async () => {
    const selectionDirectory = await mkdtemp(join(tmpdir(), 'selection-'));
    const selectionStore = new RemoteConnectionStore(selectionDirectory);
    const selectionService = new RemoteCommunityPairingService(selectionStore);
    vi.spyOn(selectionService, 'start').mockRejectedValue(
      new RemoteCommunitySelectionRequiredError()
    );
    const selectionApp = express();
    selectionApp.use(express.json());
    selectionApp.use(
      '/api/community-connections',
      createCommunityConnectionsRouter(selectionService)
    );
    const selectionServer = selectionApp.listen(0, '127.0.0.1');
    await once(selectionServer, 'listening');
    try {
      const response = await request(selectionServer)
        .post('/api/community-connections')
        .set('x-test-author', 'author-a')
        .send({ url: 'https://community.example', installName: 'Desktop' });
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        code: 'COMMUNITY_SELECTION_REQUIRED',
        error: 'Choose a specific community from this host and use its community link.',
      });
    } finally {
      await new Promise<void>((resolve) => selectionServer.close(() => resolve()));
      await rm(selectionDirectory, { recursive: true, force: true });
    }
  });

  it('returns a typed upgrade requirement for a discovered legacy singleton', async () => {
    const upgradeDirectory = await mkdtemp(join(tmpdir(), 'upgrade-'));
    const upgradeService = new RemoteCommunityPairingService(
      new RemoteConnectionStore(upgradeDirectory)
    );
    vi.spyOn(upgradeService, 'start').mockRejectedValue(new RemoteCommunityUpgradeRequiredError());
    const upgradeApp = express();
    upgradeApp.use(express.json());
    upgradeApp.use('/api/community-connections', createCommunityConnectionsRouter(upgradeService));
    const upgradeServer = upgradeApp.listen(0, '127.0.0.1');
    await once(upgradeServer, 'listening');
    try {
      const response = await request(upgradeServer)
        .post('/api/community-connections')
        .set('x-test-author', 'author-a')
        .send({ url: 'https://community.example', installName: 'Desktop' });
      expect(response.status).toBe(426);
      expect(response.body).toEqual({
        code: 'COMMUNITY_UPGRADE_REQUIRED',
        error: 'Upgrade this Community server before connecting it to DorkOS.',
      });
    } finally {
      await new Promise<void>((resolve) => upgradeServer.close(() => resolve()));
      await rm(upgradeDirectory, { recursive: true, force: true });
    }
  });

  // Purpose: a /<name> link the host does not know gets a plain 404 with a stable code,
  // not the generic "unavailable" 502.
  it('answers 404 with a stable code when a short name resolves to nothing', async () => {
    const nameDirectory = await mkdtemp(join(tmpdir(), 'community-connections-name-'));
    const nameService = new RemoteCommunityPairingService(new RemoteConnectionStore(nameDirectory));
    vi.spyOn(nameService, 'start').mockRejectedValue(new RemoteCommunityNameNotFoundError());
    const nameApp = express();
    nameApp.use(express.json());
    nameApp.use('/api/community-connections', createCommunityConnectionsRouter(nameService));
    const nameServer = nameApp.listen(0, '127.0.0.1');
    await once(nameServer, 'listening');
    try {
      const response = await request(nameServer)
        .post('/api/community-connections')
        .set('x-test-author', 'author-a')
        .send({ url: 'https://community.example/acme', installName: 'Desktop' });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        code: 'COMMUNITY_NAME_NOT_FOUND',
        error: 'No community at this address. Check the link and try again.',
      });
    } finally {
      await new Promise<void>((resolve) => nameServer.close(() => resolve()));
      await rm(nameDirectory, { recursive: true, force: true });
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
    expect(disconnected.body).toEqual({ remoteRevoked: true });
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

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'The local owner changed. Reload Community data for the current account.',
      code: 'COMMUNITY_OWNER_CHANGED',
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
  const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
  function connected(): CommunityConnectionDescriptor {
    return {
      ref,
      remoteCommunityId: 'remote-community',
      label: 'Private group',
      pinnedOrigin: 'https://community.example',
      status: 'connected',
      connectedHumanMemberId: 'member-a',
      expiresAt: null,
      access: {
        state: 'verified',
        effective: capabilities,
        lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
      },
      attention: unavailable,
    };
  }
  async function probe(
    connection: CommunityConnectionDescriptor,
    path: string,
    listed: CommunityConnectionDescriptor[] = [connection]
  ) {
    const service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    vi.spyOn(service, 'list').mockResolvedValue(listed);
    vi.spyOn(service, 'status').mockResolvedValue(connection);
    const testApp = express();
    testApp.use('/api/community-connections', createCommunityConnectionsRouter(service));
    const testServer = testApp.listen(0, '127.0.0.1');
    await once(testServer, 'listening');
    try {
      return await request(testServer).get(path).set('x-test-author', 'author-a');
    } finally {
      testServer.closeAllConnections();
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
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
  const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
  const slowRef = CommunityRefSchema.parse('remote_owner_slow');
  const failRef = CommunityRefSchema.parse('remote_owner_fail');
  const liarRef = CommunityRefSchema.parse('remote_owner_lying');

  function connected(target = ref): CommunityConnectionDescriptor {
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
        effective: capabilities,
        lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
      },
      attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    };
  }

  type Counts = { unreadCount: number; mentionCount: number };
  /** Each remote answers from whatever behaviour the test sets for it now. */
  let behaviour: Map<string, () => Promise<Counts>>;
  let listed: CommunityConnectionDescriptor[];
  let testServer: Server;
  let service: RemoteCommunityPairingService;

  function never(): Promise<Counts> {
    return new Promise<Counts>(() => undefined);
  }
  function deferred() {
    let resolve!: (counts: Counts) => void;
    const promise = new Promise<Counts>((done) => (resolve = done));
    return { promise, resolve };
  }

  async function start(budgetMs: number) {
    service = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
    vi.spyOn(service, 'list').mockImplementation(async () => listed);
    vi.spyOn(service, 'status').mockImplementation(
      async (target) => listed.find((item) => item.ref === target) ?? listed[0]!
    );
    vi.spyOn(service, 'disconnect').mockImplementation(async (target) => {
      listed = listed.filter((item) => item.ref !== target);
      return { remoteRevoked: true };
    });
    const testApp = express();
    testApp.use(
      '/api/community-connections',
      createCommunityConnectionsRouter(
        service,
        navigation as never,
        new CommunityAttentionCache(budgetMs)
      )
    );
    testServer = testApp.listen(0, '127.0.0.1');
    await once(testServer, 'listening');
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
  afterEach(async () => {
    testServer.closeAllConnections();
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  });

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
