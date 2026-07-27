// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';
import { SSE_RESILIENCE } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
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

/** The `sinceCursor` argument of each `subscribeRoom` call, in order. */
function cursors(transport: Transport): unknown[] {
  return (transport.subscribeRoom as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (call) => call[1]
  );
}

beforeEach(() => {
  // Full-jitter backoff with the die rigged to zero: the retry schedule is
  // `SSEConnection`'s and is tested there; what matters here is that a retry
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

  it('stops after the retry budget and says the room has gone quiet', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());

    const { result } = renderHook(() => useRoomStream('room-1', true), {
      wrapper: wrapperFor(transport, queryClient),
    });

    await waitFor(() => expect(result.current.stalled).toBe(true));
    // Exactly the budget: 5 attempts, then it stops rather than spinning.
    expect(transport.subscribeRoom).toHaveBeenCalledTimes(SSE_RESILIENCE.DISCONNECTED_THRESHOLD);
    expect(transport.subscribeRoom).toHaveBeenCalledTimes(5);
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

  it('does not carry one room’s dead-stream notice over to the next room', async () => {
    const transport = createMockTransport();
    const queryClient = makeQueryClient();
    transport.subscribeRoom = vi.fn().mockImplementation(() => dropsImmediately());

    const { result, rerender } = renderHook(
      ({ roomId }: { roomId: string }) => useRoomStream(roomId, true),
      { wrapper: wrapperFor(transport, queryClient), initialProps: { roomId: 'room-1' } }
    );
    await waitFor(() => expect(result.current.stalled).toBe(true));

    transport.subscribeRoom = vi
      .fn()
      .mockImplementation((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal));
    rerender({ roomId: 'room-2' });

    await waitFor(() => expect(transport.subscribeRoom).toHaveBeenCalledTimes(1));
    expect(result.current.stalled).toBe(false);
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

    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Still 1: the aborted stream ending is not a failure, so nothing reopened.
    expect(transport.subscribeRoom).toHaveBeenCalledTimes(1);
  });
});
