/**
 * `GET /api/rooms/:id/events` — the three-part contract: snapshot on a cold
 * connect, gap-free replay from `Last-Event-ID`, then live.
 *
 * `collectDurableEvents` from `@dorkos/test-utils` is hardcoded to the session
 * path, so these drive `openSseStream` beside it — same `parseFrames`, same
 * `until` loop, plus a `ready` promise so a test can post INTO an open stream
 * without sleeping on a timer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { openSseStream, type OpenSseStream, type SseFrame } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

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
import { STREAM_EPOCH } from '../../lib/stream-cursor.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';

const app = createApp();
finalizeApp(app);

/**
 * Open one room's durable stream.
 *
 * @param port - Port the app is listening on.
 * @param roomId - Room to follow.
 * @param opts.until - Stop predicate over the frames so far.
 * @param opts.lastEventId - Sent as the `Last-Event-ID` resume header.
 * @param opts.after - Sent as the `?after=` resume query param.
 */
function openRoomStream(
  port: number,
  roomId: string,
  opts: { until: (frames: SseFrame[]) => boolean; lastEventId?: string; after?: number }
): OpenSseStream {
  const query = opts.after !== undefined ? `?after=${opts.after}` : '';
  return openSseStream(port, `/api/rooms/${roomId}/events${query}`, opts);
}

/** Start the app on an ephemeral port for one test. */
async function listen(): Promise<{ port: number; close: () => void }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  };
}

