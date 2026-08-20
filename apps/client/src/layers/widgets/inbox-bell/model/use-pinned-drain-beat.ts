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
 * **Under `prefers-reduced-motion` it never fires at all.** It is a flourish
 * about something that already happened, not information anybody would otherwise
 * be missing, so suppressing it costs nothing.
 *
 * ## This is the VISIBLE beat only, and it has no sound in it
 *
 * The all-clear chime deliberately does not hang off this hook, and the reason
 * is the open-gate above. A check mark nobody can see is worth skipping; a sound
 * is not, because the whole point of a sound is that the person is not looking.
 * Answering the last thing from a keyboard shortcut, a phone banner, or the home
 * surface with this popover shut are exactly the moments the chime is for. So
 * the audio hangs off the queue draining app-wide, in
 * `features/notifications`'s `NotificationCenter`, and this stays what it always
 * was: one line of chrome inside one popover.
 *
 * @param count - How many things are pinned this frame.
 * @param open - Whether the popover is on screen.
 */
export function usePinnedDrainBeat(count: number, open: boolean): boolean {
  const reducedMotion = useReducedMotion();
  const [beating, setBeating] = useState(false);
  const previousCount = useRef(count);

  useEffect(() => {
    const before = previousCount.current;
    previousCount.current = count;
    const shouldBeat = reducedMotion !== true && open && before > 0 && count === 0;

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
