/**
 * The lane's one ticking reading: how long the oldest claim has been running.
 *
 * Its own hook rather than inline in `LaneContent`, for two reasons. It holds a
 * timer and a clock, so nothing above it re-renders once a second — the rule
 * `PresenceStrip` already documents for its own rows. And a clock that a caller
 * can hand over is the only way to pin the deadline this thing is made of: the
 * reading appears on a wake, and whether it appears at all is decided by a
 * comparison against {@link LANE_TIMER_FLOOR_MS} (DOR-1729).
 *
 * @module features/conversation/model/use-lane-elapsed
 */
import { useEffect, useState } from 'react';
import { laneElapsed, LANE_TIMER_FLOOR_MS } from './lane-state';

/** How often the reading moves on, once there is one on screen. */
const LANE_TICK_MS = 1_000;

/**
 * How long a claim has been running, ticking once a second — or `null` while it
 * is still too young for a number.
 *
 * Nothing is drawn for the first ten seconds ({@link LANE_TIMER_FLOOR_MS}): a
 * number that starts at `0s` draws the eye for nothing. So a claim that has just
 * arrived sleeps until its number is DUE and only then starts a per-second
 * timer — a room with four agents in it was otherwise running four intervals to
 * render nothing.
 *
 * @param since - ISO 8601, when the claim started. Comes off the wire, so it is
 *   the SERVER's reading of its own clock.
 * @param now - This client's clock. Injectable so a test can pin the deadline
 *   instead of racing it; defaults to `Date.now`, which is what the app runs on.
 *   Must be stable across renders — the timer is rebuilt when it changes.
 * @returns The elapsed time in words, or `null` below the floor.
 */
export function useLaneElapsed(since: string, now: () => number = Date.now): string | null {
  const due = Date.parse(since) + LANE_TIMER_FLOOR_MS;
  const [reading, setReading] = useState(() => now());

  // **Keyed on `due` alone, never on the `reading` it writes.** Depending on the
  // reading made every tick tear the interval down and build a new one, and a
  // new interval starts its second from the moment React COMMITS rather than
  // from the moment the tick fired — so the number drifted a little further
  // behind the clock with every second it counted (DOR-1642).
  useEffect(() => {
    const tick = () => setReading(now());
    let timer: ReturnType<typeof setInterval> | undefined;
    let wake: ReturnType<typeof setTimeout> | undefined;
    const wait = due - now();
    if (wait > 0) {
      wake = setTimeout(() => {
        // **Never earlier than `due`.** The wake exists BECAUSE the number is
        // due, so the reading it posts may not be one that floors back to
        // nothing: `setTimeout` counts down a monotonic clock and this reads a
        // wall clock, and the two need only disagree by a millisecond for
        // `now()` to answer `due - 1`. `laneElapsed` would then return `null`
        // and the lane would draw nothing for another whole second — on the one
        // tick somebody is actually watching for (DOR-1729). A wake that lands
        // LATE, which is the ordinary case on a busy machine, still posts the
        // clock's own answer.
        setReading(Math.max(now(), due));
        timer = setInterval(tick, LANE_TICK_MS);
      }, wait);
    } else {
      timer = setInterval(tick, LANE_TICK_MS);
    }
    return () => {
      clearTimeout(wake);
      clearInterval(timer);
    };
  }, [due, now]);

  return laneElapsed(since, reading);
}
