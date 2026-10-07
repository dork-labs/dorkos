import { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { describe, it, expect, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

/**
 * Proves the Community navigation endpoints are reachable through the app that
 * production boots, with the real router and the real preference service.
 *
 * A merge once dropped every `/community-connections/navigation*` route while
 * the router's unit test still passed against an injected service. The client
 * then fell through to `/:ref`, got a 404, never confirmed its owner, and the
 * Connections page stopped loading its communities. This test asks the booted
 * app, so dropping the routes or their service wiring fails here.
 */

const config = vi.hoisted(() => {
  const values: Record<string, unknown> = {
    ui: { communityNavigation: { version: 1, owners: [] } },
    // Spaces are an experiment, off by default (DOR-2740); these routes exist
    // only while it is on. The last describe below turns it off.
    spaces: { enabled: true },
  };
  return {
    values,
    get: (key: string) => values[key] ?? null,
    set: (key: string, value: unknown) => {
      values[key] = value;
    },
    // The preference service writes only `ui.communityNavigation`, so the
    // settings broadcast can tell movement from a settings change (DOR-2227).
    // A double without this made every navigation write a 502.
    setDot: (key: string, value: unknown) => {
      const [section, ...rest] = key.split('.');
      let node = (values[section!] ??= {}) as Record<string, unknown>;
      for (const segment of rest.slice(0, -1)) {
        node = (node[segment] ??= {}) as Record<string, unknown>;
      }
      if (rest.length === 0) values[section!] = value;
      else node[rest.at(-1)!] = value;
      return {};
    },
  };
});

vi.mock('../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (target: string) => target),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));
vi.mock('../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => ({ type: 'claude-code' })),
    getDefaultType: vi.fn(() => 'claude-code'),
    getAllCapabilities: vi.fn(() => ({})),
    has: vi.fn(() => true),
    get: vi.fn(() => ({ type: 'claude-code' })),
    resolveForSession: vi.fn(async () => ({ type: 'claude-code' })),
  },
}));
vi.mock('../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../services/core/config-manager.js', () => ({
  configManager: { get: config.get, set: config.set, setDot: config.setDot },
}));
vi.mock('../routes/room-caller.js', () => ({
  resolveCaller: () => ({ id: 'author-a' }),
}));
vi.mock('../services/rooms/index.js', () => ({
  getRoomService: () => ({ authorRegistry: { isOwner: (id: string) => id === 'author-a' } }),
}));
vi.mock('../lib/caller-authority.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLocalCaller: () => true,
  requireOperatorCookieUnderLogin: () => undefined,
}));
// The official space (spec `official-community-space` D5): `official` is the configured
// link's connection, `other` any other space. `link` is '' until a test names one.
const spaces = vi.hoisted(() => {
  const OFFICIAL_URL = 'https://official.example/c/11111111-1111-4111-8111-111111111111';
  const pending = (ref: string, origin: string, official: boolean) => ({
    ref,
    remoteCommunityId: '11111111-1111-4111-8111-111111111111',
    label: ref,
    pinnedOrigin: origin,
    connectedHumanMemberId: null,
    status: 'pending' as const,
    expiresAt: '2099-01-01T00:00:00.000Z',
    access: null,
    attention: null,
    ...(official ? { official: true } : {}),
  });
  return {
    OFFICIAL_URL,
    link: '',
    started: [] as string[],
    connections: [
      pending('remote_official', 'https://official.example', true),
      pending('remote_other', 'https://other.example', false),
    ],
  };
});

vi.mock('../services/communities/remote/state.js', () => ({
  getRemotePairingService: () => ({
    list: async () => spaces.connections,
    start: async (_owner: string, url: string) => {
      spaces.started.push(url);
      return {
        connection: spaces.connections[0],
        approvalUrl: 'https://official.example/c/x/pairing?pairingId=p',
      };
    },
  }),
  getRemoteCommunityAdapter: () => ({ getRoom: async () => null }),
  getRemoteWakePolicy: () => ({ get: async () => 'me', set: async () => undefined }),
  getOfficialSpace: () => ({
    reachable: (ref: string) =>
      (config.values.spaces as { enabled?: boolean } | undefined)?.enabled === true ||
      (spaces.link !== '' && ref === 'remote_official'),
    isOfficialLink: (url: string) => spaces.link !== '' && url === spaces.link,
    origin: () => (spaces.link ? new URL(spaces.link).origin : null),
  }),
}));

import { createApp, finalizeApp } from '../app.js';

const target = swappableServer();

/** A finished app with the production API mounts. */
function bootApp() {
  const app = createApp({ admission: new MainRequestAdmission() });
  finalizeApp(app);
  return target.mount(app);
}

describe('Community navigation routes in the booted app', () => {
  it('serves every navigation call the client makes, ahead of the /:ref routes', async () => {
    const app = bootApp();
    const state = await request(app).get('/api/community-connections/navigation');
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ ownerKey: 'author-a', order: [], destinations: [] });

    const installation = await request(app)
      .put('/api/community-connections/navigation/installation')
      .send({ destination: { path: '/tasks', search: { view: 'board' } } });
    expect(installation.status).toBe(200);
    expect(installation.body.installationDestination).toEqual({
      path: '/tasks',
      search: { view: 'board' },
    });
    // Written through to the store, not just echoed back.
    expect(config.values.ui).toMatchObject({
      communityNavigation: {
        owners: [{ ownerKey: 'author-a', installationDestination: { path: '/tasks' } }],
      },
    });

    const destination = await request(app)
      .put('/api/community-connections/navigation/destination')
      .send({ ref: 'community-a', roomId: 'room-a', threadId: null, scrollAnchorEntryId: null });
    expect(destination.status).toBe(200);

    const move = await request(app)
      .post('/api/community-connections/navigation/move')
      .send({ ref: 'community-a', direction: 'down' });
    expect(move.status).toBe(200);

    const resolved = await request(app).get(
      '/api/community-connections/navigation/community-a/destination'
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ destination: null });
  });
});

