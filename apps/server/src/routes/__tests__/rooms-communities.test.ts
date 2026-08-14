/**
 * @vitest-environment node
 *
 * `GET /api/rooms` end-to-end with a SECOND community registered.
 *
 * The other room-route tests exercise the shape of the list on an install that
 * is only in this one community, which is every install today — so they can only
 * ever see `warnings: []`. This file is the other half: it registers a second
 * backend into the **real** `communityRegistry` singleton the route reaches, and
 * asserts the HTTP response actually carries the degradation. Without it, the
 * claim that the port is load-bearing rests on a unit test calling the service
 * directly, which would not notice the route dropping the field.
 *
 * It lives in its own file BECAUSE it mutates that singleton, and the registry
 * has no removal (a community you leave is a surface nobody has built). Vitest
 * isolates modules per test file, so the mutation cannot reach another file's
 * registry — in a shared file it would leak into every later test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { FakeCommunityAdapter } from '@dorkos/test-utils/fake-community-adapter';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CommunityRef } from '@dorkos/shared/community-adapter';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { createApp, finalizeApp } from '../../app.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import { communityRegistry } from '../../services/communities/index.js';
import { resetAgentIdentityService } from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

/** A second community, addressed by a ULID the way a real one would be. */
const REMOTE = '01K1BXCQ4M7GKZ9V0S2R7XQ3AB' as CommunityRef;

describe('GET /api/rooms with a second community registered', () => {
  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    const rooms = createRoomSubsystem({ db: createTestDb() });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /** Open a channel so the local half of the list is never trivially empty. */
  async function createChannel(title = 'Backend'): Promise<{ id: string }> {
    const res = await request(app).post('/api/rooms').send({ kind: 'channel', title });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('reports the second community on the wire, and still lists this machine', async () => {
    await createChannel();
    const remote = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    remote.seedRoom({ entries: 1 });
    remote.seedRoom({ entries: 1 });
    communityRegistry.register(remote, 'Dork Labs');

    const res = await request(app).get('/api/rooms');

    expect(res.status).toBe(200);
    expect(res.body.rooms, "this machine's rooms are unaffected").toHaveLength(1);
    expect(res.body.warnings).toEqual([
      {
        community: REMOTE,
        label: 'Dork Labs',
        message: "2 rooms in Dork Labs aren't available here.",
      },
    ]);
  });

  it('degrades a broken community to a warning without failing the request', async () => {
    await createChannel();
    const broken = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    vi.spyOn(broken, 'listRooms').mockRejectedValue(new Error('relay closed the socket'));
    communityRegistry.register(broken, 'Dork Labs');

    const res = await request(app).get('/api/rooms');

    expect(res.status, 'one broken community is not a failed request').toBe(200);
    expect(res.body.rooms).toHaveLength(1);
    expect(res.body.warnings).toEqual([
      { community: REMOTE, label: 'Dork Labs', message: 'Dork Labs could not be reached.' },
    ]);
    // The adapter's own words never reach the wire, only the log.
    expect(JSON.stringify(res.body)).not.toContain('relay closed the socket');
  });
});
