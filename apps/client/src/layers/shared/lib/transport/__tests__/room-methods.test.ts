import { DOC_EVENT, DOC_SNAPSHOT } from './doc-channel-fixtures';
// @vitest-environment jsdom
/** The room Transport methods that can only be tested here. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RoomEvent } from '@dorkos/shared/room-schemas';

import { SSE_RESILIENCE } from '../../constants';
import { createRoomMethods, RoomStreamHttpError, isFatalStreamError } from '../room-methods';
import { installFakeStreamSocket, nthSocket } from './fake-stream-socket';

function setup() {
  return createRoomMethods('http://localhost:4242/api');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ accepted: true, entryId: 'entry-1', seq: 7 }),
    })
  );
});

/** One room entry, for the delivery cases. */
const ENTRY_EVENT: RoomEvent = {
  type: 'entry',
  seq: 4,
  entry: {
    roomId: 'room-1',
    seq: 4,
    id: 'entry-4',
    authorId: 'ana',
    kind: 'post',
    body: { text: 'line 4' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-4',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  },
};

describe('subscribeRoom over a stream socket', () => {
  beforeEach(() => {
    installFakeStreamSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens the room stream at the right path, carrying the resume cursor', async () => {
    const iterator = setup().subscribeRoom('room-1', 12)[Symbol.asyncIterator]();
    const pending = iterator.next().catch(() => undefined);
    const socket = await nthSocket();

    expect(socket.url.replace(/^ws:\/\/[^/]+/, '')).toBe('/api/rooms/room-1/events?after=12');

    socket.finish();
    await pending;
  });

  it('forwards both document notification variants independently of room entries', async () => {
    const iterator = setup().subscribeRoom('room-1', 12)[Symbol.asyncIterator]();
    const first = iterator.next();
    const socket = await nthSocket();
    socket.push('canvas_event', DOC_EVENT);
    expect((await first).value).toEqual(DOC_EVENT);
    const second = iterator.next();
    socket.push('canvas_channel_snapshot', DOC_SNAPSHOT);
    expect((await second).value).toEqual(DOC_SNAPSHOT);
    const third = iterator.next();
    socket.push('entry', ENTRY_EVENT);
    expect((await third).value).toEqual(ENTRY_EVENT);
    socket.finish();
  });

  it('hydrates the room’s canvas from the snapshot, because nothing else can', async () => {
    // The one part of a cold connect's snapshot that is NOT already in the cache: the shared
    // table rides this stream and no other route feeds it, so dropping the whole frame left a
    // cold reader looking at an empty canvas.
    const document = {
      id: 'doc-1',
      scope: 'room:room-1',
      roomId: 'room-1',
      content: { type: 'markdown', content: '# Notes' },
      title: 'Notes',
      contentType: 'markdown',
      authorId: 'author-ana',
      pinned: false,
      rev: 1,
      lastTouchedBy: 'author-ana',
      lastTouchedAt: '2026-09-11T00:00:00.000Z',
      openedAt: '2026-09-11T00:00:00.000Z',
      lastActiveAt: '2026-09-11T00:00:00.000Z',
    };
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const next = iterator.next();
    const socket = await nthSocket();

    socket.push('snapshot', {
      room: {},
      members: [],
      entries: [],
      cursor: 3,
      canvas: [document],
    });

    expect((await next).value).toEqual({ type: 'canvas', documentId: 'doc-1', document });
    socket.finish();
  });

  it('gives up on a socket that has gone silent, so the caller can reconnect', async () => {
    // A half-open socket — a slept laptop's — never closes.
    vi.useFakeTimers();
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    // The rejection handler goes on NOW, before the clock moves: advancing fake timers runs real
    // macrotasks, so a rejection with nothing attached yet would surface as an unhandled
    // rejection and fail the file.
    const failure = iterator.next().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS + 1);

    expect((await failure) as Error).toBeInstanceOf(Error);
    expect(((await failure) as Error).message).toMatch(/heard nothing for 45000ms/);
  });

  it('turns a refusal close code into a FATAL RoomStreamHttpError', async () => {
    // The distinction the retry loop turns on.
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const failure = iterator.next().catch((err: unknown) => err);
    const socket = await nthSocket();

    socket.refuse(404);

    const err = (await failure) as RoomStreamHttpError;
    expect(err).toBeInstanceOf(RoomStreamHttpError);
    expect(err.status).toBe(404);
    expect(isFatalStreamError(err), 'the loop must stop retrying this').toBe(true);
  });

  it('carries a 401 through as fatal too (signed out mid-stream)', async () => {
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const failure = iterator.next().catch((err: unknown) => err);
    const socket = await nthSocket();

    socket.refuse(401);

    expect(isFatalStreamError(await failure)).toBe(true);
  });
});

describe('saveRoomFile', () => {
  it('rejects with the server’s code and its conflict, so an editor can offer the choice', async () => {
    const conflict = {
      title: 'This file changed.',
      status: 409,
      detail: 'Somebody changed this file while you were editing it',
      code: 'file_changed',
      conflict: { path: 'docs/plan.md', commit: 'def5678', lastCommit: null },
    };
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Headers(),
      json: () => Promise.resolve(conflict),
    } as unknown as Response);

    // `message` and `code` cannot carry the commit the "keep mine" choice sends
    // back, so the parsed body rides along on the thrown error.
    await expect(
      setup().saveRoomFile('room-1', { path: 'docs/plan.md', baseCommit: 'abc1234', text: 'x' })
    ).rejects.toMatchObject({ code: 'file_changed', status: 409, body: conflict });
  });
});
