/**
 * "All clear ✓" — what the pinned section says on its way out.
 *
 * The sidebar's beat (`features/dashboard-sidebar/model/use-all-clear-beat`),
 * promoted to the Inbox by design decision §7.4 and kept component-local rather
 * than lifted: the two answer different questions ("did Heads up empty" versus
 * "did the pinned section empty while somebody was looking at it"), and a shared
 * hook would have to take both as parameters, which is a hook with two callers
 * and no idea.
 *
 * @module widgets/inbox-bell/model/use-pinned-drain-beat
 */
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';

/**
 * How long "All clear ✓" stays before the section folds away.
 *
 * 2.5 seconds, the same as the sidebar's — long enough to register as an answer
 * to the work just finished, short enough that nobody waits for it.
 */
export const ALL_CLEAR_BEAT_MS = 2_500;

/**
 * Whether the popover should be showing its all-clear beat right now.
 *
 * Fires on ONE transition and no other: the last pinned item leaving **while the
 * popover is open**. That condition is the whole point — the beat is the reward
 * for having just answered the last thing, and a beat played into a closed
 * popover is a beat nobody saw. Opening the popover later must not replay it,
 * which is why the count is only compared while `open` is true.
 *
 * **Under `prefers-reduced-motion` the VISIBLE beat never fires.** It is a
 * flourish about something that already happened, not information anybody would
 * otherwise be missing, so suppressing it costs nothing.
 *
 * `onDrain` is not suppressed with it, and that separation is deliberate:
 * reduced motion is a request about MOTION. Somebody who asked for less of it —
 * or who cannot see the check mark at all — should still hear the queue empty.
 *
 * @param count - How many things are pinned this frame.
 * @param open - Whether the popover is on screen.
 * @param onDrain - Called once each time the queue empties, motion or not. Read
 * through a ref, so a caller may pass a fresh closure without restarting the
 * watch.
 */
export function usePinnedDrainBeat(count: number, open: boolean, onDrain?: () => void): boolean {
  const reducedMotion = useReducedMotion();
  const [beating, setBeating] = useState(false);
  const previousCount = useRef(count);
  const onDrainRef = useRef(onDrain);
  onDrainRef.current = onDrain;

  useEffect(() => {
    const before = previousCount.current;
    previousCount.current = count;
    const drained = open && before > 0 && count === 0;
    const shouldBeat = reducedMotion !== true && drained;

    if (drained) onDrainRef.current?.();

    // Every path that is not a beat puts the flag down. React runs this effect's
    // cleanup before re-running it, so an early return would have cancelled the
    // timer that was going to lower the flag — leaving it stuck true with
    // nothing left to clear it. That is the defect the sidebar's own beat had to
    // fix, and it reaches here the same way: answer the last ask, and something
    // new arrives inside the next 2.5 seconds.
    if (!shouldBeat) {
      setBeating(false);
      return;
    }

    setBeating(true);
    const timer = setTimeout(() => setBeating(false), ALL_CLEAR_BEAT_MS);
    return () => clearTimeout(timer);
  }, [count, open, reducedMotion]);

  return beating;
}
