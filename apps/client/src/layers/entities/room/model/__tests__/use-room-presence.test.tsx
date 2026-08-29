// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEvent, RoomSignalEvent } from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { SSE_RESILIENCE } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomStream } from '../use-room-stream';
import {
  PRESENCE_TICK_MS,
  PRESENCE_TTL_MS,
  useRoomHolds,
  useRoomPresence,
  useRoomPresenceClaims,
  useRoomPresenceStore,
} from '../use-room-presence';

const ROOM = 'room-1';

/** A presence publish, shaped exactly as the dispatcher puts it on the wire. */
function signal(
  authorId: string,
  state: 'working' | 'working_late' | 'done',
  entryId: string,
  since = '2026-07-30T10:00:00.000Z',
  activity?: SessionActivity
): RoomSignalEvent {
  return {
    type: 'signal',
    signal: 'progress',
    authorId,
    at: since,
    state,
    entryId,
    since,
    ...(activity ? { activity } : {}),
  };
}

/** A `held` publish — this room's message waiting on a turn somewhere else. */
function heldSignal(
  authorId: string,
  entryId: string,
  behindRoomId = 'room-elsewhere',
  since = '2026-07-30T10:00:00.000Z',
  othersWaiting = false
): RoomSignalEvent {
  return {
    type: 'signal',
    signal: 'progress',
    authorId,
    at: since,
    state: 'held',
    entryId,
    since,
    heldBehind: { roomId: behindRoomId, othersWaiting },
  };
}

/** A committed entry, as the room's stream delivers it. */
function entry(seq: number, authorId: string): RoomEntry {
  return {
    roomId: ROOM,
    seq,
    id: `entry-${seq}`,
    authorId,
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T10:00:00.000Z',
  };
}

/** The store's own indicator key, so a test never spells the separator itself. */
function key(authorId: string, entryId: string): string {
  return `${authorId}\u0000${entryId}`;
}

/** The store's view of one room, as a sorted list of `(author, entry)` keys. */
function keysIn(roomId: string): string[] {
  return Object.keys(useRoomPresenceStore.getState().rooms[roomId] ?? {}).sort();
}

beforeEach(() => {
  useRoomPresenceStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the presence store', () => {
  it('keys an indicator on (author, entry), so one agent can be on two things', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-1', '2026-07-30T10:00:00.000Z'));
    store.observe(ROOM, signal('kai', 'working', 'entry-2', '2026-07-30T10:00:05.000Z'));
    store.observe(ROOM, signal('ana', 'working', 'entry-1', '2026-07-30T10:00:01.000Z'));

    expect(keysIn(ROOM)).toEqual([
      key('ana', 'entry-1'),
      key('kai', 'entry-1'),
      key('kai', 'entry-2'),
    ]);
  });

  it('ignores a signal with no lifecycle on it — a `typing` is not an indicator', () => {
    useRoomPresenceStore
      .getState()
      .observe(ROOM, { type: 'signal', signal: 'typing', authorId: 'kai', at: 'now' });

    expect(keysIn(ROOM)).toEqual([]);
  });

  it('ignores a `progress` that is missing its key — a partial payload is not an indicator', () => {
    // The community port makes `entryId` and `since` optional on its presence
    // payload, so a backend that can only say "somebody is working" produces
    // exactly this frame, and `RoomService.publishSignal` accepts it. The client
    // is where that stops: an indicator with no `entryId` cannot be keyed and
    // one with no `since` cannot be aged, so a stored partial would show a
    // worker that no `done` could ever address and no TTL could sensibly clear.
    const store = useRoomPresenceStore.getState();

    store.observe(ROOM, {
      type: 'signal',
      signal: 'progress',
      authorId: 'kai',
      at: '2026-07-30T10:00:00.000Z',
      state: 'working',
    });
    store.observe(ROOM, {
      type: 'signal',
      signal: 'progress',
      authorId: 'kai',
      at: '2026-07-30T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-1',
    });

    expect(keysIn(ROOM)).toEqual([]);
  });

  it('deletes only the claim a `done` names', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-1'));
    store.observe(ROOM, signal('kai', 'working', 'entry-2'));

    store.observe(ROOM, signal('kai', 'done', 'entry-1'));

    // The other claim is still true, and a `done` that cleared both would have
    // stranded the room with no indicator for work that is still running.
    expect(keysIn(ROOM)).toEqual([key('kai', 'entry-2')]);
  });

  it('drops every one of an author’s claims when that author posts', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-1'));
    store.observe(ROOM, signal('kai', 'working_late', 'entry-2'));
    store.observe(ROOM, signal('ana', 'working', 'entry-3'));

    store.clearAuthor(ROOM, 'kai');

    expect(keysIn(ROOM)).toEqual([key('ana', 'entry-3')]);
  });

  it('forgets a whole room at once', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-1'));
    store.observe('room-2', signal('ana', 'working', 'entry-9'));

    store.clearRoom(ROOM);

    expect(keysIn(ROOM)).toEqual([]);
    expect(keysIn('room-2')).toEqual([key('ana', 'entry-9')]);
  });

  it('prunes what nothing has restated, and keeps what has', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-1'), 1_000);
    store.observe(ROOM, signal('ana', 'working', 'entry-2'), 1_000);
    // Ana's claim was republished; Kai's was not.
    store.observe(ROOM, signal('ana', 'working', 'entry-2'), 1_000 + PRESENCE_TTL_MS - 1);

    store.prune(1_000 + PRESENCE_TTL_MS);

    expect(keysIn(ROOM)).toEqual([key('ana', 'entry-2')]);
  });
});

