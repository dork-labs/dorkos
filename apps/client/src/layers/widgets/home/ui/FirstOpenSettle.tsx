import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useFirstOpenOfDay } from '../model/use-first-open-of-day';

/**
 * The day's first look at Home, settling in.
 *
 * A single calm fade, once per local day (team-room-home spec D3.6, design
 * record §6). Opening the app in the morning should feel like a room coming into
 * focus rather than a dashboard being switched on; every other visit that day
 * appears instantly, because a welcome you have already had is just a wait.
 *
 * **A fade, and only a fade.** No slide, no lift: a `transform` on this element
 * would make it the containing block for any fixed-position descendant for the
 * length of the animation, and this wraps a whole room — composer, notices,
 * panels. Opacity buys the same settle and cannot move anything.
 *
 * **The two-beat version waits for something to say.** The design record asks
 * for a greeting to land before the content does. There is no greeting element
 * on this surface yet — the moments and welcome-back posts that will be it are
 * Phase 4 (spec D5) — so the honest light version today is one beat: the whole
 * surface, arriving together. A stagger between chrome and feed with nothing
 * different to show in the first beat would be motion for its own sake.
 *
 * Reduced motion gets the surface immediately, with no animation at all.
 *
 * @param props - The surface to settle.
 */
export function FirstOpenSettle({ children }: { children: ReactNode }) {
  const firstToday = useFirstOpenOfDay();
  const reducedMotion = useReducedMotion();
  const settles = firstToday && reducedMotion !== true;

  return (
    <motion.div
      className="h-full"
      // `false` skips the enter animation outright rather than running a
      // zero-length one, so an ordinary visit paints at full opacity on its
      // first frame.
      initial={settles ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.45, ease: [0, 0, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
