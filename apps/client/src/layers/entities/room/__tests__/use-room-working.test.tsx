// @vitest-environment jsdom
/**
 * The sidebar's answer to "is anything happening in a room I am not looking at".
 *
 * Every case here is one the stream can actually produce, and each is a way the
 * dot could lie: a count that outlives the server that sent it, a `0` that is
 * itself aged out and lets a stale dot back, and a cached room list that
 * disagrees with what the stream just said.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomWorking, useRoomWorkingStore } from '../model/use-room-working';
import { PRESENCE_TTL_MS } from '../model/use-room-presence';

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