describe('useRoomPresence', () => {
  it('shows one row per agent, at its older claim, oldest agent first', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-2', '2026-07-30T10:00:30.000Z'));
    store.observe(ROOM, signal('kai', 'working_late', 'entry-1', '2026-07-30T10:00:00.000Z'));
    store.observe(ROOM, signal('ana', 'working', 'entry-3', '2026-07-30T10:00:10.000Z'));

    const { result } = renderHook(() => useRoomPresence(ROOM));

    // Two claims for Kai, one name — and the state that carries is the OLDER
    // claim's, which is the one that has been running long enough to be late.
    expect(result.current.map((agent) => [agent.authorId, agent.state, agent.since])).toEqual([
      ['kai', 'working_late', '2026-07-30T10:00:00.000Z'],
      ['ana', 'working', '2026-07-30T10:00:10.000Z'],
    ]);
  });

  it('carries the OLDEST claim’s reading onto the row that speaks for the agent', () => {
    // The collapse to one row has already chosen which claim speaks for Kai, so
    // reading the newer claim's tool onto that row would describe one turn with
    // another turn's work — exactly the inconsistency `entryId` is carried for.
    const store = useRoomPresenceStore.getState();
    store.observe(
      ROOM,
      signal('kai', 'working', 'entry-2', '2026-07-30T10:00:30.000Z', {
        toolName: 'Bash',
        target: 'pnpm test',
      })
    );
    store.observe(
      ROOM,
      signal('kai', 'working', 'entry-1', '2026-07-30T10:00:00.000Z', {
        toolName: 'Read',
        target: 'standup.md',
      })
    );

    const { result } = renderHook(() => useRoomPresence(ROOM));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.entryId).toBe('entry-1');
    expect(result.current[0]!.activity).toEqual({ toolName: 'Read', target: 'standup.md' });
  });

  it('lets a frame with no reading clear one that had it', () => {
    // Every publish is self-contained, so the last frame is the whole truth
    // about a claim. Merging instead would leave a verb standing after the turn
    // that was doing it stopped — the stale-verb bug in its client half.
    const store = useRoomPresenceStore.getState();
    store.observe(
      ROOM,
      signal('kai', 'working', 'entry-1', '2026-07-30T10:00:00.000Z', {
        toolName: 'Read',
        target: 'standup.md',
      })
    );
    store.observe(ROOM, signal('kai', 'working', 'entry-1', '2026-07-30T10:00:00.000Z'));

    const { result } = renderHook(() => useRoomPresence(ROOM));

    expect(result.current[0]!.activity).toBeUndefined();
  });

  it('counts up on its own clock, with nothing arriving', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
    useRoomPresenceStore
      .getState()
      .observe(ROOM, signal('kai', 'working', 'entry-1', '2026-07-30T10:00:00.000Z'));

    const { result } = renderHook(() => useRoomPresence(ROOM));
    expect(result.current[0]!.elapsedMs).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * PRESENCE_TICK_MS);
    });

    expect(result.current[0]!.elapsedMs).toBe(3 * PRESENCE_TICK_MS);
  });

  it('lets an indicator nothing restates expire, and stops its own timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-1'));

    const { result } = renderHook(() => useRoomPresence(ROOM));
    expect(result.current).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS);
    });

    expect(result.current).toHaveLength(0);
    expect(keysIn(ROOM)).toEqual([]);
    // Nothing left to draw, so nothing left to tick: the room key is gone, which
    // is what tells the hook to clear its interval.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never draws an indicator that expired while nobody was looking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-1'));

    // The room was closed for the whole of the TTL, so no timer ran and nothing
    // pruned. Opening it must not show a stale line for the second it takes the
    // first tick to arrive.
    vi.setSystemTime(new Date('2026-07-30T10:01:00.000Z'));
    const { result } = renderHook(() => useRoomPresence(ROOM));

    expect(result.current).toHaveLength(0);
  });

  /**
   * Presence follows you into a thread (design record §3.2): the panel draws
   * the claims triggered inside the thread it is showing, and the room's own
   * line draws everything else — so one claim is one line, in one place.
   */
  describe('scoped to a thread', () => {
    const inThread = { replyIds: new Set(['reply-1']), inside: true };
    const outsideThread = { replyIds: new Set(['reply-1']), inside: false };

    it('draws a claim triggered by a thread reply inside the thread', () => {
      useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'reply-1'));

      expect(renderHook(() => useRoomPresence(ROOM, inThread)).result.current).toHaveLength(1);
    });

    it('keeps that same claim OUT of the room’s own line, so it is not drawn twice', () => {
      useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'reply-1'));

      expect(renderHook(() => useRoomPresence(ROOM, outsideThread)).result.current).toHaveLength(0);
    });

    it('leaves a claim on a room message in the room, not in the thread', () => {
      useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-9'));

      expect(renderHook(() => useRoomPresence(ROOM, inThread)).result.current).toHaveLength(0);
      expect(renderHook(() => useRoomPresence(ROOM, outsideThread)).result.current).toHaveLength(1);
    });

    it('treats work triggered by the thread’s ROOT as the room’s, not the thread’s', () => {
      // The root is the thread's head AND an ordinary message in the room's
      // flow. An agent answering it was triggered before any thread existed and
      // its answer lands top-level, so drawing that line inside the panel would
      // move a room's wait into an aside it has nothing to do with. Only the
      // REPLIES scope a thread's presence.
      useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'root-1'));
      const scoped = { replyIds: new Set(['reply-1']), inside: true };

      expect(renderHook(() => useRoomPresence(ROOM, scoped)).result.current).toHaveLength(0);
    });

    it('answers with everything when nothing scopes it', () => {
      const store = useRoomPresenceStore.getState();
      store.observe(ROOM, signal('kai', 'working', 'reply-1'));
      store.observe(ROOM, signal('ana', 'working', 'entry-9'));

      expect(renderHook(() => useRoomPresence(ROOM)).result.current).toHaveLength(2);
    });
  });

  it('answers for the room asked about, and nothing for no room', () => {
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-1'));

    expect(renderHook(() => useRoomPresence('room-2')).result.current).toHaveLength(0);
    expect(renderHook(() => useRoomPresence(null)).result.current).toHaveLength(0);
  });
});

