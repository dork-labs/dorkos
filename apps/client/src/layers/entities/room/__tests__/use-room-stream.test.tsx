// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEvent, RoomNoticeCode } from '@dorkos/shared/room-schemas';
import { RoomStreamHttpError, SSE_RESILIENCE } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { useRoomPresenceStore } from '../model/use-room-presence';
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

/** A `notice` — the room speaking about itself, written by the system author. */
function notice(seq: number, code: RoomNoticeCode, subjectAuthorId: string): RoomEntry {
  return {
    ...entry(seq),
    authorId: 'system',
    kind: 'notice',
    body: { text: 'the room said something about itself', notice: code, subjectAuthorId },
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
  // `gcTime: Infinity` on purpose: the hook's whole job is to read and write a
  // cache nothing else observes, and the usual test default of `gcTime: 0`
  // collects the history the moment it is seeded — the cursor would then always
  // read 0 and the test would be measuring the harness.
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
  useRoomPresenceStore.setState({ rooms: {} });
  // Full-jitter backoff with the die rigged to zero: the retry schedule is
  // `WSConnection`'s and is tested there; what matters here is that a retry
  // happens at all, and from where.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRoomStream', () => {
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
    // The first connect resumed from the history read's high-water mark; the
    // second from the last entry the dropped stream actually delivered — so
    // seq 5 and 6 are never asked for twice and seq 7 is never skipped.
    expect(cursors(transport)).toEqual([4, 6]);
    expect(transport.subscribeRoom).toHaveBeenLastCalledWith(
      'room-1',
      6,
      expect.any(AbortSignal) as AbortSignal
    );
  });

  it('merges what a dropped stream did deliver before it died', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry(4)]);
    transport.subscribeRoom = vi
      .fn()
      .mockImplementationOnce(() => deliversThenDrops(5))
      .mockImplementationOnce((_id: string, _cursor: number, signal: AbortSignal) =>
        staysOpen(signal)
      );

    renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    await waitFor(() =>
      expect(queryClient.getQueryData<RoomEntry[]>(roomKeys.entries('room-1'))).toHaveLength(2)
    );
    expect(
      queryClient.getQueryData<RoomEntry[]>(roomKeys.entries('room-1'))?.map((e) => e.seq)
    ).toEqual([4, 5]);
  });

  it('says the room has gone quiet once the retries stop landing', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());
    // Something was working when the stream died, and after the notice it must
    // not still be on screen: the release would have come down the socket that
    // just went away.
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

  it('keeps trying after it has said the room is quiet', async () => {
    // THE regression. Retrying used to STOP at the budget, so a room that lost
    // its stream for eight seconds was frozen for as long as the tab stayed
    // open — while the global stream beside it reconnected forever. Red on the
    // old shape, which never called `subscribeRoom` a sixth time.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());

    const { result, unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(result.current.stalled).toBe(true));
      const atStall = subscribeCallCount(transport);
      await waitFor(() => expect(subscribeCallCount(transport)).toBeGreaterThan(atStall));
    } finally {
      unmount();
    }
  });

  it('takes the notice back down when a retry finally connects', async () => {
    // The other half: a room that comes back on its own has to stop saying it
    // has not. Proof of life here is an arriving event, which is the fast path
    // — a silent-but-healthy stream is cleared by the stability window instead.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());

    const { result, unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(result.current.stalled).toBe(true));

      // The server comes back, and NOBODY asks the room to try again — the
      // loop's own next attempt is what has to find it. On the old shape there
      // was no next attempt.
      transport.subscribeRoom = vi
        .fn()
        .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) =>
          (async function* (): AsyncIterable<RoomEvent> {
            yield { type: 'entry', seq: 7, entry: entry(7) } satisfies RoomEvent;
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          })()
        );

      await waitFor(() => expect(result.current.stalled).toBe(false));
      expect(
        queryClient.getQueryData<RoomEntry[]>(roomKeys.entries('room-1'))?.map((e) => e.seq)
      ).toEqual([7]);
    } finally {
      unmount();
    }
  });

  it('forgives the earlier failures of a stream that stayed up', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    // A clock this test moves by hand, so "this stream stayed up for the
    // stability window" is a fact rather than a wait.
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);

    let attempts = 0;
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => {
        attempts += 1;
        // Attempts 1-3 die on contact. The 4th connects, runs past the stability
        // window, and only then drops — the nightly-server-restart shape. 5-7
        // die again, and the 8th holds.
        if (attempts === 4) {
          return (async function* (): AsyncIterable<RoomEvent> {
            clock += SSE_RESILIENCE.STABILITY_WINDOW_MS;
            throw new Error('dropped after a long, healthy run');
          })();
        }
        if (attempts >= 8) return staysOpen(signal);
        return dropsImmediately();
      });

    const { result, unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(8));
      // Never declared quiet, and that is the point: the healthy 4th run reset
      // the count, so the three drops after it are three, not eight. Without the
      // reset this room would have been declared dead at attempt 5, on the
      // strength of failures it had already recovered from.
      expect(result.current.stalled).toBe(false);
    } finally {
      unmount();
    }
  });

  it('stops trying when the server says the room is not this reader’s to read', async () => {
    // A room deleted, or access revoked, while it was open. Retrying that
    // forever draws "reconnecting" over something that is never coming back —
    // a worse lie than the frozen room the infinite retry was written to fix.
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

  it('keeps trying on a server error, which is not the same thing at all', async () => {
    // 5xx is a server having a bad minute. Only the statuses that mean "answered,
    // and the answer is no" are fatal.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() =>
      (async function* (): AsyncIterable<RoomEvent> {
        throw new RoomStreamHttpError(503, 'Service Unavailable');
      })()
    );

    const { result, unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(result.current.stalled).toBe(true));
      expect(result.current.unavailable).toBe(false);
      const atStall = subscribeCallCount(transport);
      await waitFor(() => expect(subscribeCallCount(transport)).toBeGreaterThan(atStall));
    } finally {
      unmount();
    }
  });

  it('coalesces a burst of wake-ups into one reconnect', async () => {
    // A laptop coming out of sleep fires all three within milliseconds of each
    // other. Acting on each is three teardowns and three reopens of one socket
    // to reach the state the first would have reached.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal));

    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(subscribeCallCount(transport)).toBe(1));

      // The burst runs on a hand-driven clock, so the gap between the two
      // wake-ups is a number rather than a hope.
      //
      // The hook gathers wake-ups for a fixed window of REAL time, and this case
      // is "two arrived inside it". Saying that with a real 10ms sleep made the
      // test a race against its own runner: nothing bounds how long a 10ms sleep
      // actually takes on a loaded machine, and one that overran the window let
      // the first wake-up fire alone — after which the second armed a second
      // reconnect and opened a THIRD stream. That is the hook behaving
      // correctly, on a burst the test only meant to look like one, and it is
      // the CI flake (DOR-1060). Virtual milliseconds cannot be stretched.
      //
      // Two events in one tick would not do instead: they would fold together in
      // React's own batching, and measure that rather than this hook.
      //
      // `waitFor` is deliberately not used past this point — it polls on a timer
      // this clock now owns, and would wait for a tick that never comes.
      vi.useFakeTimers();
      try {
        act(() => {
          window.dispatchEvent(new Event('online'));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        act(() => {
          window.dispatchEvent(new Event('online'));
        });

        // Past the window the FIRST wake-up opened: the one reconnect a burst is
        // supposed to cost.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(45);
        });
        // Then past where an uncoalesced SECOND wake-up would have fired, in its
        // own `act`. One block covering both instants would not do: React folds
        // every update raised inside one `act` into a single render, so two
        // reconnects would commit as one and this assertion would hold whether
        // or not the hook coalesced anything.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(subscribeCallCount(transport)).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      unmount();
    }
  });

  it('retries when the browser comes back online', async () => {
    // The room stream cannot see the network; the window can. Without this a
    // reader who lost wifi for a moment waits out a 30s backoff for a room that
    // could have been live the instant the link came back.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    let attempts = 0;
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => {
        attempts += 1;
        // Long-lived from the first connect, so the ONLY thing that can open a
        // second one is the event below.
        return staysOpen(signal);
      });

    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(1));
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(2));
      expect(attempts).toBe(2);
    } finally {
      unmount();
    }
  });

  it('leaves a healthy stream alone on a brief tab switch', async () => {
    // The other side of the wake-ups, and the reason they are not simply "retry
    // on anything": tearing down a live socket every time somebody alt-tabs
    // would be worse than the outage it is meant to shorten.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal));

    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(1));
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // A negative — that nothing reconnected — so it is settled by giving the
      // loop every chance to and finding it did not.
      await act(async () => {});
      expect(transport.subscribeRoom).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  it('clears the indicator of an agent a failed-turn notice is about', async () => {
    // A notice is written by the SYSTEM author, so clearing on the entry's own
    // author never reaches the agent the notice is ABOUT. Without this the room
    // draws "Kai is working · 6m" directly under a line saying Kai ran into a
    // problem and could not answer — and nothing else would ever take it down,
    // because the `done` that would have is exactly what did not happen.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    useRoomPresenceStore.getState().observe('room-1', {
      type: 'signal',
      signal: 'progress',
      authorId: 'kai',
      at: '2026-07-26T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-4',
      since: '2026-07-26T10:00:00.000Z',
    });

    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) =>
        (async function* (): AsyncIterable<RoomEvent> {
          yield { type: 'entry', seq: 8, entry: notice(8, 'turn_failed', 'kai') };
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        })()
      );

    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() => expect(useRoomPresenceStore.getState().rooms['room-1']).toBeUndefined());
    } finally {
      unmount();
    }
  });

  it('leaves the indicator alone when a busy notice arrives', async () => {
    // `agent_busy` reads like a stop and is the opposite: the trigger was
    // skipped BECAUSE that agent's session was already being written to, so it
    // is genuinely working — on the older message. Clearing here would blank the
    // one true thing on screen.
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    useRoomPresenceStore.getState().observe('room-1', {
      type: 'signal',
      signal: 'progress',
      authorId: 'kai',
      at: '2026-07-26T10:00:00.000Z',
      state: 'working',
      entryId: 'entry-4',
      since: '2026-07-26T10:00:00.000Z',
    });

    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) =>
        (async function* (): AsyncIterable<RoomEvent> {
          yield { type: 'entry', seq: 8, entry: notice(8, 'agent_busy', 'kai') };
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        })()
      );

    const { unmount } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    try {
      await waitFor(() =>
        expect(queryClient.getQueryData<RoomEntry[]>(roomKeys.entries('room-1'))).toHaveLength(1)
      );
      expect(useRoomPresenceStore.getState().rooms['room-1']).toBeDefined();
    } finally {
      unmount();
    }
  });

  it('tries again on request, from the newest entry the reader holds', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry(9)]);
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());

    const { result } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });
    await waitFor(() => expect(result.current.stalled).toBe(true));

    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal));
    act(() => result.current.retry());

    await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(1));
    expect(transport.subscribeRoom).toHaveBeenCalledWith(
      'room-1',
      9,
      expect.any(AbortSignal) as AbortSignal
    );
    expect(result.current.stalled).toBe(false);
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

    // The return trip. room-1's server is back, so coming back opens a healthy
    // stream — and the notice has to go with the stream it was about. Recording
    // the stall against the room alone made it permanent: messages arriving,
    // banner still saying nothing was.
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

  it('does not move the resume cursor for a reaction', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    queryClient.setQueryData<RoomEntry[]>(roomKeys.entries('room-1'), [entry(4)]);
    transport.subscribeRoom = vi
      .fn()
      .mockImplementationOnce(() =>
        (async function* (): AsyncIterable<RoomEvent> {
          yield { type: 'reaction', entryId: 'entry-4', reactions: [] };
          throw new Error('socket closed');
        })()
      )
      .mockImplementationOnce((_id: string, _cursor: number, signal: AbortSignal) =>
        staysOpen(signal)
      );

    renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(2));
    // Still 4. A reaction carries no `seq` and is not a place in the log, so a
    // reader that let one advance its cursor would skip real messages.
    expect(cursors(transport)).toEqual([4, 4]);
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

    // The assertion is a NEGATIVE — that no reconnect happens — which `waitFor`
    // cannot express, so the clock is moved by hand instead of slept through.
    // Fake timers only from here: everything above needs the real ones, and the
    // window advanced is the longest backoff the hook can possibly schedule, so
    // a retry that existed would have fired by the assertion below whatever the
    // jitter rolled.
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
