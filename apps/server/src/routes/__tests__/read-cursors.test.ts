/**
 * `PUT /api/read-cursors/:kind/:id` — the one write path onto read state, and
 * the broadcast that carries it to the operator's other screens
 * (team-room-home spec §D4).
 *
 * The broadcast assertions read the REAL `GET /api/events` stream rather than
 * spying on `eventFanOut`. The whole point of the event is a second device, and
 * the route, the fan-out and the SSE encoding all sit between the write and
 * that screen — a spy on the broadcaster sees none of them.
 *
 * "And then nothing" is proved by waiting for the thing that happens INSTEAD.
 * Every silence case below writes a sentinel cursor afterwards and stops the
 * collector on that, so absence is observed rather than merely waited out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { openSseStream, type SseFrame } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { readCursors, type Db } from '@dorkos/db';
import { ReadCursorSchema } from '@dorkos/shared/read-cursor-schemas';

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
    getDefault: vi.fn(),
    get: vi.fn(),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => []),
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
import { createRoomSubsystem, setRoomService, getRoomService } from '../../services/rooms/index.js';
import { ReadCursorStore } from '../../services/core/read-cursor-store.js';
import {
  ReadCursorService,
  setReadCursorService,
} from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

/** Start the app on an ephemeral port for one test. */
async function listen(): Promise<{ port: number; close: () => void }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  };
}

/** The author id `resolveCaller` hands the local human — whose cursor every write here is. */
function callerId(): string {
  return getRoomService().authorRegistry.localHuman().id;
}