/** A stream that yields `events` and then stays open until the hook aborts it. */
function delivers(events: RoomEvent[], signalToWatch: AbortSignal): AsyncIterable<RoomEvent> {
  return (async function* () {
    for (const event of events) yield event;
    await new Promise<void>((resolve) => {
      if (signalToWatch.aborted) return resolve();
      signalToWatch.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

function wrapperFor(transport: Transport, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

describe('the room stream feeds the store', () => {
  it('parks a presence signal instead of dropping it', async () => {
    const transport = createMockTransport();
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, abort: AbortSignal) =>
        delivers([signal('kai', 'working', 'entry-1')], abort)
      );

    renderHook(() => useRoomStream(ROOM, true), {
      wrapper: wrapperFor(transport, makeQueryClient()),
    });

    await vi.waitFor(() => expect(keysIn(ROOM)).toEqual([key('kai', 'entry-1')]));
  });

  it('retires an author’s indicators when that author’s own entry arrives', async () => {
    // The reconnect-after-reply case, seeded exactly as it happens: the reply is
    // durable and replays, the `done` beside it was ephemeral and does not. With
    // no `done` on this stream at all, the entry has to be what clears the line.
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-1'));
    const transport = createMockTransport();
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, abort: AbortSignal) =>
        delivers([{ type: 'entry', seq: 2, entry: entry(2, 'kai') }], abort)
      );

    renderHook(() => useRoomStream(ROOM, true), {
      wrapper: wrapperFor(transport, makeQueryClient()),
    });

    await vi.waitFor(() => expect(keysIn(ROOM)).toEqual([]));
  });

  it('leaves another author’s indicator alone', async () => {
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-1'));
    const transport = createMockTransport();
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, abort: AbortSignal) =>
        delivers([{ type: 'entry', seq: 2, entry: entry(2, 'ana') }], abort)
      );

    const { result } = renderHook(() => useRoomStream(ROOM, true), {
      wrapper: wrapperFor(transport, makeQueryClient()),
    });

    await vi.waitFor(() => expect(result.current.stalled).toBe(false));
    expect(keysIn(ROOM)).toEqual([key('kai', 'entry-1')]);
  });

  it('claims to know nothing once the room has gone quiet', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-1'));
    const transport = createMockTransport();
    transport.subscribeRoom = vi.fn().mockImplementation(() =>
      (async function* (): AsyncIterable<RoomEvent> {
        throw new Error('socket closed');
      })()
    );

    const { result, unmount } = renderHook(() => useRoomStream(ROOM, true), {
      wrapper: wrapperFor(transport, makeQueryClient()),
    });

    try {
      await vi.waitFor(() => expect(result.current.stalled).toBe(true));
      // Whatever was working is now unknowable — the release would have come
      // down the socket that just went away, so a frozen "· 42s" under a line
      // saying nothing is coming through is the lingering-dots lie.
      expect(keysIn(ROOM)).toEqual([]);
      // It takes the whole budget to say so, and no fewer: one bad attempt must
      // not blank a room's presence. It is deliberately not an exact count any
      // more — the loop keeps retrying underneath the notice rather than
      // stopping, so by the time this assertion runs it has tried again.
      expect(
        (transport.subscribeRoom as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
      ).toBeGreaterThanOrEqual(SSE_RESILIENCE.DISCONNECTED_THRESHOLD);
    } finally {
      unmount();
    }
  });
});

