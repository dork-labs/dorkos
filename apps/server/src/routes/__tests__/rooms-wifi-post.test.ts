/**
 * A person's room post or thread reply from Wi-Fi is written held to the
 * runtime's default, so every turn it starts runs at Default at most
 * (DOR-3037), unless it is the owner's own (DOR-3242). Where the hold goes from
 * there is pinned in
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
// The install's owner is the account `x-test-signed-in: owner` signs in as.
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'owner' }),
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

/**
 * A person who is not the owner, signed in on their phone and a member here.
 * A write needs a person's session once an owner exists (DOR-3330), and a
 * Wi-Fi request only ever arrives with one, so the held case is theirs.
 */
const PHONE_PERSON = 'phone-person';

/** Headers for a browser session the gate verified, as `PHONE_PERSON` or the owner. */
function signedIn(userId: string): Record<string, string> {
  return { 'x-test-signed-in': userId, 'sec-fetch-site': 'same-origin' };
}

beforeEach(() => {
  setRoomService(createRoomSubsystem({ db: createTestDb() }).service);
  const service = getRoomService();
  const human = service.authorRegistry.localHuman().id;
  const phone = service.authorRegistry.human(PHONE_PERSON).id;
  roomId = service.createRoom(
    { kind: 'channel', title: 'Backend', members: [phone], agentPaths: [] },
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
          // Whose sign-in the gate verified on the Wi-Fi route, when one did.
          const signedIn = c.req.header('x-test-signed-in');
          if (signedIn) {
            c.set('user', {
              userId: signedIn,
              credential: 'cookie',
              sessionId: 's',
              route: 'wifi',
            });
          }
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
      .set(signedIn(PHONE_PERSON))
      .send({ text: 'from the phone' });
    expect(wifi.status).toBe(202);
    const here = await request(target.server)
      .post(`/api/rooms/${roomId}/entries`)
      .set(signedIn('owner'))
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
      .set(signedIn(PHONE_PERSON))
      .send({ rootEntryId, text: 'replying from the phone' });
    expect(res.status).toBe(202);
    expect(vi.mocked(getRoomService().post).mock.calls[0]![3]).toBe('runtime-default');
  });

  // DOR-3330: with an owner, a write with no person's session is any program
  // here, so it is refused rather than held.
  it('is refused, not held, when nobody is signed in', async () => {
    const res = await request(target.server)
      .post(`/api/rooms/${roomId}/entries`)
      .set('x-test-via', 'wifi')
      .send({ text: 'from nobody' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PERSON_SESSION_REQUIRED');
    expect(vi.mocked(getRoomService().post)).not.toHaveBeenCalled();
  });

  // DOR-3242: the owner's own words from Wi-Fi are theirs; a teammate's are not.
  it('is not held when the owner posts or replies from Wi-Fi', async () => {
    for (const [path, body] of [
      ['entries', { text: 'from my phone' }],
      ['threads', { rootEntryId, text: 'replying from my phone' }],
    ] as const) {
      const res = await request(target.server)
        .post(`/api/rooms/${roomId}/${path}`)
        .set('x-test-via', 'wifi')
        .set('x-test-signed-in', 'owner')
        .set('sec-fetch-site', 'same-origin')
        .send(body);
      expect(res.status).toBe(202);
    }
    const calls = vi.mocked(getRoomService().post).mock.calls;
    expect(calls.map((call) => call[3])).toEqual([undefined, undefined]);
  });

  // The teammate is not a member here, so the service refuses the post itself;
  // what this pins is the bound the route asked it to write with.
  it('is still held when a teammate posts from Wi-Fi', async () => {
    await request(target.server)
      .post(`/api/rooms/${roomId}/entries`)
      .set('x-test-via', 'wifi')
      .set('x-test-signed-in', 'teammate')
      .send({ text: 'from a teammate' });
    expect(vi.mocked(getRoomService().post).mock.calls[0]![3]).toBe('runtime-default');
  });
});