describe('PUT /api/read-cursors/:kind/:id', () => {
  let db: Db;
  let store: ReadCursorStore;
  let sentinelRoomId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createTestDb();
    // The rooms subsystem is wired for `resolveCaller`, which resolves the
    // caller through the author registry — read state is not a room concept,
    // but WHO is asking is the same question here as it is in a room.
    setRoomService(createRoomSubsystem({ db }).service);
    store = new ReadCursorStore(db);
    setReadCursorService(new ReadCursorService(store));
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Sentinel' });
    sentinelRoomId = created.body.id;
  });

  /**
   * A stop condition that does not depend on the event under test.
   *
   * Posting to a room emits `room_activity`, so {@link sentinel} terminates the
   * collector whether or not a `read_cursor` was broadcast. A sentinel made of
   * the event being asserted would turn "the broadcast was dropped" into a
   * five-second timeout instead of a failed expectation.
   */
  const stopsOnRoomActivity = (frames: SseFrame[]): boolean =>
    frames.some((f) => f.event === 'room_activity');

  /** Emit the independent stop event, once every write under test has landed. */
  const sentinel = (): Promise<unknown> =>
    request(app).post(`/api/rooms/${sentinelRoomId}/entries`).send({ text: 'sentinel' });

  it('stores the cursor and answers with it', async () => {
    const res = await request(app)
      .put(`/api/read-cursors/room/${sentinelRoomId}`)
      .send({ lastReadSeq: 4 })
      .expect(200);

    expect(res.body).toEqual({
      userId: callerId(),
      threadKind: 'room',
      threadId: sentinelRoomId,
      lastReadSeq: 4,
      updatedAt: expect.any(String),
    });
    expect(store.get(callerId(), 'room', sentinelRoomId)?.lastReadSeq).toBe(4);
  });

  /**
   * A room cursor is written by delegating into `RoomService.setReadCursor` —
   * the same call `PUT /api/rooms/:id/read-cursor` makes (team-room-home §D4,
   * task 3.3). Two things follow, and both are asserted here rather than argued:
   * the event carries the unread count only that domain can compute, and a room
   * this caller cannot see is refused instead of quietly storing a row.
   */
  describe('a room cursor goes through the room domain', () => {
    it('carries the unread count the room list has to patch with', async () => {
      await request(app).post(`/api/rooms/${sentinelRoomId}/entries`).send({ text: 'one' });
      await request(app).post(`/api/rooms/${sentinelRoomId}/entries`).send({ text: 'two' });

      const server = await listen();
      const stream = openSseStream(server.port, '/api/events', { until: stopsOnRoomActivity });
      await stream.ready;

      await request(app)
        .put(`/api/read-cursors/room/${sentinelRoomId}`)
        .send({ lastReadSeq: 1 })
        .expect(200);
      await sentinel();

      const frames = await stream.frames;
      server.close();

      // Without the count this event is one the room list cannot act on, so the
      // client drops it — and the badge stays lit on the other device, which is
      // the whole failure this route exists to avoid.
      expect(frames.filter((f) => f.event === 'read_cursor').map((f) => f.data)).toEqual([
        {
          userId: callerId(),
          threadKind: 'room',
          threadId: sentinelRoomId,
          lastReadSeq: 1,
          unreadCount: 1,
        },
      ]);
    });

    it("refuses a room the caller cannot see, in the rooms domain's own words", async () => {
      const res = await request(app)
        .put('/api/read-cursors/room/01JQZZZZZZZZZZZZZZZZZZZZZZ')
        .send({ lastReadSeq: 1 })
        .expect(404);

      expect(res.body.code).toBe('ROOM_NOT_FOUND');
      expect(store.get(callerId(), 'room', '01JQZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();
    });
  });

  it('announces the write once, and says nothing when the same value is written again', async () => {
    const server = await listen();
    const stream = openSseStream(server.port, '/api/events', { until: stopsOnRoomActivity });
    await stream.ready;

    await request(app).put('/api/read-cursors/session/s-4').send({ lastReadSeq: 4 }).expect(200);
    // The same seq again: monotonic, so it writes nothing and must therefore say
    // nothing. Re-opening a thread already read is the common case, and an event
    // per no-op would be the loudest name on this stream.
    await request(app).put('/api/read-cursors/session/s-4').send({ lastReadSeq: 4 }).expect(200);
    await sentinel();

    const frames = await stream.frames;
    server.close();

    const cursors = frames.filter((f) => f.event === 'read_cursor');
    expect(cursors).toHaveLength(1);
    // A session, so no unread count rides along: only the rooms domain can count
    // what is above a cursor, and this route invents nothing on its behalf.
    expect(cursors[0].data).toEqual({
      userId: callerId(),
      threadKind: 'session',
      threadId: 's-4',
      lastReadSeq: 4,
    });
  });

  it('says nothing when a thread is first read at position zero', async () => {
    // "Never opened" and "opened, nothing in it" are the same fact to the only
    // question a broadcast answers, which is whether the cursor MOVED. A first
    // write of 0 that announced itself would repaint an already-clear badge on
    // every screen this person has open.
    const server = await listen();
    const stream = openSseStream(server.port, '/api/events', { until: stopsOnRoomActivity });
    await stream.ready;

    const res = await request(app)
      .put('/api/read-cursors/session/s-zero-write')
      .send({ lastReadSeq: 0 })
      .expect(200);
    await sentinel();

    const frames = await stream.frames;
    server.close();

    // Stored, and silent: the row exists so a reader can tell 0 from absent.
    expect(res.body.lastReadSeq).toBe(0);
    expect(store.get(callerId(), 'session', 's-zero-write')?.lastReadSeq).toBe(0);
    expect(frames.filter((f) => f.event === 'read_cursor')).toHaveLength(0);
  });

  it('says nothing and stores nothing when a stale client writes a lower seq', async () => {
    await request(app).put('/api/read-cursors/session/s-1').send({ lastReadSeq: 9 }).expect(200);

    const server = await listen();
    const stream = openSseStream(server.port, '/api/events', { until: stopsOnRoomActivity });
    await stream.ready;

    const res = await request(app)
      .put('/api/read-cursors/session/s-1')
      .send({ lastReadSeq: 2 })
      .expect(200);
    await sentinel();

    const frames = await stream.frames;
    server.close();

    expect(res.body.lastReadSeq, 'the refused write answers with what still stands').toBe(9);
    expect(store.get(callerId(), 'session', 's-1')?.lastReadSeq).toBe(9);
    expect(frames.filter((f) => f.event === 'read_cursor')).toHaveLength(0);
  });

  it('carries every kind of thread', async () => {
    // A room is addressed by its real id, because a room cursor is written
    // through the rooms domain and that domain knows which rooms exist; the
    // other two kinds name threads no table here can check.
    for (const [kind, id] of [
      ['room', sentinelRoomId],
      ['session', 'thing-1'],
      ['inbox', 'thing-1'],
    ]) {
      await request(app)
        .put(`/api/read-cursors/${kind}/${id}`)
        .send({ lastReadSeq: 3 })
        .expect(200);
    }

    expect(store.get(callerId(), 'room', sentinelRoomId)?.lastReadSeq).toBe(3);
    expect(store.get(callerId(), 'inbox', 'thing-1')?.lastReadSeq).toBe(3);
  });

  /**
   * `read_cursors` is the USER-side store by contract — the table's own TSDoc
   * and ADR 260808-140956 both say so, and the agent-side cursor lives on
   * `room_members.last_read_seq` and stays there. An agent-authenticated write
   * here would put agent rows in a table nothing will ever read them out of,
   * and would do it silently. Refused at the door, exactly as reacting is.
   */
  it('refuses an agent presenting a real identity token', async () => {
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: '/agents/ana', displayName: 'Ana' });

    const server = await listen();
    const stream = openSseStream(server.port, '/api/events', { until: stopsOnRoomActivity });
    await stream.ready;

    const res = await request(app)
      .put('/api/read-cursors/room/room-1')
      .set('X-DorkOS-Agent', token)
      .send({ lastReadSeq: 4 });
    await sentinel();

    const frames = await stream.frames;
    server.close();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PEOPLE_ONLY');
    // Nothing stored under EITHER identity: not the agent's own author id, and
    // not the operator's — a refused write must not fall back to the human.
    expect(db.select().from(readCursors).all(), 'a refused write leaves nothing behind').toEqual(
      []
    );
    expect(frames.filter((f) => f.event === 'read_cursor')).toHaveLength(0);

    resetAgentIdentityService();
  });

  it('still serves that same agent elsewhere, so the refusal is about read state and not the token', async () => {
    // The control for the case above. Without it, a token the server simply
    // could not read would produce the identical 403 and the test would pass
    // while proving nothing about the boundary.
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: '/agents/ana', displayName: 'Ana' });

    const res = await request(app).get('/api/rooms').set('X-DorkOS-Agent', token);

    expect(res.status).toBe(200);
    resetAgentIdentityService();
  });

  it('refuses an unknown kind rather than accepting it silently', async () => {
    const res = await request(app)
      .put('/api/read-cursors/mailbox/thing-1')
      .send({ lastReadSeq: 1 })
      .expect(400);

    expect(res.body.error).toBe('Validation failed');
  });

  it('refuses an empty body rather than throwing on it', async () => {
    // Express 5 leaves `req.body` undefined on a PUT with no body at all, which
    // is a 400 here and not a 500.
    const res = await request(app).put('/api/read-cursors/room/room-1').expect(400);

    expect(res.body.error).toBe('Validation failed');
    expect(store.get(callerId(), 'room', 'room-1')).toBeNull();
  });

  it('refuses a negative seq', async () => {
    await request(app).put('/api/read-cursors/room/room-1').send({ lastReadSeq: -1 }).expect(400);

    expect(store.get(callerId(), 'room', 'room-1')).toBeNull();
  });

  it('is in the OpenAPI export the app serves', async () => {
    const spec = await request(app).get('/api/openapi.json');
    const path = spec.body.paths['/api/read-cursors/{kind}/{id}'];

    expect(path?.put).toBeDefined();
    expect(path.put.tags).toEqual(['Read state']);
    // 404 is here because a `room` cursor is written through the rooms domain,
    // which refuses a room the caller cannot see. A client that only knew about
    // 400/403 would treat that as an unexpected failure.
    expect(Object.keys(path.put.responses).sort()).toEqual(['200', '400', '403', '404']);
    expect(
      path.put.description,
      'the refusal a client will actually hit has to be documented, not only returned'
    ).toContain('PEOPLE_ONLY');
    expect(path.put.description, 'and so does the one that only applies to rooms').toContain(
      'ROOM_NOT_FOUND'
    );
  });
});

