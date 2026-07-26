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
 * Open the room stream against a listening server and collect frames until
 * `until` is satisfied.
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

  const path = `/api/rooms/${roomId}/events${opts.after !== undefined ? `?after=${opts.after}` : ''}`;
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
