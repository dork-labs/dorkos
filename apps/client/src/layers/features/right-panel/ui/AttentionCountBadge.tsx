import { motion, useReducedMotion } from 'motion/react';
import { CountPill } from '@/layers/shared/ui';

interface AttentionCountBadgeProps {
  /** How many items currently need the operator. */
  count: number;
}

/**
 * The entrance: opacity and a small scale up from 0.9, critically damped so it
 * lands without overshoot. Not from 0: a count that grows out of nothing reads
 * as a pop, and this only has to say "this just arrived".
 */
const ENTRANCE = { type: 'spring', stiffness: 500, damping: 40 } as const;

/**
 * The count that rides the right-panel toggle's corner: how many items need
 * the operator while the panel is closed.
 *
 * Honest by design: it renders NOTHING at zero. Amber, because every one of
 * these is something stopped and waiting on a person, and capped at `9+` as
 * every corner count is. The pill is purely visual (`aria-hidden`); the
 * accessible count lives in the toggle button's own `aria-label`.
 *
 * Positioned by its parent (the toggle button is `relative`). Under reduced
 * motion it is simply there, with no fade and no scale.
 *
 * @param props - The current needs-attention {@link AttentionCountBadgeProps.count}.
 */
export function AttentionCountBadge({ count }: AttentionCountBadgeProps) {
  const reducedMotion = useReducedMotion();
  if (count <= 0) return null;

  return (
    <motion.span
      initial={reducedMotion ? false : { scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={ENTRANCE}
      className="pointer-events-none absolute -top-1 -right-1"
    >
      <CountPill
        data-testid="right-panel-attention-badge"
        count={count}
        tone="warning"
        placement="corner"
        className="static"
      />
    </motion.span>
  );
}
