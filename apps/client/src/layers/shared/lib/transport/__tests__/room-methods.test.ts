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

  it('rejects with the server’s own sentence, so it can be shown as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'This room is archived', code: 'room_archived' }),
      })
    );
    await expect(setup().postToRoom('room-1', { text: 'anyone still here?' })).rejects.toThrow(
      'This room is archived'
    );
  });
});

describe('listRoomEntries', () => {
  /** Answer the entries route with a page and the roots it points at outside it. */
  function servePage(entries: number[], threadRoots: number[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            entries: entries.map((seq) => ({ seq, id: `entry-${seq}` })),
            threadRoots: threadRoots.map((seq) => ({ seq, id: `entry-${seq}` })),
          }),
      })
    );
  }

  it('keeps the page and the roots apart, exactly as the route sent them', async () => {
    // The room DOR-690 was filed over: every entry in the page is a reply to one message far
    // behind it.
    servePage([152, 153, 154], [1]);

    const page = await setup().listRoomEntries('room-1');

    expect(page.entries.map((entry) => entry.seq)).toEqual([152, 153, 154]);
    expect(page.threadRoots.map((root) => root.seq)).toEqual([1]);
  });
});

describe('room settings and roster writes', () => {
  it('patches one membership, escaping the author id into the path', async () => {
    await setup().updateRoomMember('room-1', 'author/1', { responseMode: 'silent' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/members/author%2F1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ responseMode: 'silent' }));
  });

  it('still rejects with the server’s own sentence when a roster write is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'Only you can change who is in a room' }),
      })
    );
    await expect(setup().removeRoomMember('room-1', 'author-1')).rejects.toThrow(
      'Only you can change who is in a room'
    );
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
  it('PUTs the file, its base commit and its text to the room’s content route', async () => {
    await setup().saveRoomFile('room-1', {
      path: 'docs/plan.md',
      baseCommit: 'abc1234',
      text: '# Plan\n',
    });
    const [url, init] = lastCall();
    // The same URL the read uses, with the file named in the BODY: a save carries its contents
    // anyway, and a query and a body cannot then disagree about which file this is.
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/files/content');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(
      JSON.stringify({ path: 'docs/plan.md', baseCommit: 'abc1234', text: '# Plan\n' })
    );
  });

  it('rejects with the server’s code and its conflict, so an editor can offer the choice', async () => {
    const conflict = {
      error: 'Somebody changed this file while you were editing it',
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

describe('the room-repo status and its repair', () => {
  it('sets up a room repo through the room’s own route', async () => {
    await setup().enableRoomRepo('room-1');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/repo');
    expect(init?.method).toBe('POST');
  });

  it('escapes a room id that would otherwise change which route is called', async () => {
    await setup().readRoomRepoStatus('a/../b');
    expect(lastCall()[0]).toBe('http://localhost:4242/api/rooms/a%2F..%2Fb/repo/status');
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
});
