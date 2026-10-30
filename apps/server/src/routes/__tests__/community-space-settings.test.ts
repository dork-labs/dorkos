/**
 * A connected space's Settings tab reads (DOR-3005): who may ask, which paths reach the space,
 * that the connection's credential never comes back, and the last answer kept for when the
 * space cannot be reached.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  getAuth: () => undefined,
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));
vi.mock('../../lib/caller-authority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/caller-authority.js')>()),
  isLocalCaller: () => true,
  requireOperatorCookieUnderLogin: () => undefined,
}));
vi.mock('../../services/communities/remote/state.js', () => ({
  getRemoteCommunityAdapter: vi.fn(),
  getRemotePairingService: vi.fn(),
  getRemoteWakePolicy: vi.fn(),
  getRemoteConnectionStore: vi.fn(),
}));

import { createCommunityConnectionsRoutes } from '../community-connections.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { logger } from '../../lib/logger.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionStore,
} from '../../services/communities/remote/connection-store.js';
import { RemoteCommunityPairingService } from '../../services/communities/remote/pairing-service.js';
import {
  PinnedHttpError,
  PinnedOriginError,
} from '../../services/communities/remote/pinned-origin.js';
import {
  connectionSource,
  SpaceSettingsCache,
  SpaceSettingsReader,
  type SpaceRequest,
} from '../../services/communities/remote/settings/index.js';

const TOKEN = 'grant-secret-0123456789abcdef';
const REMOTE_ID = '11111111-2222-4333-8444-555555555555';
const ref = CommunityRefSchema.parse('remote_settings_a');
const base = `/api/community-connections/${ref}/space`;

const SETTINGS = {
  communityId: REMOTE_ID,
  name: 'Northwind Studio',
  description: null,
  admissionPolicy: 'invite_only',
  hasIcon: false,
  settingsVersion: 3,
  lifecycle: 'active',
  lifecycleVersion: 1,
};
const ANSWERS: Record<string, unknown> = {
  [`/api/v1/communities/${REMOTE_ID}/settings`]: SETTINGS,
  [`/api/v1/communities/${REMOTE_ID}/me`]: {
    member: {
      memberId: 'm-1',
      kind: 'human',
      displayName: 'Alex Kim',
      handle: 'alex',
      role: 'owner',
      ownerMemberId: null,
      joinedAt: '2026-10-01T00:00:00.000Z',
    },
  },
  [`/api/v1/communities/${REMOTE_ID}/members?limit=100&include=agents,availability`]: {
    members: [],
    agents: [],
    nextCursor: null,
  },
  [`/api/v1/communities/${REMOTE_ID}/rules`]: { text: 'Be kind.', version: 3, acceptedVersion: 3 },
};

let directory: string;
let server: Server;
let clock = new Date('2026-10-20T10:00:00.000Z');
const remote = vi.fn<SpaceRequest>();
const credential = vi.fn(async () => TOKEN);
const grantRejected = vi.fn(async () => false);

function reader(cacheDirectory = directory) {
  return new SpaceSettingsReader(
    {
      place: async () => ({ pinnedOrigin: 'https://space.example', remoteCommunityId: REMOTE_ID }),
      credential,
      grantRejected,
    },
    new SpaceSettingsCache(cacheDirectory),
    remote,
    () => clock
  );
}

async function serve(spaceSettings: SpaceSettingsReader): Promise<Server> {
  const store = new RemoteConnectionStore(directory);
  const listening = createServer(
    honoGroupListener({
      path: '/api/community-connections',
      routes: createCommunityConnectionsRoutes(
        new RemoteCommunityPairingService(store),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        spaceSettings
      ),
    })
  ).listen(0, '127.0.0.1');
  await once(listening, 'listening');
  return listening;
}

async function close(target: Server) {
  target.closeAllConnections();
  await new Promise<void>((resolve) => target.close(() => resolve()));
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'space-settings-route-'));
  server = await serve(reader());
});
afterAll(async () => {
  await close(server);
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  remote.mockReset();
  remote.mockImplementation(async (_origin, path) => {
    if (path in ANSWERS) return ANSWERS[path];
    throw new PinnedHttpError(404, 'NOT_FOUND');
  });
  credential.mockClear();
  grantRejected.mockReset();
  grantRejected.mockResolvedValue(false);
});
afterEach(() => {
  owner.id = 'author-a';
  vi.restoreAllMocks();
});

describe('the four reads', () => {
  it.each(['settings', 'me', 'members', 'rules'] as const)(
    'reads %s through the fixed path with the connection’s grant, and never returns it',
    async (read) => {
      // Purpose: fails if a read reaches any other path, or its answer carries the credential.
      const response = await request(server).get(`${base}/${read}`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ offline: false, fetchedAt: clock.toISOString() });
      expect(remote).toHaveBeenCalledTimes(1);
      const [origin, path, body, , options] = remote.mock.calls[0]!;
      expect(origin.origin).toBe('https://space.example');
      expect(Object.keys(ANSWERS)).toContain(path);
      expect(body).toBeUndefined();
      expect(options).toMatchObject({ method: 'GET', authorization: TOKEN });
      expect(response.text).not.toContain(TOKEN);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  );

  it('asks an older space for its plain directory when it refuses the combined one', async () => {
    // Purpose: fails if a space from before the combined directory shows no members at all.
    remote.mockImplementation(async (_origin, path) => {
      if (path.includes('include=')) throw new PinnedHttpError(400, 'STATE_CONFLICT');
      return { members: [], nextCursor: null };
    });
    const response = await request(server).get(`${base}/members`);
    expect(response.status).toBe(200);
    expect(remote.mock.calls.map((call) => call[1])).toEqual([
      `/api/v1/communities/${REMOTE_ID}/members?limit=100&include=agents,availability`,
      `/api/v1/communities/${REMOTE_ID}/members?limit=100`,
    ]);
  });
});

describe('only the person at the app', () => {
  const refusals: Array<[string, Record<string, string>]> = [
    ['an agent identity', { 'x-dorkos-agent': 'agent-token' }],
    ['an approval token', { 'x-dorkos-approval': 'approval-token' }],
    ['an API key', { authorization: 'Bearer dork_api_key' }],
  ];
  it.each(refusals)('refuses %s before reaching the space', async (_label, headers) => {
    // Purpose: fails if any non-person caller gets a read, or the space is asked for one.
    const response = await request(server).get(`${base}/settings`).set(headers);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_A_PERSON');
    expect(remote).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
  });

  it('refuses a mini app’s sandboxed frame and another site’s page, which the API’s origin check turns away first', async () => {
    // Purpose: fails if an opaque-origin frame ever gets a read. The `/api` chain's origin
    // check refuses it first; the route's own check stands behind that.
    for (const origin of ['null', 'https://elsewhere.example']) {
      const response = await request(server).get(`${base}/settings`).set('origin', origin);
      expect(response.status, origin).toBeGreaterThanOrEqual(400);
    }
    expect(remote).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
  });

  it('refuses a signed-in person who is not this install’s owner', async () => {
    // Purpose: fails if the connection routes' owner check is skipped for these reads.
    const response = await request(server).get(`${base}/members`).set('x-test-author', 'author-b');
    expect(response.status).toBe(403);
    expect(remote).not.toHaveBeenCalled();
  });
});

describe('a fixed allow-list', () => {
  it.each([
    `${base}/invites`,
    `${base}/mutes`,
    `${base}/settings/icon`,
    `${base}/..%2Finvites`,
    `${base}/settings%2F..%2Finvites`,
  ])('has no route at %s', async (path) => {
    // Purpose: fails if a caller-built segment reaches the space.
    const response = await request(server).get(path);
    expect(response.status).toBe(404);
    expect(remote).not.toHaveBeenCalled();
  });

  it('sends none of the caller’s query to the space', async () => {
    // Purpose: fails if a query string on the local request is forwarded upstream.
    await request(server).get(`${base}/settings?path=/api/v1/invites&cursor=x`);
    expect(remote.mock.calls[0]![1]).toBe(`/api/v1/communities/${REMOTE_ID}/settings`);
  });

  it('answers a write with no route', async () => {
    // Purpose: fails if any of the reads accepts a method that changes something.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(server)[method](`${base}/settings`).send({});
      expect(response.status, method).toBe(404);
    }
    expect(remote).not.toHaveBeenCalled();
  });
});

describe('refusals and the credential', () => {
  it('passes the space’s refusal on as a plain sentence of its own', async () => {
    // Purpose: fails if a member's 403 is not a sentence the Settings tab can show.
    remote.mockRejectedValue(new PinnedHttpError(403, 'FORBIDDEN'));
    const response = await request(server).get(`${base}/members`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'This space doesn’t show who is in it to your role.',
      code: 'SPACE_READ_FORBIDDEN',
    });
  });

  it('asks for a reconnect when the grant was rejected', async () => {
    credential.mockRejectedValueOnce(new RemoteConnectionAuthorizationError());
    const response = await request(server).get(`${base}/rules`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('COMMUNITY_RECONNECT_REQUIRED');
  });

  it('keeps the credential out of every answer and every log line when the space fails', async () => {
    // Purpose: fails if a forced upstream failure echoes or logs the connection's grant.
    const lines: string[] = [];
    for (const level of ['warn', 'error', 'info', 'debug'] as const)
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    const failures: unknown[] = [
      new PinnedHttpError(500, 'UNAVAILABLE'),
      new PinnedOriginError('REMOTE_UNAVAILABLE'),
      new PinnedOriginError('REMOTE_RESPONSE'),
      new Error(`socket hang up Authorization: Bearer ${TOKEN}`),
    ];
    const fresh = await mkdtemp(join(tmpdir(), 'space-settings-empty-'));
    const empty = await serve(reader(fresh));
    try {
      for (const failure of failures) {
        remote.mockRejectedValueOnce(failure);
        const response = await request(empty).get(`${base}/settings`);
        expect(response.status).toBeGreaterThanOrEqual(500);
        expect(response.text).not.toContain(TOKEN);
      }
      // An answer with a field the wire does not have fails its strict schema and is not passed
      // on, so a credential the space put in an extra field never reaches the app.
      remote.mockResolvedValueOnce({ ...SETTINGS, name: TOKEN, extra: TOKEN });
      const echoed = await request(empty).get(`${base}/settings`);
      expect(echoed.status).toBe(502);
      expect(echoed.text).not.toContain(TOKEN);
    } finally {
      await close(empty);
      await rm(fresh, { recursive: true, force: true });
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('the last answer, for when the space cannot be reached', () => {
  it('shows the last value with when it came, marked offline', async () => {
    // Purpose: fails if an unreachable space shows nothing although it answered before.
    clock = new Date('2026-10-20T08:00:00.000Z');
    await request(server).get(`${base}/settings`).expect(200);
    clock = new Date('2026-10-20T10:00:00.000Z');
    remote.mockRejectedValue(new PinnedOriginError('REMOTE_UNAVAILABLE'));
    const response = await request(server).get(`${base}/settings`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      value: SETTINGS,
      fetchedAt: '2026-10-20T08:00:00.000Z',
      offline: true,
    });
  });

  it('keeps it across a restart, and never writes the credential to disk', async () => {
    // Purpose: fails if the kept answer is memory-only, or the file holds the grant.
    clock = new Date('2026-10-20T09:00:00.000Z');
    await request(server).get(`${base}/rules`).expect(200);
    const restarted = await serve(reader());
    try {
      remote.mockRejectedValue(new PinnedHttpError(503, 'UNAVAILABLE'));
      const response = await request(restarted).get(`${base}/rules`);
      expect(response.body).toMatchObject({
        offline: true,
        fetchedAt: '2026-10-20T09:00:00.000Z',
      });
    } finally {
      await close(restarted);
    }
    const kept = join(directory, 'communities', 'remote', 'space-settings');
    for (const file of await readdir(kept))
      expect(await readFile(join(kept, file), 'utf8')).not.toContain(TOKEN);
  });

  it('says it cannot reach a space that never answered', async () => {
    remote.mockRejectedValue(new PinnedOriginError('REMOTE_UNAVAILABLE'));
    const fresh = await mkdtemp(join(tmpdir(), 'space-settings-never-'));
    const never = await serve(reader(fresh));
    try {
      const response = await request(never).get(`${base}/members`);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: 'Can’t reach this space right now.',
        code: 'SPACE_UNREACHABLE',
      });
    } finally {
      await close(never);
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('does not stand in for a refusal: a 403 now is a 403, not the last answer', async () => {
    // Purpose: fails if a member who lost access keeps seeing what they were once shown.
    await request(server).get(`${base}/members`).expect(200);
    remote.mockRejectedValue(new PinnedHttpError(403, 'FORBIDDEN'));
    expect((await request(server).get(`${base}/members`)).status).toBe(403);
  });
});

describe('the kept answers under load and after a refusal', () => {
  it('keeps all four when they answer at once, in memory and after a restart', async () => {
    // Purpose: fails if concurrent writes to one connection's kept file lose each other's read.
    const fresh = await mkdtemp(join(tmpdir(), 'space-settings-race-'));
    // All four answer in the same tick, so their writes to the one kept file overlap.
    remote.mockImplementation(async (_origin, path) => ANSWERS[path]);
    const live = reader(fresh);
    const reads = ['settings', 'me', 'members', 'rules'] as const;
    await Promise.all(reads.map((read) => live.read(ref, 'author-a', read)));
    remote.mockRejectedValue(new PinnedOriginError('REMOTE_UNAVAILABLE'));
    try {
      for (const kept of [live, reader(fresh)])
        for (const read of reads)
          expect((await kept.read(ref, 'author-a', read)).offline, read).toBe(true);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('forgets what it kept once the space refuses, so going offline shows nothing stale', async () => {
    // Purpose: fails if a member who lost access sees the old directory when the space is down.
    const fresh = await mkdtemp(join(tmpdir(), 'space-settings-refused-'));
    const target = await serve(reader(fresh));
    try {
      await request(target).get(`${base}/members`).expect(200);
      remote.mockRejectedValue(new PinnedHttpError(403, 'FORBIDDEN'));
      const refused = await request(target).get(`${base}/members`);
      expect(refused.status).toBe(403);
      expect(refused.headers['cache-control']).toBe('no-store');
      remote.mockRejectedValue(new PinnedOriginError('REMOTE_UNAVAILABLE'));
      const down = await request(target).get(`${base}/members`);
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('SPACE_UNREACHABLE');
    } finally {
      await close(target);
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('asks for a reconnect when a 401 turns out to be a rejected grant', async () => {
    // Purpose: fails if a rejected grant reads as "not shown to the app yet".
    remote.mockRejectedValue(new PinnedHttpError(401, 'UNAUTHENTICATED'));
    grantRejected.mockResolvedValue(true);
    const response = await request(server).get(`${base}/rules`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Reconnect this space to continue.',
      code: 'COMMUNITY_RECONNECT_REQUIRED',
    });
  });

  it('keeps the connection when a 401 is an older space that takes no grant there', async () => {
    // Purpose: fails if one read an older space refuses breaks a working connection.
    remote.mockRejectedValue(new PinnedHttpError(401, 'UNAUTHENTICATED'));
    const response = await request(server).get(`${base}/settings`);
    expect(grantRejected).toHaveBeenCalledWith(ref, 'author-a');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SPACE_READ_UNAVAILABLE');
  });
});

describe('the connection store decides which connection is read', () => {
  const ACCESS = {
    state: 'verified' as const,
    effective: { read: true, post: true, enrollAgent: true, stream: true },
    lastKnown: {
      lifecycle: 'active' as const,
      capabilities: { read: true, post: true, enrollAgent: true, stream: true },
      verifiedAt: '2026-10-20T00:00:00.000Z',
    },
  };
  const secrets = new Map<string, string>();
  const memory = {
    put: async (name: string, secret: string) => {
      secrets.set(name, secret);
      return `file:${name}`;
    },
    get: async (name: string) => secrets.get(name) ?? null,
    delete: async (name: string) => {
      secrets.delete(name);
    },
  };

  async function storeWith(owner: string, status: 'pending' | 'connected' | 'reconnect-required') {
    const home = await mkdtemp(join(tmpdir(), 'space-settings-store-'));
    const store = new RemoteConnectionStore(home, memory);
    await store.addPending(
      {
        ref,
        ownerKey: owner,
        remoteCommunityId: REMOTE_ID,
        label: 'Northwind',
        pinnedOrigin: 'https://space.example',
        pairingId: 'pairing-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      'verifier'
    );
    if (status !== 'pending') await store.complete(ref, owner, 'm-1', TOKEN, ACCESS);
    if (status === 'reconnect-required') await store.requireReconnect(ref, owner);
    const real = new SpaceSettingsReader(
      connectionSource(store, () => ({ status: vi.fn() }) as never),
      new SpaceSettingsCache(home),
      remote
    );
    return { home, target: await serve(real) };
  }

  it.each([
    ['another owner’s connection', 'author-b', 'connected', 404],
    ['a connection still pending approval', 'author-a', 'pending', 404],
    ['a connection that needs reconnecting', 'author-a', 'reconnect-required', 409],
  ] as const)('refuses %s without asking the space', async (_label, owner, status, code) => {
    // Purpose: fails if a read reaches the space through a connection this owner may not use.
    const { home, target } = await storeWith(owner, status);
    try {
      const response = await request(target).get(`${base}/settings`);
      expect(response.status).toBe(code);
      expect(remote).not.toHaveBeenCalled();
    } finally {
      await close(target);
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reads this owner’s connected space with its own stored grant', async () => {
    const { home, target } = await storeWith('author-a', 'connected');
    try {
      await request(target).get(`${base}/settings`).expect(200);
      expect(remote.mock.calls[0]![4]).toMatchObject({ authorization: TOKEN });
    } finally {
      await close(target);
      await rm(home, { recursive: true, force: true });
    }
  });
});
