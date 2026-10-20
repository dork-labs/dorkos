/**
 * A person's room post or thread reply from Wi-Fi is written held to the
 * runtime's default, so every turn it starts runs at Default at most
 * (DOR-3037). Where the hold goes from there is pinned in
 * `services/rooms/__tests__/wifi-room-posts.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getDefault: vi.fn(),
    get: vi.fn(),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => []),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { createRoomSubsystem, getRoomService, setRoomService } from '../../services/rooms/index.js';
import roomsRouter from '../rooms.js';

const target = swappableServer();
let roomId: string;
let rootEntryId: string;

beforeEach(() => {
  setRoomService(createRoomSubsystem({ db: createTestDb() }).service);
  const service = getRoomService();
  const human = service.authorRegistry.localHuman().id;
  roomId = service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
    human
  ).id;
  rootEntryId = service.post(roomId, { authorId: human, text: 'start of a thread' }).id;
  vi.spyOn(service, 'post');
  target.mount(
    honoGroupListener(
      { path: '/api/rooms', routes: roomsRouter },
      {
        before: async (c, next) => {
          if (c.req.header('x-test-via') === 'wifi') markIngress(c.env.incoming, 'wifi');
          await next();
        },
      }
    )
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a person’s room post', () => {
  it('is held to the runtime default from Wi-Fi, and unbounded at this computer', async () => {
    const wifi = await request(target.server)
      .post(`/api/rooms/${roomId}/entries`)
      .set('x-test-via', 'wifi')
      .send({ text: 'from the phone' });
    expect(wifi.status).toBe(202);
    const here = await request(target.server)
      .post(`/api/rooms/${roomId}/entries`)
      .send({ text: 'from this computer' });
    expect(here.status).toBe(202);

    const calls = vi.mocked(getRoomService().post).mock.calls;
    expect(calls[0]![3]).toBe('runtime-default');
    expect(calls[1]![3]).toBeUndefined();
  });

  it('holds a thread reply from Wi-Fi the same way', async () => {
    const res = await request(target.server)
      .post(`/api/rooms/${roomId}/threads`)
      .set('x-test-via', 'wifi')
      .send({ rootEntryId, text: 'replying from the phone' });
    expect(res.status).toBe(202);
    expect(vi.mocked(getRoomService().post).mock.calls[0]![3]).toBe('runtime-default');
  });
});
