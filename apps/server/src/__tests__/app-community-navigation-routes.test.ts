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
  };
  return {
    values,
    get: (key: string) => values[key] ?? null,
    set: (key: string, value: unknown) => {
      values[key] = value;
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
  configManager: { get: config.get, set: config.set },
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
vi.mock('../services/communities/remote/state.js', () => ({
  getRemotePairingService: () => ({ list: async () => [] }),
  getRemoteCommunityAdapter: () => ({ getRoom: async () => null }),
}));

import { createApp, finalizeApp } from '../app.js';

const target = swappableServer();

/** A finished app with the production API mounts. */
function bootApp() {
  const app = createApp();
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
