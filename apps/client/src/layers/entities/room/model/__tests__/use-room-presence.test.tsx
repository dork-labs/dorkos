// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
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
  useRoomSilentFinish,
} from '../live/use-room-presence';

const ROOM = 'room-1';

/** A presence publish, shaped exactly as the dispatcher puts it on the wire. */
function signal(
  authorId: string,
  state: 'working' | 'working_late' | 'done',
  entryId: string,
  since = '2026-07-30T10:00:00.000Z',
  activity?: SessionActivity,
  // Only ever set alongside `state: 'done'` (D7) — appended last, and optional,
  // so every existing call above stays exactly what it was.
  outcome?: 'answered' | 'silent'
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
    ...(outcome ? { outcome } : {}),
  };
}

/** A `held` publish — this room's message waiting on a turn somewhere else. */
function heldSignal(
  authorId: string,
  entryId: string,
  behindRoomId = 'room-elsewhere',
  since = '2026-07-30T10:00:00.000Z',
  othersWaiting = false,
  severalInTheWay?: boolean
): RoomSignalEvent {
  return {
    type: 'signal',
    signal: 'progress',
    authorId,
    at: since,
    state: 'held',
    entryId,
    since,
    heldBehind: {
      roomId: behindRoomId,
      othersWaiting,
      ...(severalInTheWay === undefined ? {} : { severalInTheWay }),
    },
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

  it('drops every one of an author’s claims when that author posts', () => {
    const store = useRoomPresenceStore.getState();
    store.observe(ROOM, signal('kai', 'working', 'entry-1'));
    store.observe(ROOM, signal('kai', 'working_late', 'entry-2'));
    store.observe(ROOM, signal('ana', 'working', 'entry-3'));

    store.clearAuthor(ROOM, 'kai');

    expect(keysIn(ROOM)).toEqual([key('ana', 'entry-3')]);
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

  it('never draws an indicator that expired while nobody was looking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'working', 'entry-1'));

    // The room was closed for the whole of the TTL, so no timer ran and nothing pruned.
    vi.setSystemTime(new Date('2026-07-30T10:01:00.000Z'));
    const { result } = renderHook(() => useRoomPresence(ROOM));

    expect(result.current).toHaveLength(0);
  });

  /**
   * Presence follows you into a thread (design record §3.2): the panel draws the claims triggered
   * inside the thread it is showing, and the room's own line draws everything else — so one claim
   * is one line, in one place.
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
    // The reconnect-after-reply case, seeded exactly as it happens: the reply is durable and
    // replays, the `done` beside it was ephemeral and does not.
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
      // Whatever was working is now unknowable — the release would have come down the socket that
      // just went away, so a frozen "· 42s" under a line saying nothing is coming through is the
      // lingering-dots lie.
      expect(keysIn(ROOM)).toEqual([]);
      // It takes the whole budget to say so, and no fewer: one bad attempt must not blank a
      // room's presence.
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
    // The split that makes the two halves safe to share one store.
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
        severalInTheWay: false,
      },
    ]);
  });

  it('carries whether several of the agent’s turns are in the way (DOR-2104)', () => {
    useRoomPresenceStore
      .getState()
      .observe(ROOM, heldSignal('mio', 'entry-2', 'room-engagement', undefined, false, true));

    const { result } = renderHook(() => useRoomHolds(ROOM));
    expect(result.current[0]).toMatchObject({ severalInTheWay: true });
  });
});

describe('a turn that released with nothing to show (D7)', () => {
  it('records nothing from a `done` with no `outcome` at all — the regression that matters', () => {
    // The older-server case D7 exists to protect: a `done` that carries no
    // opinion must leave this slot exactly as untouched as it always was.
    useRoomPresenceStore.getState().observe(ROOM, signal('kai', 'done', 'entry-1'));

    expect(useRoomPresenceStore.getState().silentFinish[ROOM]).toBeUndefined();
  });
});

describe('useRoomSilentFinish', () => {
  it('draws a fresh silent release', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
    useRoomPresenceStore
      .getState()
      .observe(ROOM, signal('kai', 'done', 'entry-1', undefined, undefined, 'silent'));

    const { result } = renderHook(() => useRoomSilentFinish(ROOM));

    expect(result.current).toEqual({
      authorId: 'kai',
      entryId: 'entry-1',
      at: Date.parse('2026-07-30T10:00:00.000Z'),
    });
  });
});
