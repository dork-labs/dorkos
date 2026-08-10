/**
 * The all-clear beat: Now settles before it folds away (BC-50).
 *
 * @module features/dashboard-sidebar/model/use-all-clear-beat
 */
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import type { SidebarModel } from './build-sidebar-model';

/**
 * How long "All clear ✓" stays before the zone folds away.
 *
 * 2.5 seconds, from BC-50 — long enough to register as an answer to the work
 * just finished, short enough that nobody waits for it.
 */
export const ALL_CLEAR_BEAT_MS = 2_500;

/**
 * How many rows in Now are things that actually need the operator.
 *
 * The working rollup is not one of them: a zone holding only "6 working" has
 * nothing waiting in it, so its rows draining to zero is not a queue being
 * finished and must not produce a beat.
 *
 * @param model - The model as built.
 */
function needsYouCount(model: SidebarModel): number {
  const now = model.zones.find((zone) => zone.id === 'now');
  if (now === undefined) return 0;
  return now.sections
    .flatMap((section) => section.rows)
    .filter((row) => row.target.kind === 'attention').length;
}

/**
 * Whether Now should be showing its all-clear beat right now.
 *
 * The beat exists because a zone that simply vanishes gives an operator no
 * moment of having finished; the sidebar's own disappearance is the reward, and
 * it needs half a breath to be read as one.
 *
 * Fires on ONE transition and no other: the last needs-you row leaving while
 * nothing else keeps the zone alive. In particular it does not fire when Now
 * was only ever a working rollup, and it cannot fire on first paint — there is
 * no previous frame to have held anything, which is what makes "an empty
 * fixture renders zero DOM nodes" (P2 AC-1) true on mount as well as at rest.
 *
 * **Under `prefers-reduced-motion` it never fires at all.** The beat is a
 * flourish about something that already happened, not information the operator
 * would otherwise be missing, so suppressing it costs nothing (spec R2).
 *
 * @param model - The model as built, this frame.
 */
export function useAllClearBeat(model: SidebarModel): boolean {
  const reducedMotion = useReducedMotion();
  const [beating, setBeating] = useState(false);
  const previousCount = useRef(needsYouCount(model));

  const count = needsYouCount(model);
  const hasNowZone = model.zones.some((zone) => zone.id === 'now');

  useEffect(() => {
    const before = previousCount.current;
    previousCount.current = count;
    if (reducedMotion === true) return;
    if (before === 0 || count > 0 || hasNowZone) return;
    setBeating(true);
    const timer = setTimeout(() => setBeating(false), ALL_CLEAR_BEAT_MS);
    return () => clearTimeout(timer);
  }, [count, hasNowZone, reducedMotion]);

  return beating;
}
