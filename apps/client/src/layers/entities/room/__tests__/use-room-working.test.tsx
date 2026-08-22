// @vitest-environment jsdom
/**
 * The sidebar's answer to "is anything happening in a room I am not looking at".
 *
 * Every case here is one the stream can actually produce, and each is a way the
 * dot could lie: a count that outlives the server that sent it, a `0` that is
 * itself aged out and lets a stale dot back, and a cached room list that
 * disagrees with what the stream just said.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useOpenRoomWorking, useRoomWorking, useRoomWorkingStore } from '../model/use-room-working';
import { PRESENCE_TTL_MS } from '../model/use-room-presence';
import { roomKeys } from '../api/query-keys';

/** Put the store back to an empty cockpit between cases. */
beforeEach(() => useRoomWorkingStore.setState({ rooms: {} }));
afterEach(() => vi.useRealTimers());

describe('useRoomWorkingStore', () => {
  it('takes a count off the stream and lets a zero replace it', () => {
    const { observe } = useRoomWorkingStore.getState();
    act(() => observe({ roomId: 'r1', working: 2 }));
    expect(useRoomWorkingStore.getState().rooms['r1']?.working).toBe(2);
    act(() => observe({ roomId: 'r1', working: 0 }));
    expect(useRoomWorkingStore.getState().rooms['r1']?.working).toBe(0);
  });

  it('drops a malformed event rather than storing a dot nothing can clear', () => {
    const { observe } = useRoomWorkingStore.getState();
    act(() => observe({ roomId: 'r1' }));
    act(() => observe({ working: 3 }));
    act(() => observe(null));
    expect(useRoomWorkingStore.getState().rooms).toEqual({});
  });

  it('turns a heartbeat that stopped into a zero rather than forgetting it', () => {
    const { observe, prune } = useRoomWorkingStore.getState();
    act(() => observe({ roomId: 'busy', working: 1 }, 1_000));
    act(() => observe({ roomId: 'idle', working: 0 }, 1_000));
    act(() => prune(1_000 + PRESENCE_TTL_MS));
    // Replaced, not removed. A forgotten room falls back to the room list, which
    // is cached and still remembers the turn — so forgetting is what would turn
    // a dead server into a dot that never goes out.
    expect(useRoomWorkingStore.getState().rooms['busy']?.working).toBe(0);
    // And a statement was already at rest; nothing about it goes stale.
    expect(useRoomWorkingStore.getState().rooms['idle']?.working).toBe(0);
  });
});

describe('useRoomWorking', () => {
  it('falls back to the room list until the stream has spoken', () => {
    const { result } = renderHook(() => useRoomWorking('r1', 3));
    expect(result.current).toBe(3);
  });

  it('answers 0 for a room neither the list nor the stream knows about', () => {
    const { result } = renderHook(() => useRoomWorking('r1', undefined));
    expect(result.current).toBe(0);
  });

  it('lets the stream overrule a cached list that still remembers the turn', () => {
    // The case a fallback alone gets wrong: the list was fetched while the agent
    // was working, the turn has since ended, and only the stream knows.
    const { result } = renderHook(() => useRoomWorking('r1', 1));
    act(() => useRoomWorkingStore.getState().observe({ roomId: 'r1', working: 0 }));
    expect(result.current).toBe(0);
  });

  it('clears the dot for good when the server stops restating it, stale list and all', () => {
    // The crash story, with the room list saying what it said when the turn was
    // alive: the server died mid-turn, nothing invalidates that list on
    // presence, and the tab may stay open for hours. The dot has to go out and
    // STAY out — a store that forgot the expired count would fall back to this
    // `listed` and light the row again a second later.
    vi.useFakeTimers();
    const { result } = renderHook(() => useRoomWorking('r1', 1));
    act(() => useRoomWorkingStore.getState().observe({ roomId: 'r1', working: 1 }));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(PRESENCE_TTL_MS + 1_000));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(0);
  });

  it('reads an already-expired record as idle on the very first render', () => {
    // A row that mounts between two prunes: nothing has swept the store yet, and
    // the honest answer cannot wait a second for a timer.
    const stale = Date.now() - PRESENCE_TTL_MS - 1;
    act(() => useRoomWorkingStore.getState().observe({ roomId: 'r1', working: 1 }, stale));
    const { result } = renderHook(() => useRoomWorking('r1', 4));
    expect(result.current).toBe(0);
  });
});

describe('useOpenRoomWorking', () => {
  /**
   * The open room's hook, wired to a cockpit that has already fetched its room
   * list — which is the state every real cockpit is in by the time a room opens.
   */
  function renderOpen(roomId: string, listed: { id: string; working: number }[]) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(roomKeys.list(), listed);
    const transport = createMockTransport({});
    return renderHook(() => useOpenRoomWorking(roomId), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });
  }

  it('says the room is busy from the room list, before the stream has said anything', () => {
    // **The mid-turn window, and the only thing that covers it.** Opening a room
    // while a turn is already running is the case a live signal cannot answer:
    // the room's stream republishes presence up to ten seconds later, so for
    // those seconds a reader who opened a working room would be told nothing is
    // happening. The list's `working` field is a live read of the same claim map
    // taken when the list was fetched, and it fills exactly that gap.
    //
    // This was covered by the room masthead's suite until phase R1 deleted the
    // masthead; the bar's chip reads the same hook, so the coverage belongs here
    // now — one level below either surface.
    const { result } = renderOpen('r1', [{ id: 'r1', working: 2 }]);
    expect(result.current).toBe(2);
  });

  it('lets the stream take over the moment it speaks', () => {
    const { result } = renderOpen('r1', [{ id: 'r1', working: 2 }]);
    expect(result.current).toBe(2);

    // The turn ends. A cached list still remembering it must not keep the chip
    // lit — the stream's `0` is the newer fact.
    act(() => useRoomWorkingStore.getState().observe({ roomId: 'r1', working: 0 }));
    expect(result.current).toBe(0);
  });

  it('answers 0 for a room the list has never carried', () => {
    const { result } = renderOpen('r1', [{ id: 'other', working: 5 }]);
    expect(result.current).toBe(0);
  });
});
