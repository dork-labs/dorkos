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
 * `subscribeRoom`'s silence watchdog — it exists at this level precisely
 * because the server's heartbeat is an SSE comment that this method drops, so
 * no consumer above it can tell a dead socket from a quiet room. A test above
 * the seam cannot see the heartbeat either.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RoomEvent } from '@dorkos/shared/room-schemas';
import { SSE_RESILIENCE } from '../../constants';
import { createRoomMethods } from '../room-methods';

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

/**
 * A live SSE response whose body is fed by hand, the way a real one is fed by
 * the network — including erroring the body when the request aborts, which is
 * what turns an abort into a thrown iteration rather than a hang.
 */
function openStream() {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  const push = (chunk: string) => source.enqueue(new TextEncoder().encode(chunk));
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    init.signal?.addEventListener(
      'abort',
      () => source.error(new DOMException('The operation was aborted.', 'AbortError')),
      { once: true }
    );
    return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
  });
  return { push, fetchMock };
}

/** Watch a promise without waiting on it (and without an unhandled rejection). */
function watch(promise: Promise<unknown>): () => 'pending' | 'settled' {
  let state: 'pending' | 'settled' = 'pending';
  const mark = () => {
    state = 'settled';
  };
  void promise.then(mark, mark);
  return () => state;
}

describe('subscribeRoom silence watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a socket that has gone silent, so the caller can reconnect', async () => {
    vi.useFakeTimers();
    const { push, fetchMock } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    // The rejection handler goes on NOW, before the clock moves: advancing
    // fake timers runs real macrotasks, so a rejection with nothing attached
    // yet would surface as an unhandled rejection and fail the file.
    const failure = iterator.next().catch((err: unknown) => err);

    // Let the fetch resolve and the reader start, then send the server's
    // connect comment — after which this socket says nothing ever again.
    await vi.advanceTimersByTimeAsync(0);
    push(': connected\n\n');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.HEARTBEAT_TIMEOUT_MS + 1);

    expect((await failure) as Error).toBeInstanceOf(Error);
    expect(((await failure) as Error).message).toMatch(/heard nothing for 45000ms/);
  });

  it('counts the keepalive comment as a sign of life', async () => {
    vi.useFakeTimers();
    const { push, fetchMock } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const next = iterator.next();
    const outcome = watch(next);
    await vi.advanceTimersByTimeAsync(0);

    // Three heartbeats at 30s — well past the 45s timeout in total, never
    // more than 30s apart. A room can be silent for hours and still be alive;
    // only the SERVER going quiet counts, and only this level can see it.
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      push(': keepalive\n\n');
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(outcome()).toBe('pending');
  });

  it('still delivers entries, and keeps the watchdog fed with them', async () => {
    vi.useFakeTimers();
    const { push, fetchMock } = openStream();
    vi.stubGlobal('fetch', fetchMock);

    const iterator = setup().subscribeRoom('room-1')[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.advanceTimersByTimeAsync(0);

    const event: RoomEvent = {
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
        signature: null,
        createdAt: '2026-07-26T10:00:00.000Z',
      },
    };
    push(`event: entry\ndata: ${JSON.stringify(event)}\n\n`);
    await vi.advanceTimersByTimeAsync(0);

    expect((await next).value).toEqual(event);
  });
});
