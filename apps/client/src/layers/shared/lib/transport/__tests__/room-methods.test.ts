// @vitest-environment jsdom
/**
 * The room Transport methods that can only be tested here.
 *
 * `postToRoom` and the settings / roster writes — their URL and method are the
 * whole contract with `/api/rooms/*`, and a typo in either fails only at
 * runtime, where the mock Transport every component test uses cannot see it.
 * `removeRoomMember` additionally has to survive a `204 No Content`, which is
 * invisible above this seam.
 *
 * `subscribeRoom`'s two pieces of resilience, both of which exist at this level
 * precisely because nothing above it can see them: the silence watchdog (the
 * server's heartbeat is consumed here, so above this seam a dead socket and a
 * quiet room look identical) and the refusal status (a browser cannot read the
 * status of a failed WebSocket handshake, so the server sends an application
 * close code and this is where it becomes a `RoomStreamHttpError`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RoomEvent } from '@dorkos/shared/room-schemas';
import { STREAM_HEARTBEAT_EVENT } from '@dorkos/shared/stream-socket';
import { SSE_RESILIENCE } from '../../constants';
import { createRoomMethods, RoomStreamHttpError, isFatalStreamError } from '../room-methods';
import { installFakeStreamSocket, nthSocket } from './fake-stream-socket';

function setup() {
  return createRoomMethods('http://localhost:4242/api');
}

/** The URL and `RequestInit` the last `fetch` call was made with. */
function lastCall(): [string, RequestInit] {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
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

describe('postToRoom', () => {
  it('posts the message to the room it names', async () => {
    await setup().postToRoom('room-1', { text: 'ship it' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/entries');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ text: 'ship it' }));
  });

  it('returns the accepted entry’s identity, not the entry', async () => {
    const accepted = await setup().postToRoom('room-1', { text: 'ship it' });
    expect(accepted).toEqual({ accepted: true, entryId: 'entry-1', seq: 7 });
  });

  it('rejects with the server’s own sentence, so it can be shown as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: () => Promise.resolve({ error: 'This room is archived', code: 'ROOM_ARCHIVED' }),
      })
    );
    await expect(setup().postToRoom('room-1', { text: 'anyone still here?' })).rejects.toThrow(
      'This room is archived'
    );
  });
});

describe('room settings and roster writes', () => {
  it('patches a room in place', async () => {
    await setup().updateRoom('room-1', { title: 'Backend' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ title: 'Backend' }));
  });

  it('patches one membership, escaping the author id into the path', async () => {
    await setup().updateRoomMember('room-1', 'author/1', { responseMode: 'silent' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/members/author%2F1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ responseMode: 'silent' }));
  });

  it('deletes a membership and reads no body back', async () => {
    // The route answers 204. `fetchJSON` would call `res.json()` on an empty
    // body and reject with a parse error on a request that in fact succeeded,
    // so this path must not touch the body at all — the mock has no `json`.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }));

    await expect(setup().removeRoomMember('room-1', 'author-1')).resolves.toBeUndefined();
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/members/author-1');
    expect(init.method).toBe('DELETE');
  });

  it('still rejects with the server’s own sentence when a roster write is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: () => Promise.resolve({ error: 'Only you can change who is in a room' }),
      })
    );
    await expect(setup().removeRoomMember('room-1', 'author-1')).rejects.toThrow(
      'Only you can change who is in a room'
    );
  });
});

