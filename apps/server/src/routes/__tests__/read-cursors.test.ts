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
      .put('/api/read-cursors/room/room-1')
      .send({ lastReadSeq: 4 })
      .expect(200);

    expect(res.body).toEqual({
      userId: callerId(),
      threadKind: 'room',
      threadId: 'room-1',
      lastReadSeq: 4,
      updatedAt: expect.any(String),
    });
    expect(store.get(callerId(), 'room', 'room-1')?.lastReadSeq).toBe(4);
  });

  it('announces the write once, and says nothing when the same value is written again', async () => {
    const server = await listen();
    const stream = openSseStream(server.port, '/api/events', { until: stopsOnRoomActivity });
    await stream.ready;

    await request(app).put('/api/read-cursors/room/room-1').send({ lastReadSeq: 4 }).expect(200);
    // The same seq again: monotonic, so it writes nothing and must therefore say
    // nothing. Re-opening a thread already read is the common case, and an event
    // per no-op would be the loudest name on this stream.
    await request(app).put('/api/read-cursors/room/room-1').send({ lastReadSeq: 4 }).expect(200);
    await sentinel();

    const frames = await stream.frames;
    server.close();

    const cursors = frames.filter((f) => f.event === 'read_cursor');
    expect(cursors).toHaveLength(1);
    expect(cursors[0].data).toEqual({
      userId: callerId(),
      threadKind: 'room',
      threadId: 'room-1',
      lastReadSeq: 4,
    });
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
    for (const kind of ['room', 'session', 'inbox']) {
      await request(app)
        .put(`/api/read-cursors/${kind}/thing-1`)
        .send({ lastReadSeq: 3 })
        .expect(200);
    }

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
    expect(Object.keys(path.put.responses).sort()).toEqual(['200', '400', '403']);
    expect(
      path.put.description,
      'the refusal a client will actually hit has to be documented, not only returned'
    ).toContain('PEOPLE_ONLY');
  });
});
