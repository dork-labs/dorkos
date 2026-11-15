import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib';

/** How a load reads while it runs: most of the way, never all of it (spec DOR-4420 §7). */
const RUN = { scaleX: 0.8, opacity: 1, transition: { duration: 2, ease: 'easeOut' } } as const;
/** A finished load completes the bar, then fades it. */
const FINISH = {
  scaleX: 1,
  opacity: 0,
  transition: { scaleX: { duration: 0.15 }, opacity: { duration: 0.15, delay: 0.15 } },
} as const;

/**
 * The browser's 2px loading line in the seam under its row (DOR-4431): no spinners. Ease-out
 * to 80% over 2s while loading, then all the way in 150ms and a 150ms fade. Under reduced
 * motion it is a still 2px line while loading. The seam keeps its 2px either way, so the
 * page under it never moves.
 */
export function BrowserLoadingBar({
  loading,
  className,
}: {
  loading: boolean;
  className?: string;
}) {
  const reduceMotion = useReducedMotion() === true;
  // A load that just ended keeps the bar until it has finished and faded.
  const [finishing, setFinishing] = useState(false);
  // Each new load starts the bar again from nothing.
  const [run, setRun] = useState(0);
  const [wasLoading, setWasLoading] = useState(loading);
  if (wasLoading !== loading) {
    setWasLoading(loading);
    setFinishing(!loading);
    if (loading) setRun(run + 1);
  }
  const shown = loading || (finishing && !reduceMotion);
  return (
    <div
      aria-hidden
      data-slot="browser-loading-seam"
      className={cn('relative h-0.5 w-full shrink-0 overflow-hidden', className)}
    >
      {shown &&
        (reduceMotion ? (
          <div data-slot="browser-loading-bar" className="bg-foreground/35 absolute inset-0" />
        ) : (
          <motion.div
            key={run}
            data-slot="browser-loading-bar"
            className="bg-foreground/35 absolute inset-0 origin-left"
            initial={{ scaleX: 0, opacity: 1 }}
            animate={loading ? RUN : FINISH}
            onAnimationComplete={() => {
              if (!loading) setFinishing(false);
            }}
          />
        ))}
    </div>
  );
}