/** Watch a promise without waiting on it (and without an unhandled rejection). */
function watch(promise: Promise<unknown>): () => 'pending' | 'settled' {
  let state: 'pending' | 'settled' = 'pending';
  const mark = () => {
    state = 'settled';
  };
  void promise.then(mark, mark);
  return () => state;
}

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

  it('delivers a validated entry', async () => {
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const next = iterator.next();
    const socket = await nthSocket();

    socket.push('entry', ENTRY_EVENT);

    expect((await next).value).toEqual(ENTRY_EVENT);
    socket.finish();
  });

  it('skips the snapshot frame — the cache already holds that history', async () => {
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const next = iterator.next();
    const socket = await nthSocket();

    socket.push('snapshot', { room: {}, members: [], entries: [], cursor: 3 });
    socket.push('entry', ENTRY_EVENT);

    expect((await next).value).toEqual(ENTRY_EVENT);
    socket.finish();
  });

  it('gives up on a socket that has gone silent, so the caller can reconnect', async () => {
    // A half-open socket — a slept laptop's — never closes. The server's
    // heartbeat is consumed below this seam, so up here silence and a quiet
    // room look identical; only this level can tell them apart.
    vi.useFakeTimers();
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    // The rejection handler goes on NOW, before the clock moves: advancing fake
    // timers runs real macrotasks, so a rejection with nothing attached yet
    // would surface as an unhandled rejection and fail the file.
    const failure = iterator.next().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS + 1);

    expect((await failure) as Error).toBeInstanceOf(Error);
    expect(((await failure) as Error).message).toMatch(/heard nothing for 45000ms/);
  });

  it('counts a heartbeat frame as a sign of life', async () => {
    vi.useFakeTimers();
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const outcome = watch(iterator.next());
    await vi.advanceTimersByTimeAsync(0);
    const socket = await nthSocket();

    // Three heartbeats at 30s — well past the 45s timeout in total, never more
    // than 30s apart. A room can be silent for hours and still be alive; only
    // the SERVER going quiet counts.
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      socket.push(STREAM_HEARTBEAT_EVENT);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(outcome()).toBe('pending');
  });

  it('turns a refusal close code into a FATAL RoomStreamHttpError', async () => {
    // The distinction the retry loop turns on. A browser cannot read the status
    // of a failed WebSocket handshake, so the server refuses with an application
    // close code — and losing that here would make "this room is not yours"
    // retry forever behind a "reconnecting" notice that never comes true.
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const failure = iterator.next().catch((err: unknown) => err);
    const socket = await nthSocket();

    socket.refuse(404);

    const err = (await failure) as RoomStreamHttpError;
    expect(err).toBeInstanceOf(RoomStreamHttpError);
    expect(err.status).toBe(404);
    expect(isFatalStreamError(err), 'the loop must stop retrying this').toBe(true);
  });

  it('treats an ordinary drop as RETRYABLE, not fatal', async () => {
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const failure = iterator.next().catch((err: unknown) => err);
    const socket = await nthSocket();

    socket.drop();

    const err = (await failure) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(isFatalStreamError(err), 'a dropped socket must keep retrying').toBe(false);
  });

  it('carries a 401 through as fatal too (signed out mid-stream)', async () => {
    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const failure = iterator.next().catch((err: unknown) => err);
    const socket = await nthSocket();

    socket.refuse(401);

    expect(isFatalStreamError(await failure)).toBe(true);
  });

  it('does not throw when the CALLER aborted — that is not a failure', async () => {
    const controller = new AbortController();
    const iterator = setup()
      .subscribeRoom('room-1', undefined, controller.signal)
      [Symbol.asyncIterator]();
    const settled = iterator.next().then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e })
    );
    await nthSocket();

    controller.abort();

    const outcome = await settled;
    expect(outcome.ok, 'an abort completes the iteration rather than erroring it').toBe(true);
  });
});

describe('saveRoomFile', () => {
  it('PUTs the file, its base commit and its text to the room’s content route', async () => {
    await setup().saveRoomFile('room-1', {
      path: 'docs/plan.md',
      baseCommit: 'abc1234',
      text: '# Plan\n',
    });
    const [url, init] = lastCall();
    // The same URL the read uses, with the file named in the BODY: a save
    // carries its contents anyway, and a query and a body cannot then disagree
    // about which file this is.
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/files/content');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(
      JSON.stringify({ path: 'docs/plan.md', baseCommit: 'abc1234', text: '# Plan\n' })
    );
  });

  it('rejects with the server’s code and its conflict, so an editor can offer the choice', async () => {
    const conflict = {
      error: 'Somebody changed this file while you were editing it',
      code: 'FILE_CHANGED',
      conflict: { path: 'docs/plan.md', commit: 'def5678', lastCommit: null },
    };
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve(conflict),
    } as unknown as Response);

    // `message` and `code` cannot carry the commit the "keep mine" choice sends
    // back, so the parsed body rides along on the thrown error.
    await expect(
      setup().saveRoomFile('room-1', { path: 'docs/plan.md', baseCommit: 'abc1234', text: 'x' })
    ).rejects.toMatchObject({ code: 'FILE_CHANGED', status: 409, body: conflict });
  });
});

describe('the room-repo status and its repair', () => {
  it('reads the status from the room’s own repo route', async () => {
    await setup().readRoomRepoStatus('room-1');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/repo/status');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('sends a keep with no list and a discard with exactly the names it was given', async () => {
    const rooms = setup();

    await rooms.repairRoomMain('room-1', { action: 'commit' });
    const [keepUrl, keepInit] = lastCall();
    expect(keepUrl).toBe('http://localhost:4242/api/rooms/room-1/repo/main/repair');
    expect(keepInit.method).toBe('POST');
    // Keeping loses nothing, so it sweeps up whatever is there and takes no
    // list; discarding is irreversible, so it destroys nothing it was not
    // handed by name. The asymmetry is the safety rule, and it is on the wire.
    expect(keepInit.body).toBe(JSON.stringify({ action: 'commit' }));

    await rooms.repairRoomMain('room-1', { action: 'discard', paths: ['ROOM.md', 'a/b.md'] });
    const [, discardInit] = lastCall();
    expect(discardInit.body).toBe(
      JSON.stringify({ action: 'discard', paths: ['ROOM.md', 'a/b.md'] })
    );
  });

  it('escapes a room id that would otherwise change which route is called', async () => {
    await setup().readRoomRepoStatus('a/../b');
    expect(lastCall()[0]).toBe('http://localhost:4242/api/rooms/a%2F..%2Fb/repo/status');
  });
});
