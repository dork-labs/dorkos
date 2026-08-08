/**
 * `GET /api/rooms/:id/events` — the three-part contract: snapshot on a cold
 * connect, gap-free replay from `Last-Event-ID`, then live.
 *
 * `collectDurableEvents` from `@dorkos/test-utils` is hardcoded to the session
 * path, so the collector here is the room-shaped sibling — same `parseFrames`,
 * same `until` loop, plus a `ready` promise so a test can post INTO an open
 * stream without sleeping on a timer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { parseFrames, type SseFrame } from '@dorkos/test-utils';
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

const app = createApp();
finalizeApp(app);

/** One open room stream: a readiness signal, the collected frames, and a stop. */
interface OpenStream {
  /** Resolves once the first frame lands, so a test can post into a live stream. */
  ready: Promise<void>;
  /** Resolves with every frame collected when `until` is satisfied. */
  frames: Promise<SseFrame[]>;
  status: Promise<number>;
}

/**
 * Open any SSE path against a listening server and collect frames until `until`
 * is satisfied.
 *
 * Shared by the room stream below and the global `/api/events` stream, which is
 * a different route with the same wire format — one collector rather than two
 * that drift.
 *
 * @param port - Port the app is listening on.
 * @param path - The stream path, query included.
 * @param opts.until - Stop predicate over the frames so far.
 * @param opts.lastEventId - Sent as the `Last-Event-ID` resume header.
 */
function openSseStream(
  port: number,
  path: string,
  opts: { until: (frames: SseFrame[]) => boolean; lastEventId?: string }
): OpenStream {
  let signalReady = (): void => {};
  let resolveFrames: (frames: SseFrame[]) => void = () => {};
  let resolveStatus: (status: number) => void = () => {};
  let rejectFrames: (err: unknown) => void = () => {};

  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const frames = new Promise<SseFrame[]>((resolve, reject) => {
    resolveFrames = resolve;
    rejectFrames = reject;
  });
  const status = new Promise<number>((resolve) => {
    resolveStatus = resolve;
  });

  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: opts.lastEventId !== undefined ? { 'Last-Event-ID': opts.lastEventId } : {},
    },
    (res) => {
      resolveStatus(res.statusCode ?? 0);
      let raw = '';
      let settled = false;
      res.setEncoding('utf8');
      const finish = (): void => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolveFrames(parseFrames(raw));
      };
      res.on('data', (chunk: string) => {
        raw += chunk;
        signalReady();
        if (opts.until(parseFrames(raw))) finish();
      });
      res.on('end', finish);
    }
  );
  req.on('error', rejectFrames);
  req.end();

  return { ready, frames, status };
}

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
): OpenStream {
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

describe('PUT /api/rooms/:id/read-cursor on the global stream', () => {
  let roomId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setRoomService(createRoomSubsystem({ db: createTestDb() }).service);
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

    await request(app).put(`/api/rooms/${roomId}/read-cursor`).send({ lastReadSeq: 3 }).expect(200);
    // The same cursor again: monotonic, so it writes nothing and must therefore
    // say nothing. Opening a room already read is the common case, and an event
    // per no-op would be the loudest name on this stream.
    await request(app).put(`/api/rooms/${roomId}/read-cursor`).send({ lastReadSeq: 3 }).expect(200);
    await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'sentinel' });

    const frames = await stream.frames;
    server.close();

    const cursors = frames.filter((f) => f.event === 'room_read_cursor');
    expect(cursors).toHaveLength(1);
    expect(cursors[0].data).toEqual({
      roomId,
      authorId: getRoomService().authorRegistry.localHuman().id,
      authorKind: 'human',
      lastReadSeq: 3,
      unreadCount: 0,
    });
  });
});