describe('GET /api/rooms/:id/events', () => {
  let db: Db;
  let roomId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createTestDb();
    setRoomService(createRoomSubsystem({ db }).service);
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Backend' });
    roomId = created.body.id;
  });

  it('404s an unknown room before any header flushes, so the client can read it', async () => {
    const res = await request(app).get('/api/rooms/nope/events');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROOM_NOT_FOUND');
  });

  it('opens a cold connect with the room, its roster and its history', async () => {
    for (const text of ['one', 'two']) {
      await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
    }

    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      until: (frames) => frames.some((f) => f.event === 'snapshot'),
    });
    const frames = await stream.frames;
    server.close();

    const snapshot = frames.find((f) => f.event === 'snapshot')?.data as {
      room: { id: string; members: unknown[] };
      entries: Array<{ seq: number; body: { text: string } }>;
      cursor: number;
    };
    expect(snapshot.room.id).toBe(roomId);
    expect(snapshot.room.members).toHaveLength(1);
    expect(snapshot.entries.map((e) => e.body.text)).toEqual(['one', 'two']);
    expect(snapshot.cursor).toBe(2);
  });

  it('delivers a post made while the stream is open, framed with a resumable id', async () => {
    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      until: (frames) => frames.some((f) => f.event === 'entry'),
    });
    await stream.ready;

    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'live one' });

    const frames = await stream.frames;
    server.close();

    const entry = frames.find((f) => f.event === 'entry');
    expect(entry?.id).toBe(`${roomId}-${STREAM_EPOCH}-1`);
    expect((entry?.data as { entry: { body: { text: string } } }).entry.body.text).toBe('live one');
  });

  it('replays only the gap on a Last-Event-ID resume, with no snapshot', async () => {
    for (const text of ['one', 'two', 'three']) {
      await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
    }

    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      lastEventId: `${roomId}-${STREAM_EPOCH}-1`,
      until: (frames) => frames.filter((f) => f.event === 'entry').length >= 2,
    });
    const frames = await stream.frames;
    server.close();

    expect(frames.some((f) => f.event === 'snapshot')).toBe(false);
    expect(frames.map((f) => f.id)).toEqual([
      `${roomId}-${STREAM_EPOCH}-2`,
      `${roomId}-${STREAM_EPOCH}-3`,
    ]);
  });

  it('replays from ?after= too', async () => {
    for (const text of ['one', 'two']) {
      await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
    }

    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      after: 1,
      until: (frames) => frames.some((f) => f.event === 'entry'),
    });
    const frames = await stream.frames;
    server.close();

    expect(frames.some((f) => f.event === 'snapshot')).toBe(false);
    expect(frames.map((f) => f.id)).toEqual([`${roomId}-${STREAM_EPOCH}-2`]);
  });

  it('treats a cursor from a dead process as a cold connect rather than mis-replaying', async () => {
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'one' });

    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      // A cursor minted by a previous process: same shape, foreign epoch.
      lastEventId: `${roomId}-${STREAM_EPOCH - 1}-1`,
      until: (frames) => frames.some((f) => f.event === 'snapshot'),
    });
    const frames = await stream.frames;
    server.close();

    expect(frames.some((f) => f.event === 'snapshot')).toBe(true);
  });

  it('goes straight to live with no gap when the replay is already current', async () => {
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'one' });

    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      lastEventId: `${roomId}-${STREAM_EPOCH}-1`,
      until: (frames) => frames.some((f) => f.event === 'entry'),
    });
    await stream.ready;
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'two' });

    const frames = await stream.frames;
    server.close();

    // Exactly one entry: the gap was empty, and seq 1 is not re-sent.
    const entries = frames.filter((f) => f.event === 'entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(`${roomId}-${STREAM_EPOCH}-2`);
  });

  it('sets the headers that keep a long-lived stream from being buffered', async () => {
    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      until: (frames) => frames.some((f) => f.event === 'snapshot'),
    });
    expect(await stream.status).toBe(200);
    await stream.frames;
    server.close();
  });

  it('delivers an ephemeral signal live, with no id line and no log entry', async () => {
    const { getRoomService } = await import('../../services/rooms/index.js');
    const server = await listen();
    const stream = openRoomStream(server.port, roomId, {
      until: (frames) => frames.some((f) => f.event === 'signal'),
    });
    await stream.ready;

    const author = getRoomService().authorRegistry.localHuman().id;
    getRoomService().publishSignal(roomId, 'typing', author);

    const frames = await stream.frames;
    server.close();

    const signal = frames.find((f) => f.event === 'signal');
    expect(signal?.id).toBeUndefined();
    expect((signal?.data as { signal: string }).signal).toBe('typing');

    // Nothing ephemeral reached the durable log, so nothing replays it.
    const entries = await request(app).get(`/api/rooms/${roomId}/entries`);
    expect(entries.body.entries).toHaveLength(0);
  });

  it('carries the whole working lifecycle live, and never replays it', async () => {
    // Presence is a `progress` signal with a payload, and it rides the SAME
    // ephemeral framing typing does — no `id:` line, no `seq`, not in the log.
    // That is what makes it impossible for a replay to resurrect an indicator
    // for work that finished while the client was away: there is nothing to
    // resurrect. The republish loop repaints the ones that are still true.
    const { getRoomService } = await import('../../services/rooms/index.js');
    const first = await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'one' });

    const server = await listen();
    const live = openRoomStream(server.port, roomId, {
      until: (frames) => frames.some((f) => f.event === 'signal'),
    });
    await live.ready;

    const author = getRoomService().authorRegistry.localHuman().id;
    getRoomService().publishSignal(roomId, 'progress', author, {
      state: 'working',
      entryId: first.body.entryId,
      since: '2026-07-30T04:00:00.000Z',
    });

    const signal = (await live.frames).find((f) => f.event === 'signal');
    // Every field a client needs to render "Ana is working on it · 42s" from
    // this one event, having connected after the work began.
    expect(signal?.id).toBeUndefined();
    expect(signal?.data).toMatchObject({
      signal: 'progress',
      authorId: author,
      state: 'working',
      entryId: first.body.entryId,
      since: '2026-07-30T04:00:00.000Z',
    });

    // A second entry, then a resume from before the signal: the gap comes off
    // the durable log, which never held it.
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'two' });
    const resumed = openRoomStream(server.port, roomId, {
      lastEventId: `${roomId}-${STREAM_EPOCH}-1`,
      until: (frames) => frames.some((f) => f.event === 'entry'),
    });
    const replayed = await resumed.frames;
    server.close();

    expect(replayed.some((f) => f.event === 'signal')).toBe(false);
    expect(replayed.map((f) => f.id)).toEqual([`${roomId}-${STREAM_EPOCH}-2`]);
  });

  it('ignores an out-of-range ?after= instead of going deaf for the connection', async () => {
    const server = await listen();
    // A cursor past the end used to set the live-dedupe watermark above every
    // seq this room will ever issue, silently suppressing every entry for the
    // life of the connection. Past the end is a cold connect, not a resume.
    const stream = openRoomStream(server.port, roomId, {
      after: 99_999,
      until: (frames) => frames.some((f) => f.event === 'entry'),
    });
    await stream.ready;
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'still delivered' });

    const frames = await stream.frames;
    server.close();

    expect(frames.some((f) => f.event === 'snapshot')).toBe(true);
    expect(frames.find((f) => f.event === 'entry')?.id).toBe(`${roomId}-${STREAM_EPOCH}-1`);
  });

  it('refuses a cursor minted for a different room', async () => {
    const other = await request(app).post('/api/rooms').send({ kind: 'channel', title: 'Other' });
    for (const text of ['one', 'two']) {
      await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
    }

    const server = await listen();
    // Room seqs are per-room and durable, so another room's cursor is a
    // plausible number that would silently skip real entries here.
    const stream = openRoomStream(server.port, roomId, {
      lastEventId: `${other.body.id}-${STREAM_EPOCH}-1`,
      until: (frames) => frames.some((f) => f.event === 'snapshot'),
    });
    const frames = await stream.frames;
    server.close();

    const snapshot = frames.find((f) => f.event === 'snapshot')?.data as {
      entries: Array<{ seq: number }>;
    };
    expect(snapshot.entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('404s the stream for an agent that is not a member', async () => {
    const { initAgentIdentityService, resetAgentIdentityService } =
      await import('../../services/core/agent-identity/agent-identity-service.js');
    resetAgentIdentityService();
    const token = await initAgentIdentityService(db).mint({
      agentPath: '/agents/outsider',
      displayName: 'Outsider',
    });

    const res = await request(app).get(`/api/rooms/${roomId}/events`).set('X-DorkOS-Agent', token);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROOM_NOT_FOUND');
    resetAgentIdentityService();
  });
});

describe('PUT /api/read-cursors/room/:id on the global stream', () => {
  let roomId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Both halves of the same subsystem: the rooms service the generic route
    // delegates a room write into, and the read-cursor service it reads the
    // stored cursor back from. Built as one so the route provably writes the
    // table the room list reads — wiring them separately is how a test would
    // "pass" against two databases.
    const rooms = createRoomSubsystem({ db: createTestDb() });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Backend' });
    roomId = created.body.id;
  });

  it('announces a cursor once, and says nothing the second time', async () => {
    // The whole point of the event is a SECOND device, so the proof has to be a
    // real reader on `/api/events` rather than a spy on the broadcaster: the
    // route, the fan-out and the SSE encoding are all between the write and the
    // other screen, and a service-level assertion sees none of them.
    const { getRoomService } = await import('../../services/rooms/index.js');
    for (const text of ['one', 'two', 'three']) {
      await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
    }

    const server = await listen();
    // Stop on the sentinel post at the end rather than on the cursor event
    // itself. Absence is never the condition: waiting for the thing that happens
    // INSTEAD is what makes "and then nothing" provable, where a timer would
    // only prove the test was patient.
    const stream = openSseStream(server.port, '/api/events', {
      until: (frames) => frames.some((f) => f.event === 'room_activity'),
    });
    await stream.ready;

    await request(app).put(`/api/read-cursors/room/${roomId}`).send({ lastReadSeq: 3 }).expect(200);
    // The same cursor again: monotonic, so it writes nothing and must therefore
    // say nothing. Opening a room already read is the common case, and an event
    // per no-op would be the loudest name on this stream.
    await request(app).put(`/api/read-cursors/room/${roomId}`).send({ lastReadSeq: 3 }).expect(200);
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'sentinel' });

    const frames = await stream.frames;
    server.close();

    const cursors = frames.filter((f) => f.event === 'read_cursor');
    expect(cursors).toHaveLength(1);
    // One read-state system with one write path (team-room-home §D4): a room is
    // `threadKind: 'room'` and not an endpoint of its own. The unread count
    // rides along because the sidebar cannot work it out from a cursor.
    expect(cursors[0].data).toEqual({
      userId: getRoomService().authorRegistry.localHuman().id,
      threadKind: 'room',
      threadId: roomId,
      lastReadSeq: 3,
      unreadCount: 0,
    });
  });

  it('leaves one cursor behind, with the room-shaped URL gone', async () => {
    // The migration's closing condition. There used to be a second URL
    // (`PUT /api/rooms/:id/read-cursor`) onto this same write, kept while
    // clients moved; it is removed, and the proof has to be both halves — the
    // old URL 404s AND the surviving one still lands where the room list reads.
    // Asserting only the 404 would pass against a route that stopped working.
    const { getRoomService } = await import('../../services/rooms/index.js');
    const me = getRoomService().authorRegistry.localHuman().id;
    for (const text of ['one', 'two', 'three']) {
      await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
    }

    await request(app).put(`/api/rooms/${roomId}/read-cursor`).send({ lastReadSeq: 1 }).expect(404);

    const server = await listen();
    const stream = openSseStream(server.port, '/api/events', {
      until: (frames) => frames.some((f) => f.event === 'room_activity'),
    });
    await stream.ready;

    await request(app).put(`/api/read-cursors/room/${roomId}`).send({ lastReadSeq: 2 }).expect(200);
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'sentinel' });

    const frames = await stream.frames;
    server.close();

    // `unreadCount` included, because the generic route delegates room writes
    // into `RoomService` rather than dropping a bare number on the table. The
    // countless variant would be exactly the bug: an event the room list has
    // nothing to patch with, leaving the badge lit on the reader's other device.
    const cursors = frames.filter((f) => f.event === 'read_cursor');
    expect(cursors.map((f) => f.data)).toEqual([
      { userId: me, threadKind: 'room', threadId: roomId, lastReadSeq: 2, unreadCount: 1 },
    ]);

    // One stored cursor, read back through the ROOM's own vocabulary: the
    // membership the room detail reports carries what the cursor table holds.
    const room = await request(app).get(`/api/rooms/${roomId}`).expect(200);
    expect(room.body.members.find((m: { authorId: string }) => m.authorId === me).lastReadSeq).toBe(
      2
    );
  });

  it('refuses a room the caller is not in', async () => {
    // The delegation is what buys this: without it the generic route would
    // happily store a cursor for a room this caller cannot see, and answer 200.
    // 404 rather than 403 because it is the rooms domain answering, in the words
    // the rest of the room surface uses.
    const res = await request(app)
      .put('/api/read-cursors/room/01JQZZZZZZZZZZZZZZZZZZZZZZ')
      .send({ lastReadSeq: 1 })
      .expect(404);

    expect(res.body.code).toBe('ROOM_NOT_FOUND');
  });
});