/**
 * `GET /api/read-cursors/:kind/:id` — where a screen that has just opened finds
 * out where the reader left off, before any event arrives (team-room-home §D4).
 *
 * The case that matters most here is the boring one: a thread nobody has read.
 * It is the state every thread starts in, so it has to be an ordinary 200 with
 * `null` and not an error a client would learn to ignore.
 */
describe('GET /api/read-cursors/:kind/:id', () => {
  let db: Db;
  let store: ReadCursorStore;
  /** A room that actually exists — a room cursor is written through its domain. */
  let roomId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createTestDb();
    setRoomService(createRoomSubsystem({ db }).service);
    store = new ReadCursorStore(db);
    setReadCursorService(new ReadCursorService(store));
    const created = await request(app).post('/api/rooms').send({ kind: 'channel', title: 'Kinds' });
    roomId = created.body.id;
  });

  it('answers null for a thread this person has never read', async () => {
    const res = await request(app).get('/api/read-cursors/session/s-1').expect(200);

    expect(res.body).toEqual({ cursor: null });
  });

  it('answers with the cursor a write left behind', async () => {
    await request(app).put('/api/read-cursors/session/s-1').send({ lastReadSeq: 7 }).expect(200);

    const res = await request(app).get('/api/read-cursors/session/s-1').expect(200);

    // Parsed against the shared schema, not only shape-matched: this body is
    // what the client's `getReadCursor` is typed as, and a field that drifted
    // out of the wire contract would otherwise show up as a client-side
    // `undefined` and nothing else.
    expect(ReadCursorSchema.parse(res.body.cursor)).toEqual({
      userId: callerId(),
      threadKind: 'session',
      threadId: 's-1',
      lastReadSeq: 7,
      updatedAt: expect.any(String),
    });
  });

  it('keeps kinds apart under one thread id', async () => {
    // The same id can name a room and a session at once — nothing coordinates
    // those two id spaces — so a read must answer for the kind it was asked
    // about and not for whichever row was written first. A room id is what a
    // session would have to collide WITH, so it is the honest id to use.
    await request(app).put(`/api/read-cursors/room/${roomId}`).send({ lastReadSeq: 5 }).expect(200);

    const session = await request(app).get(`/api/read-cursors/session/${roomId}`).expect(200);
    const room = await request(app).get(`/api/read-cursors/room/${roomId}`).expect(200);

    expect(session.body.cursor).toBeNull();
    expect(room.body.cursor?.lastReadSeq).toBe(5);
  });

  it('answers a stored zero as a cursor, not as never-read', async () => {
    // Read up to the beginning and never opened at all are different answers,
    // and the client draws a different thing for each.
    store.set(callerId(), 'session', 's-zero', 0);

    const res = await request(app).get('/api/read-cursors/session/s-zero').expect(200);

    expect(res.body.cursor?.lastReadSeq).toBe(0);
  });

  it('refuses an agent presenting a real identity token', async () => {
    // Reading is refused for the same reason writing is: an agent has no read
    // state in this table, so answering `null` would invite it to write one.
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: '/agents/ana', displayName: 'Ana' });

    const res = await request(app)
      .get('/api/read-cursors/session/s-1')
      .set('X-DorkOS-Agent', token);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PEOPLE_ONLY');

    resetAgentIdentityService();
  });

  it('refuses an unknown kind rather than answering null for it', async () => {
    const res = await request(app).get('/api/read-cursors/mailbox/thing-1').expect(400);

    expect(res.body.error).toBe('Validation failed');
  });

  it('is in the OpenAPI export the app serves', async () => {
    const spec = await request(app).get('/api/openapi.json');
    const path = spec.body.paths['/api/read-cursors/{kind}/{id}'];

    expect(path?.get).toBeDefined();
    expect(path.get.tags).toEqual(['Read state']);
    expect(Object.keys(path.get.responses).sort()).toEqual(['200', '400', '403']);
  });
});
