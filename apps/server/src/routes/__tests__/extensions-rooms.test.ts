/**
 * `api.rooms` on the server (DOR-3017): a mini app reads and replies in a room
 * thread as the signed-in person, only in rooms the person picked for it.
 *
 * The refusals are the point. Each case that must post nothing checks the room
 * log afterwards, so "refused" means the reply is not there, not just that the
 * status was 403.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';

const state = vi.hoisted(() => ({
  authEnabled: false,
  extensions: { roomAccess: {} as Record<string, string[]> } as Record<string, unknown>,
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: state.authEnabled };
      if (key === 'extensions') return state.extensions;
      return null;
    },
    set: (key: string, value: unknown) => {
      if (key === 'extensions') state.extensions = value as Record<string, unknown>;
    },
  },
}));
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');
vi.stubEnv('DORKOS_CORS_ORIGIN', 'https://evil.example');
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { openSseStream } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, auditEvents, type Db } from '@dorkos/db';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createExtensionsRoutes } from '../extensions.js';
import { scriptedRunner } from '../../services/rooms/__tests__/room-test-harness.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomService,
} from '../../services/rooms/index.js';
import { ReadCursorStore } from '../../services/core/read-cursor-store.js';
import {
  ReadCursorService,
  setReadCursorService,
} from '../../services/core/read-cursor-service.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';

const target = swappableServer();
const server = target.server;
const TRUSTED_ORIGIN = 'http://localhost:7777';
const APP = { Origin: TRUSTED_ORIGIN, 'X-Client-Id': 'web-test' };
const ANA_PATH = '/agents/ana';

afterAll(() => vi.unstubAllEnvs());

let db: Db;
let service: RoomService;
let personId: string;
let anaId: string;
let roomId: string;
let otherRoomId: string;
let rootId: string;
let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
let statusOf: Record<string, string>;

/** Register an agent so the room can resolve it by directory. */
function registerAgent(name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0]!.toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"silent"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

/** Every reply in the thread, as stored. */
function storedReplies(thread = rootId, room = roomId) {
  return service.readHistory(room, personId, { limit: 200, threadRootEntryId: thread });
}

/** Let the mini app use these rooms. */
function allow(...ids: string[]): void {
  state.extensions = { ...state.extensions, roomAccess: { social: ids } };
}

const base = (room = roomId, thread = rootId) =>
  `/api/extensions/social/rooms/${room}/threads/${thread}`;

beforeEach(async () => {
  state.authEnabled = false;
  state.extensions = { roomAccess: {} };
  signedInUser = undefined;
  statusOf = { social: 'compiled', off: 'disabled', plain: 'compiled' };
  db = createTestDb();
  registerAgent('ana', ANA_PATH);
  const subsystem = createRoomSubsystem({ db, turns: scriptedRunner(() => null) });
  service = subsystem.service;
  setRoomService(service);
  setReadCursorService(new ReadCursorService(new ReadCursorStore(db)));
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
  personId = subsystem.authors.localHuman().id;
  anaId = subsystem.authors.resolveAgent(ANA_PATH, 'Ana').id;
  roomId = service.createRoom(
    { kind: 'channel', title: 'Marketing', slug: 'marketing', members: [], agentPaths: [ANA_PATH] },
    personId
  ).id;
  // A room the person is not in: Ana made it alone.
  otherRoomId = service.createRoom(
    { kind: 'channel', title: 'Ana only', slug: 'ana-only', members: [], agentPaths: [] },
    anaId
  ).id;
  rootId = service.post(roomId, { authorId: anaId, text: 'Tue post: launch thread' }).id;
  service.post(roomId, { authorId: anaId, text: 'Draft is ready.', replyTo: rootId });
  await service.triggersIdle();

  const manager = {
    get: (id: string) =>
      statusOf[id]
        ? {
            id,
            status: statusOf[id],
            manifest: {
              id,
              name: id === 'social' ? 'Social Manager' : 'Other',
              version: '1.0.0',
              // `plain` never asks for rooms.
              ...(id === 'plain' ? {} : { capabilities: { rooms: true } }),
            },
          }
        : undefined,
    listPublic: () => [],
  };
  target.mount(
    honoGroupListener(
      {
        path: '/api/extensions',
        routes: createExtensionsRoutes({
          manager: manager as never,
          dorkHome: '/tmp/unused',
          getCwd: () => null,
        }),
      },
      {
        before: async (c, next) => {
          if (signedInUser) c.set('user', signedInUser as never);
          await next();
        },
      }
    )
  );
});