describe('Space routes while the spaces experiment is off (DOR-2740)', () => {
  it.each([
    ['GET', '/api/community-connections/navigation'],
    ['GET', '/api/community-connections'],
    ['GET', '/api/communities/community-a/rooms'],
    ['GET', '/api/communities/community-a/rooms/general/events'],
    ['GET', '/api/cloud/communities'],
    ['POST', '/api/cloud/communities'],
  ])('%s %s refuses with SPACES_DISABLED and touches nothing', async (method, path) => {
    config.values.spaces = { enabled: false };
    try {
      const app = bootApp();
      const before = JSON.stringify(config.values.ui);
      const res =
        method === 'GET' ? await request(app).get(path) : await request(app).post(path).send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: 'Spaces are switched off. Turn them on in Settings → Advanced → Experiments.',
        code: 'SPACES_DISABLED',
      });
      expect(JSON.stringify(config.values.ui)).toBe(before);
    } finally {
      config.values.spaces = { enabled: true };
    }
  });

  it('treats a config with no spaces section as off', async () => {
    delete config.values.spaces;
    try {
      const res = await request(bootApp()).get('/api/community-connections/navigation');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SPACES_DISABLED');
    } finally {
      config.values.spaces = { enabled: true };
    }
  });

  it('takes effect without a restart: the same app answers once it is turned on', async () => {
    config.values.spaces = { enabled: false };
    const app = bootApp();
    expect((await request(app).get('/api/community-connections/navigation')).status).toBe(404);
    config.values.spaces = { enabled: true };
    expect((await request(app).get('/api/community-connections/navigation')).status).toBe(200);
  });
});

// Spec `official-community-space` D5. Each case fails if the exception is dropped (the official
// space refused) or widened (another space, Start or hosting let through) while spaces are off.
describe('the official space while the spaces experiment is off', () => {
  async function offWithOfficial<T>(run: (app: ReturnType<typeof bootApp>) => Promise<T>) {
    config.values.spaces = { enabled: false };
    spaces.link = spaces.OFFICIAL_URL;
    spaces.started.length = 0;
    try {
      return await run(bootApp());
    } finally {
      config.values.spaces = { enabled: true };
      spaces.link = '';
    }
  }

  it('lists only the official row', async () => {
    await offWithOfficial(async (app) => {
      const res = await request(app).get('/api/community-connections');
      expect(res.status).toBe(200);
      expect(res.body.connections.map((c: { ref: string }) => c.ref)).toEqual(['remote_official']);
    });
  });

  it('lists every row with spaces on', async () => {
    spaces.link = spaces.OFFICIAL_URL;
    try {
      const res = await request(bootApp()).get('/api/community-connections');
      expect(res.body.connections).toHaveLength(2);
    } finally {
      spaces.link = '';
    }
  });

  it('starts a pairing from the official link and from no other', async () => {
    await offWithOfficial(async (app) => {
      const official = await request(app)
        .post('/api/community-connections')
        .send({ url: spaces.OFFICIAL_URL, installName: 'Mine' });
      expect(official.status).toBe(201);
      const other = await request(app).post('/api/community-connections').send({
        url: 'https://other.example/c/22222222-2222-4222-8222-222222222222',
        installName: 'Mine',
      });
      expect(other.status).toBe(404);
      expect(other.body.code).toBe('SPACES_DISABLED');
      expect(spaces.started).toEqual([spaces.OFFICIAL_URL]);
    });
  });

  it('answers a :ref route for the official connection only', async () => {
    await offWithOfficial(async (app) => {
      const official = await request(app).get(
        '/api/community-connections/remote_official/wake-agents-from'
      );
      expect(official.status).toBe(200);
      expect(official.body).toEqual({ wakeAgentsFrom: 'me' });
      const other = await request(app).get(
        '/api/community-connections/remote_other/wake-agents-from'
      );
      expect(other.status).toBe(404);
      expect(other.body.code).toBe('SPACES_DISABLED');
      const otherRooms = await request(app).get('/api/communities/remote_other/rooms');
      expect(otherRooms.body.code).toBe('SPACES_DISABLED');
      const otherDestination = await request(app).get(
        '/api/community-connections/navigation/remote_other/destination'
      );
      expect(otherDestination.body.code).toBe('SPACES_DISABLED');
      const otherMove = await request(app)
        .post('/api/community-connections/navigation/move')
        .send({ ref: 'remote_other', direction: 'down' });
      expect(otherMove.body.code).toBe('SPACES_DISABLED');
    });
  });

  it('lets an official :ref through to the space routes', async () => {
    await offWithOfficial(async (app) => {
      const res = await request(app).get('/api/communities/remote_official/rooms');
      expect(res.body.code).not.toBe('SPACES_DISABLED');
    });
  });

  it('keeps starting and hosting spaces off', async () => {
    await offWithOfficial(async (app) => {
      for (const res of [
        await request(app).get('/api/cloud/communities'),
        await request(app).post('/api/cloud/communities').send({}),
        await request(app).get('/api/cloud/communities/name-check?name=abc'),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('SPACES_DISABLED');
      }
    });
  });
});
