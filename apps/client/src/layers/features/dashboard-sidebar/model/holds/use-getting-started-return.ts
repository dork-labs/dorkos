/**
 * Getting started gives the slot up instantly and takes it back slowly (BC-52).
 *
 * The slot is shared: a real signal always wins it the moment there is one, and
 * Getting started is what fills the space until there is. That precedence is
 * right and untouched here. What was wrong was the shape of the second half —
 * the zone came back the instant the signal cleared, so a day-one operator with
 * suggestions still on screen watched Today jump about four rows every time an
 * agent started or finished a turn.
 *
 * So: the yield is instant, and the return is damped two ways. A minimum dwell
 * means a turn that starts and ends inside a few seconds never brings the zone
 * back at all, and the pointer defers it further, on exactly the promise BC-17
 * already makes about Today's order — nothing moves under a hand.
 *
 * **The pointer half is scoped to the zone stack, not to the whole panel**, and
 * that is BC-17's own boundary rather than a shortcut: the hold exists to keep
 * what somebody is aiming at from moving, and the zones are what move. A pointer
 * resting in the empty panel below them has nothing above it to be shifted.
 *
 * @module features/dashboard-sidebar/model/holds/use-getting-started-return
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SidebarModel } from '../build-sidebar-model';
import { useInsideHold, type InsideHoldHandlers } from './use-inside-hold';

/**
 * The shortest time Getting started can be away before it is allowed back.
 *
 * Five seconds, from BC-52: comfortably longer than the turns that produced the
 * flapping — a tool call, a one-line answer, a permission prompt resolved in a
 * breath — and short enough that an operator who genuinely stopped working is
 * looking at their suggestions again before they have finished reading the row
 * above them.
 *
 * It is a floor on the RETURN, never on the yield. Nothing here can delay a
 * real signal claiming the slot.
 */
export const GETTING_STARTED_RETURN_FLOOR_MS = 5_000;

/** What {@link useGettingStartedReturn} hands back. */
export interface GettingStartedReturn {
  /**
   * The model to draw: the one that was passed in, minus the Getting started
   * zone on the frames it is being withheld.
   */
  model: SidebarModel;
  /** Spread onto the element that wraps the zones. */
  handlers: InsideHoldHandlers;
}

/**
 * Damp the Getting-started zone's return, and nothing else.
 *
 * **This is timing, not animation, so `prefers-reduced-motion` changes none of
 * it.** The reduced-motion contract in this sidebar suppresses flourishes —
 * the welcome-back glow, the all-clear beat — because they are decoration about
 * something that already happened. Rows moving under a hand is the opposite: it
 * is the thing a motion-sensitive operator most wants stopped, and a version of
 * this hook that switched itself off under the media query would deliver the raw
 * flap to precisely the person who asked for less of it.
 *
 * @param model - The model as the builder emitted it.
 */
export function useGettingStartedReturn(model: SidebarModel): GettingStartedReturn {
  const { inside, handlers } = useInsideHold();
  const wanted = model.zones.some((zone) => zone.id === 'getting-started');

  // Whether the zone is on screen right now, which is NOT the same question as
  // whether the model wants it there. The gap between the two is the damping.
  const [showing, setShowing] = useState(wanted);

  // When the zone last stepped aside for a real signal, or `null` if it never
  // has in this session. A timestamp rather than a countdown, so a return that
  // waits on the pointer resumes the same clock instead of restarting one.
  const yieldedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!wanted) {
      // **The yield, and it is unconditional.** No floor, no pointer check, no
      // timer: a permission prompt or a streaming turn takes this slot on the
      // frame it exists, which is the precedence the zone system is built on.
      //
      // The synchronous `setState` here is the same shape `use-all-clear-beat`
      // uses for the same reason — a flag whose value is a fact about a
      // transition between two models, which a component handed one model
      // cannot see. It runs only on the transition, never on the steady state.
      if (showing) {
        yieldedAt.current = Date.now();
        setShowing(false);
      }
      return;
    }
    // Already back. Nothing to time, and nothing that could put it away again
    // except a signal, which is the branch above.
    if (showing) return;
    // Deferred while the operator is in here. No timer is left running: this
    // effect re-runs when they leave, and the floor is recomputed from
    // `yieldedAt` then, so waiting under the pointer still counts as waiting.
    if (inside) return;

    const waited =
      yieldedAt.current === null ? Number.POSITIVE_INFINITY : Date.now() - yieldedAt.current;
    // `Infinity` is the first appearance — the zone has never yielded, so this
    // is not a return and there is nothing to damp. Day one must not open onto
    // five seconds of empty sidebar.
    if (waited >= GETTING_STARTED_RETURN_FLOOR_MS) {
      setShowing(true);
      return;
    }

    // The remainder, not the whole floor. The effect's dependencies are three
    // booleans, so an activity storm re-renders the panel without re-running
    // this and cannot keep pushing the return away; but if one of them does
    // change, the reschedule below starts from the timestamp rather than from
    // zero, and the deadline stays where it was.
    const timer = setTimeout(() => setShowing(true), GETTING_STARTED_RETURN_FLOOR_MS - waited);
    return () => clearTimeout(timer);
  }, [wanted, showing, inside]);

  const damped = useMemo(() => {
    if (!wanted || showing) return model;
    return { ...model, zones: model.zones.filter((zone) => zone.id !== 'getting-started') };
  }, [model, wanted, showing]);

  return { model: damped, handlers };
}