describe('a message waiting on an agent busy elsewhere', () => {
  it('is stored, and kept out of every reader that means "who is working"', () => {
    // The split that makes the two halves safe to share one store. A waiting
    // agent has NOT started, so drawing it as a claim would put a pulsing dot
    // and a stoppable peek row under an agent doing nothing in this room —
    // which is exactly what happens if `useRoomPresenceClaims` stops excluding
    // it. Seeded defect: drop the `state !== 'held'` filter in `summarize`.
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-1'));
    store.observe(ROOM, heldSignal('mio', 'entry-2'));

    const claims = renderHook(() => useRoomPresenceClaims(ROOM));
    expect(claims.result.current.map((row) => row.authorId)).toEqual(['kai']);

    const holds = renderHook(() => useRoomHolds(ROOM));
    expect(holds.result.current).toEqual([
      {
        authorId: 'mio',
        entryId: 'entry-2',
        since: '2026-07-30T10:00:00.000Z',
        behindRoomId: 'room-elsewhere',
        othersWaiting: false,
      },
    ]);
  });

  it('carries the room in the way and whether anywhere else is waiting', () => {
    useRoomPresenceStore
      .getState()
      .observe(ROOM, heldSignal('mio', 'entry-2', 'room-engagement', undefined, true));

    const { result } = renderHook(() => useRoomHolds(ROOM));
    expect(result.current[0]).toMatchObject({
      behindRoomId: 'room-engagement',
      othersWaiting: true,
    });
  });

  it('is cleared by its own `done`, so the wait resolves rather than lingering', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, heldSignal('mio', 'entry-2'));
    store.observe(ROOM, signal('mio', 'done', 'entry-2'));

    expect(keysIn(ROOM)).toEqual([]);
  });

  it('is cleared when that agent speaks here, and restored by the next republish', () => {
    // `specs/room-presence` §5.1 clears every `(author, *)` indicator in a room
    // when that author posts. A waiting agent that posts here through
    // `post_to_room` mid-wait therefore loses its line — for up to the republish
    // interval, which is the same bound a live claim already accepts.
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, heldSignal('mio', 'entry-2'));
    store.clearAuthor(ROOM, 'mio');
    expect(keysIn(ROOM)).toEqual([]);

    store.observe(ROOM, heldSignal('mio', 'entry-2'));
    expect(keysIn(ROOM)).toEqual([key('mio', 'entry-2')]);
  });

  it('expires like any other indicator when the server stops restating it', () => {
    vi.useFakeTimers();
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, heldSignal('mio', 'entry-2'), 0);

    store.prune(PRESENCE_TTL_MS - 1);
    expect(keysIn(ROOM)).toEqual([key('mio', 'entry-2')]);

    store.prune(PRESENCE_TTL_MS);
    expect(keysIn(ROOM)).toEqual([]);
  });
});
