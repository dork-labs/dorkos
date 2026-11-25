// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import { SSE_RESILIENCE } from '@/layers/shared/lib';
import {
  RoomStreamHttpError,
  subscribeDocChannelNotifications,
} from '@/layers/shared/lib/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { useRoomPresenceStore } from '../model/live/use-room-presence';
import { useRoomStream } from '../model/use-room-stream';

function entry(seq: number): RoomEntry {
  return {
    roomId: 'room-1',
    seq,
    id: `entry-${seq}`,
    authorId: 'ana',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

/** A stream that delivers `entries`, then dies the way a dropped socket does. */
function deliversThenDrops(...seqs: number[]): AsyncIterable<RoomEvent> {
  return (async function* () {
    for (const seq of seqs) yield { type: 'entry', seq, entry: entry(seq) } satisfies RoomEvent;
    throw new Error('socket closed');
  })();
}

/** A stream that dies before delivering anything. */
function dropsImmediately(): AsyncIterable<RoomEvent> {
  return deliversThenDrops();
}

/** A live but silent stream — stays open until the hook aborts it. */
function staysOpen(signal: AbortSignal): AsyncIterable<RoomEvent> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

function makeQueryClient(): QueryClient {
  // `gcTime: Infinity` on purpose: the hook's whole job is to read and write a cache nothing else
  // observes, and the usual test default of `gcTime: 0` collects the history the moment it is
  // seeded — the cursor would then always read 0 and the test would be measuring the harness.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

function wrapperFor(transport: Transport, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** How many times `subscribeRoom` has been called. */
function subscribeCallCount(transport: Transport): number {
  return (transport.subscribeRoom as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
}

/** The `sinceCursor` argument of each `subscribeRoom` call, in order. */
function cursors(transport: Transport): unknown[] {
  return (transport.subscribeRoom as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (call) => call[1]
  );
}

beforeEach(() => {
  useRoomPresenceStore.getState().reset();
  // Full-jitter backoff with the die rigged to zero: the retry schedule is `WSConnection`'s and
  // is tested there; what matters here is that a retry happens at all, and from where.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRoomStream', () => {
  it('publishes document notifications without advancing entry history or its reconnect cursor', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry(4)]);
    const docs = vi.fn();
    const stop = subscribeDocChannelNotifications('room:room-1', docs);
    const documentEvent = {
      type: 'canvas_event',
      scope: 'room:room-1',
      documentId: 'doc-1',
      docSeq: 900,
      event: {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'app.updated',
        payload: {},
        direction: 'downstream',
        receivedAt: '2026-10-01T00:00:00.000Z',
      },
    } satisfies RoomEvent;
    const snapshot = {
      type: 'canvas_channel_snapshot',
      scope: 'room:room-1',
      documentId: 'doc-1',
      snapshot: {
        state: {},
        stateRev: 0,
        highWatermark: 900,
        retentionFloor: 1,
        receiptRetentionFloor: 1,
        resetRequired: false,
        health: { status: 'ready', reasons: [] },
        receipts: [],
      },
    } satisfies RoomEvent;
    transport.subscribeRoom = vi
      .fn()
      .mockImplementationOnce(() =>
        (async function* () {
          yield documentEvent;
          yield snapshot;
          throw new Error('socket closed');
        })()
      )
      .mockImplementationOnce((_id: string, _cursor: number, signal: AbortSignal) =>
        staysOpen(signal)
      );
    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });
    try {
      await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(2));
      expect(docs.mock.calls.map(([frame]) => frame)).toEqual([documentEvent, snapshot]);
      expect(cursors(transport)).toEqual([4, 4]);
      expect(queryClient.getQueryData(roomKeys.entries('room-1'))).toEqual([entry(4)]);
    } finally {
      stop();
      unmount();
    }
  });

  it('waits for the history read before subscribing at all', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    renderHook(() => useRoomStream('room-1', false), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await act(async () => {});
    expect(transport.subscribeRoom).toHaveBeenCalledTimes(0);
  });

  it('re-subscribes when the stream drops, resuming from the newest entry it holds', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    // The history read landed with entries up to seq 4.
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry(3), entry(4)]);
    transport.subscribeRoom = vi
      .fn()
      .mockImplementationOnce(() => deliversThenDrops(5, 6))
      .mockImplementationOnce((_id: string, _cursor: number, signal: AbortSignal) =>
        staysOpen(signal)
      );

    renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(2));
    // The first connect resumed from the history read's high-water mark; the second from the last
    // entry the dropped stream actually delivered — so seq 5 and 6 are never asked for twice and
    // seq 7 is never skipped.
    expect(cursors(transport)).toEqual([4, 6]);
    expect(transport.subscribeRoom).toHaveBeenLastCalledWith(
      'room-1',
      6,
      expect.any(AbortSignal) as AbortSignal
    );
  });

  it('routes a tab-presence signal to the canvas, and a working signal past it', async () => {
    // The two facts share the ephemeral lane and must never be read as each other: one says an
    // agent is doing work, the other says where a member is looking.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation((_id: string, _cursor: number) =>
      (async function* () {
        yield {
          type: 'signal',
          signal: 'presence',
          authorId: 'author-ana',
          at: '2026-09-12T00:00:00.000Z',
          documentId: 'doc-1',
        } satisfies RoomEvent;
        yield {
          type: 'signal',
          signal: 'progress',
          authorId: 'author-ben',
          at: '2026-09-12T00:00:01.000Z',
          state: 'working',
          entryId: 'entry-9',
          since: '2026-09-12T00:00:01.000Z',
        } satisfies RoomEvent;
        await new Promise(() => {});
      })()
    );

    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() =>
        expect(useAppStore.getState().roomCanvasPresence['room-1']).toEqual({
          'author-ana': 'doc-1',
        })
      );
      // The working indicator went to the OTHER store, and put no face on a tab.
      expect(Object.keys(useRoomPresenceStore.getState().rooms['room-1'] ?? {})).toHaveLength(1);
      expect(useAppStore.getState().roomCanvasPresence['room-1']).not.toHaveProperty('author-ben');
    } finally {
      unmount();
    }
  });

  it('says the room has gone quiet once the retries stop landing', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());
    // Something was working when the stream died, and after the notice it must not still be on
    // screen: the release would have come down the socket that just went away.
    useRoomPresenceStore.getState().observe('room-1', {
      type: 'signal',
      signal: 'progress',
      authorId: 'kai',
      at: '2026-07-26T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-4',
      since: '2026-07-26T10:00:00.000Z',
    });

    const { result, unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(result.current.stalled).toBe(true));
      // The budget decides WHEN it is said, and nothing less than the budget
      // says it: one bad attempt must not put a banner over a healthy room.
      expect(subscribeCallCount(transport)).toBeGreaterThanOrEqual(
        SSE_RESILIENCE.DISCONNECTED_THRESHOLD
      );
      expect(useRoomPresenceStore.getState().rooms['room-1']).toBeUndefined();
    } finally {
      unmount();
    }
  });

  it('stops trying when the server says the room is not this reader’s to read', async () => {
    // A room deleted, or access revoked, while it was open.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() =>
      (async function* (): AsyncIterable<RoomEvent> {
        throw new RoomStreamHttpError(404, 'Not Found');
      })()
    );

    const { result, unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(result.current.unavailable).toBe(true));
      // Everything that stands down on a stalled room stands down on this one
      // too — only the words change.
      expect(result.current.stalled).toBe(true);
      // One attempt, and then it stops. The budget is for a server that might
      // come back; this one has answered.
      expect(subscribeCallCount(transport)).toBe(1);

      // And it stays stopped, which is the assertion the budget test cannot
      // make: give the loop every chance to try again and find it did not.
      await act(async () => {});
      expect(subscribeCallCount(transport)).toBe(1);
    } finally {
      unmount();
    }
  });

  it('does not carry a dead-stream notice to the next room, or back to a revived one', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());

    const { result, rerender } = renderHook(
      ({ roomId }: { roomId: string }) => useRoomStream(roomId, true),
      { wrapper: wrapperFor(transport, queryClient), initialProps: { roomId: 'room-1' } }
    );
    await waitFor(() => expect(result.current.stalled).toBe(true));

    const healthy = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal));
    transport.subscribeRoom = healthy;
    rerender({ roomId: 'room-2' });

    await waitFor(() => expect(healthy).toHaveBeenCalledTimes(1));
    expect(result.current.stalled).toBe(false);

    // The return trip. room-1's server is back, so coming back opens a healthy stream — and the
    // notice has to go with the stream it was about.
    rerender({ roomId: 'room-1' });

    await waitFor(() => expect(healthy).toHaveBeenCalledTimes(2));
    expect(healthy).toHaveBeenLastCalledWith('room-1', 0, expect.any(AbortSignal) as AbortSignal);
    expect(result.current.stalled).toBe(false);
  });

  it('puts an arriving reaction set on the entry it names, whole', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [
      {
        ...entry(4),
        reactions: [{ emoji: '👍', authorIds: ['ana'], firstAt: '2026-07-26T10:00Z' }],
      },
      entry(5),
    ]);
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) =>
        (async function* (): AsyncIterable<RoomEvent> {
          yield {
            type: 'reaction',
            entryId: 'entry-4',
            reactions: [{ emoji: '🎉', authorIds: ['kai'], firstAt: '2026-07-26T11:00Z' }],
          };
          // An empty set for entry-5, which is what a resume sends for every
          // entry in the trailing window — including the ones with no pills.
          yield { type: 'reaction', entryId: 'entry-5', reactions: [] };
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        })()
      );

    renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    await waitFor(() => {
      const held = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries('room-1'));
      // Replaced outright: the 👍 is gone, not kept alongside the 🎉. A client
      // that merged would show a pill the server no longer holds.
      expect(held?.[0]!.reactions).toEqual([
        { emoji: '🎉', authorIds: ['kai'], firstAt: '2026-07-26T11:00Z' },
      ]);
      expect(held?.[1]!.reactions).toEqual([]);
    });
  });

  it('drains throwing retirement subscribers, aborts the actual room stream and clears its stability timer', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    let signal!: AbortSignal;
    let closed = false;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, ownedSignal: AbortSignal) => {
        signal = ownedSignal;
        return (async function* (): AsyncIterable<RoomEvent> {
          try {
            for await (const event of staysOpen(ownedSignal)) yield event;
          } finally {
            closed = true;
          }
        })();
      });
    const sibling = vi.fn();
    const stops = [
      subscribeDocChannelNotifications(undefined, vi.fn(), transport, () => {
        throw new Error('Retirement subscriber');
      }),
      subscribeDocChannelNotifications(undefined, vi.fn(), transport, sibling),
    ];
    const view = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });
    try {
      await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(1));
      const index = timers.mock.calls.findIndex(
        ([, delay]) => delay === SSE_RESILIENCE.STABILITY_WINDOW_MS
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const stable = timers.mock.results[index].value;
      await act(async () => view.unmount());
      expect(signal.aborted).toBe(true);
      expect(closed).toBe(true);
      expect(sibling).toHaveBeenCalledOnce();
      expect(cleared).toHaveBeenCalledWith(stable);
      expect(transport.subscribeRoom).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      stops.forEach((stop) => stop());
      timers.mockRestore();
      cleared.mockRestore();
    }
  });

  it('treats leaving the room as leaving, not as a drop worth retrying', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    // A live stream, so the only thing that can end it is the hook's own abort.
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal));

    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(1));

    // The assertion is a NEGATIVE — that no reconnect happens — which `waitFor` cannot express,
    // so the clock is moved by hand instead of slept through.
    vi.useFakeTimers();
    try {
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SSE_RESILIENCE.BACKOFF_CAP_MS);
      });
      // Still 1: the aborted stream ending is not a failure, so nothing reopened.
      expect(transport.subscribeRoom).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