afterEach(() => {
  resetAuditTrail();
});

describe('reading a thread', () => {
  it('reads the root and replies, oldest first, with who wrote each', async () => {
    allow(roomId);
    service.post(roomId, { authorId: personId, text: 'Ship it.', replyTo: rootId });

    const res = await request(server).get(base());

    expect(res.status).toBe(200);
    expect(res.body.roomTitle).toBe('#marketing');
    expect(res.body.root).toMatchObject({
      id: rootId,
      text: 'Tue post: launch thread',
      author: { id: anaId, name: 'Ana', kind: 'agent', isYou: false },
    });
    expect(res.body.replies.map((r: { text: string }) => r.text)).toEqual([
      'Draft is ready.',
      'Ship it.',
    ]);
    expect(res.body.replies[1].author).toMatchObject({ id: personId, kind: 'person', isYou: true });
    // Ana's reply is unread; the person's own is not counted.
    expect(res.body.unreadCount).toBe(1);
  });

  it('reaches nothing when the person picked no rooms', async () => {
    const list = await request(server).get('/api/extensions/social/rooms');
    expect(list.status).toBe(200);
    expect(list.body.rooms).toEqual([]);

    const res = await request(server).get(base());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('room_not_allowed');
  });

  it('refuses a room picked for another mini app', async () => {
    state.extensions = { roomAccess: { other: [roomId] } };
    const res = await request(server).get(base());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('room_not_allowed');
  });

  it('follows room membership: a picked room the person is not in reads as not found', async () => {
    const otherRoot = service.post(otherRoomId, { authorId: anaId, text: 'private' }).id;
    allow(otherRoomId);

    const res = await request(server).get(base(otherRoomId, otherRoot));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect(JSON.stringify(res.body)).not.toContain('private');

    const list = await request(server).get('/api/extensions/social/rooms');
    expect(list.body.rooms).toEqual([]);
  });

  it('refuses a mini app whose manifest does not ask for rooms', async () => {
    state.extensions = { roomAccess: { plain: [roomId] } };
    const res = await request(server).get(
      `/api/extensions/plain/rooms/${roomId}/threads/${rootId}`
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('room_not_allowed');
  });

  it('refuses a root from another room, named under an allowed one', async () => {
    const otherRoot = service.post(otherRoomId, { authorId: anaId, text: 'elsewhere' }).id;
    allow(roomId);
    const res = await request(server).get(base(roomId, otherRoot));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('elsewhere');
  });

  it('refuses a reply id as a thread', async () => {
    allow(roomId);
    const replyId = storedReplies()[0]!.id;
    const res = await request(server).get(base(roomId, replyId));
    expect(res.status).toBe(404);
  });

  it('refuses an agent caller', async () => {
    allow(roomId);
    const res = await request(server).get(base()).set('X-DorkOS-Agent', 'any-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_required');
  });

  it('refuses a mini app that is turned off', async () => {
    state.extensions = { roomAccess: { off: [roomId] } };
    const res = await request(server).get(`/api/extensions/off/rooms/${roomId}/threads/${rootId}`);
    expect(res.status).toBe(409);
  });
});

describe('replying as the person', () => {
  beforeEach(() => allow(roomId));

  it('posts under the person’s own author id and records it with the mini app named', async () => {
    const res = await request(server)
      .post(`${base()}/replies`)
      .set(APP)
      .send({ text: 'Looks good' });

    expect(res.status).toBe(201);
    expect(res.body.author).toMatchObject({ id: personId, kind: 'person', isYou: true });
    const stored = storedReplies().find((e) => e.body.text === 'Looks good');
    expect(stored?.authorId).toBe(personId);
    expect(stored?.threadRootEntryId).toBe(rootId);

    const rows = db.select().from(auditEvents).all();
    expect(rows).toContainEqual(
      expect.objectContaining({
        action: 'extension.room_reply',
        outcome: 'ok',
        targetType: 'extension',
        targetId: 'social',
      })
    );
  });

  it('never lets the body name an author', async () => {
    const res = await request(server)
      .post(`${base()}/replies`)
      .set(APP)
      .send({ text: 'as Ana', authorId: anaId });
    expect(res.status).toBe(400);
    expect(storedReplies().some((e) => e.body.text === 'as Ana')).toBe(false);
  });

  /** Post, and prove nothing landed and the refusal was audited. */
  async function expectRefused(req: ReturnType<ReturnType<typeof request>['post']>, text: string) {
    const res = await req.send({ text });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_required');
    expect(storedReplies().some((e) => e.body.text === text)).toBe(false);
    return res;
  }

  it('refuses an agent caller, even with every app header', async () => {
    await expectRefused(
      request(server).post(`${base()}/replies`).set(APP).set('X-DorkOS-Agent', 'any-token'),
      'from an agent'
    );
    expect(db.select().from(auditEvents).all()).toContainEqual(
      expect.objectContaining({
        action: 'extension.room_reply',
        outcome: 'refused',
        error: 'agent',
      })
    );
  });

  it('refuses a caller with no Origin: the mini app’s server half or a script', async () => {
    await expectRefused(
      request(server).post(`${base()}/replies`).set('X-Client-Id', 'web-test'),
      'from a server half'
    );
  });

  it('refuses a page on another site', async () => {
    await expectRefused(
      request(server)
        .post(`${base()}/replies`)
        .set({ Origin: 'https://evil.example', 'X-Client-Id': 'web-test' }),
      'from evil'
    );
  });

  it('refuses a request that is not from a window of the app', async () => {
    await expectRefused(
      request(server).post(`${base()}/replies`).set('Origin', TRUSTED_ORIGIN),
      'no window'
    );
  });

  it('refuses a bearer credential while the computer does not ask for a password', async () => {
    await expectRefused(
      request(server).post(`${base()}/replies`).set(APP).set('Authorization', 'Bearer dk_key'),
      'with a key'
    );
  });

  it('with a password on, refuses an API key and takes a browser session', async () => {
    state.authEnabled = true;
    signedInUser = { userId: 'acct-1', credential: 'api-key' };
    await expectRefused(request(server).post(`${base()}/replies`).set(APP), 'via api key');

    signedInUser = { userId: 'acct-1', credential: 'cookie' };
    // The browser session passes the bar. That account is not in the room, so
    // it then reads as not found: it is never posted as somebody else.
    const res = await request(server).post(`${base()}/replies`).set(APP).send({ text: 'cookie' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect(storedReplies().some((e) => e.body.text === 'cookie')).toBe(false);
  });

  it('refuses a room the person did not pick, and posts nothing', async () => {
    const otherRoot = service.post(roomId, { authorId: anaId, text: 'other root' }).id;
    state.extensions = { roomAccess: { social: [otherRoomId] } };
    const res = await request(server)
      .post(`${base(roomId, otherRoot)}/replies`)
      .set(APP)
      .send({ text: 'sneaky' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('room_not_allowed');
    expect(storedReplies(otherRoot).length).toBe(0);
  });

  it('audits a reply refused because the mini app is turned off', async () => {
    statusOf.social = 'disabled';
    const res = await request(server).post(`${base()}/replies`).set(APP).send({ text: 'off' });
    expect(res.status).toBe(409);
    expect(db.select().from(auditEvents).all()).toContainEqual(
      expect.objectContaining({ action: 'extension.room_reply', outcome: 'refused' })
    );
  });

  it('refuses empty text', async () => {
    const res = await request(server).post(`${base()}/replies`).set(APP).send({ text: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('unread state', () => {
  beforeEach(() => allow(roomId));

  it('counts per thread and clears on mark-read', async () => {
    const before = await request(server).get(
      `/api/extensions/social/rooms/${roomId}/unread?threads=${rootId},missing`
    );
    expect(before.status).toBe(200);
    expect(before.body.counts).toEqual({ [rootId]: 1 });

    const marked = await request(server).put(`${base()}/read`).set(APP);
    expect(marked.status).toBe(204);

    const after = await request(server).get(
      `/api/extensions/social/rooms/${roomId}/unread?threads=${rootId}`
    );
    expect(after.body.counts).toEqual({ [rootId]: 0 });

    service.post(roomId, { authorId: anaId, text: 'One more thing.', replyTo: rootId });
    const again = await request(server).get(base());
    expect(again.body.unreadCount).toBe(1);
  });

  it('refuses mark-read from anything but the person’s window', async () => {
    const res = await request(server).put(`${base()}/read`).set('X-DorkOS-Agent', 'x');
    expect(res.status).toBe(403);
    const script = await request(server).put(`${base()}/read`);
    expect(script.status).toBe(403);
  });
});

describe('live replies', () => {
  it('streams new replies in the thread and nothing else', async () => {
    allow(roomId);
    const port = (server.address() as AddressInfo).port;
    const stream = openSseStream(port, `${base()}/events`, {
      until: (frames) => frames.some((f) => f.event === 'reply'),
    });
    await stream.ready;
    service.post(roomId, { authorId: anaId, text: 'Top-level chatter' });
    service.post(roomId, { authorId: anaId, text: 'Agent reply', replyTo: rootId });

    const frames = await stream.frames;
    const replies = frames.filter((f) => f.event === 'reply');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.data).toMatchObject({ text: 'Agent reply', author: { kind: 'agent' } });
  });

  it('replays only this thread’s replies on resume', async () => {
    allow(roomId);
    const elsewhere = service.post(roomId, { authorId: anaId, text: 'Another root' }).id;
    service.post(roomId, { authorId: anaId, text: 'Other thread', replyTo: elsewhere });
    service.post(roomId, { authorId: anaId, text: 'Second reply', replyTo: rootId });
    const port = (server.address() as AddressInfo).port;
    const stream = openSseStream(port, `${base()}/events?after=0`, {
      until: (frames) => frames.filter((f) => f.event === 'reply').length >= 2,
    });
    const texts = (await stream.frames)
      .filter((f) => f.event === 'reply')
      .map((f) => (f.data as { text: string }).text);
    expect(texts).toEqual(['Draft is ready.', 'Second reply']);
  });

  it('ends the stream once the room is taken away, sending nothing more', async () => {
    allow(roomId);
    const port = (server.address() as AddressInfo).port;
    const stream = openSseStream(port, `${base()}/events`, { until: () => false });
    await stream.ready;
    state.extensions = { roomAccess: {} };
    service.post(roomId, { authorId: anaId, text: 'After revoke', replyTo: rootId });
    const frames = await stream.frames;
    expect(frames.some((f) => f.event === 'reply')).toBe(false);
  });

  it('refuses to open a stream on a room that is not picked', async () => {
    const port = (server.address() as AddressInfo).port;
    const stream = openSseStream(port, `${base()}/events`, { until: () => true });
    expect(await stream.status).toBe(403);
  });
});

describe('choosing rooms', () => {
  it('lets the person pick rooms they are in', async () => {
    const res = await request(server)
      .put('/api/extensions/social/room-access')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ roomIds: [roomId] });
    expect(res.status).toBe(200);
    expect(res.body.roomIds).toEqual([roomId]);
    const read = await request(server).get('/api/extensions/social/room-access');
    expect(read.body.roomIds).toEqual([roomId]);
  });

  it('refuses an agent picking rooms for a mini app', async () => {
    const res = await request(server)
      .put('/api/extensions/social/room-access')
      .set('X-DorkOS-Agent', 'x')
      .send({ roomIds: [roomId] });
    expect(res.status).toBe(403);
    expect((state.extensions.roomAccess as Record<string, string[]>).social).toBeUndefined();
  });

  it('refuses an agent reading which rooms a mini app uses', async () => {
    allow(roomId);
    const res = await request(server)
      .get('/api/extensions/social/room-access')
      .set('X-DorkOS-Agent', 'x');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(roomId);
  });

  it('refuses rooms for a mini app that does not ask for them', async () => {
    const res = await request(server)
      .put('/api/extensions/plain/room-access')
      .send({ roomIds: [roomId] });
    expect(res.status).toBe(400);
    expect((state.extensions.roomAccess as Record<string, string[]>).plain).toBeUndefined();
  });

  it('refuses a room the person is not in', async () => {
    const res = await request(server)
      .put('/api/extensions/social/room-access')
      .send({ roomIds: [otherRoomId] });
    expect(res.status).toBe(400);
  });
});
