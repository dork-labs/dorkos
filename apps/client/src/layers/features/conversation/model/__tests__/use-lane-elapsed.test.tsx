// @vitest-environment jsdom
/**
 * The lane's ticking reading, with the clock handed to it (DOR-1729).
 *
 * `RoomLiveLane.test.tsx` drives this leaf through the whole room and pins the
 * sentences it appears beside. What it cannot pin is the ONE boundary the
 * reading is made of, because the clock the leaf reads and the clock its wake
 * counts down are not the same clock: `setTimeout` counts a monotonic one and
 * `Date.now()` reads the wall clock, and they need only disagree by a
 * millisecond for the wake to land with `now()` still answering `due - 1`. The
 * floor then returns `null` and the lane draws nothing for another whole second
 * — on the one tick a waiting person is watching for.
 *
 * Fake timers cannot reproduce that: they move both clocks together, which is
 * exactly why the room suite is green and this one is worth having. So the
 * timer here is fake and the CLOCK is injected, set by hand to the millisecond
 * the case is about.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { LANE_TIMER_FLOOR_MS } from '../lane-state';
import { useLaneElapsed } from '../use-lane-elapsed';

const SINCE = '2026-07-30T10:00:00.000Z';
const STARTED = Date.parse(SINCE);
/** The instant the reading becomes due — the whole subject of this file. */
const DUE = STARTED + LANE_TIMER_FLOOR_MS;

/**
 * A clock the test sets by hand, stable across renders so the hook's timer is
 * built once.
 */
function handClock(start: number) {
  const state = { at: start };
  const now = () => state.at;
  return { now, set: (at: number) => void (state.at = at) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useLaneElapsed', () => {
  it('draws nothing at all under the ten-second floor', () => {
    const clock = handClock(STARTED);
    const { result } = renderHook(() => useLaneElapsed(SINCE, clock.now));

    expect(result.current).toBeNull();

    // One millisecond short, and the interval has not even been built yet.
    clock.set(DUE - 1);
    act(() => void vi.advanceTimersByTime(LANE_TIMER_FLOOR_MS - 1));
    expect(result.current).toBeNull();
  });

  it('puts the number up on the wake even when the clock reads a millisecond short', () => {
    // **The boundary (DOR-1729).** The wake was woken BECAUSE the number is due;
    // a reading that floors back to nothing is not an answer it may post.
    // Seeded defect: `setReading(now())` instead of clamping at `due`, and this
    // reds with `null` — a lane that says a name and no number for a full
    // second after the number was due.
    const clock = handClock(STARTED);
    const { result } = renderHook(() => useLaneElapsed(SINCE, clock.now));

    clock.set(DUE - 1);
    act(() => void vi.advanceTimersByTime(LANE_TIMER_FLOOR_MS));

    expect(result.current).toBe('10s');
  });

  it('reports the clock’s own answer when the wake lands late, never the floor', () => {
    // The clamp is a floor, not a substitute: a busy machine wakes this late far
    // more often than early, and a reading pinned to `due` would then claim `10s`
    // for a turn that is thirteen seconds old.
    const clock = handClock(STARTED);
    const { result } = renderHook(() => useLaneElapsed(SINCE, clock.now));

    clock.set(STARTED + 13_400);
    act(() => void vi.advanceTimersByTime(LANE_TIMER_FLOOR_MS));

    expect(result.current).toBe('13s');
  });

  it('counts on once a second from the wake, with nothing arriving', () => {
    const clock = handClock(STARTED);
    const { result } = renderHook(() => useLaneElapsed(SINCE, clock.now));

    clock.set(DUE);
    act(() => void vi.advanceTimersByTime(LANE_TIMER_FLOOR_MS));
    expect(result.current).toBe('10s');

    clock.set(DUE + 2_000);
    act(() => void vi.advanceTimersByTime(2_000));
    expect(result.current).toBe('12s');
  });

  it('starts ticking immediately for a claim that was already past the floor', () => {
    const clock = handClock(STARTED + 42_000);
    const { result } = renderHook(() => useLaneElapsed(SINCE, clock.now));

    expect(result.current).toBe('42s');

    clock.set(STARTED + 45_000);
    act(() => void vi.advanceTimersByTime(3_000));
    expect(result.current).toBe('45s');
  });

  it('stops reading the clock once it is unmounted', () => {
    const clock = handClock(STARTED);
    const { unmount } = renderHook(() => useLaneElapsed(SINCE, clock.now));

    unmount();
    clock.set(DUE + 5_000);

    // Neither the wake nor the interval survives — an unmounted lane that kept a
    // timer would be one per claim, forever.
    expect(vi.getTimerCount()).toBe(0);
  });
});
