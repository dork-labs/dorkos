import { motion } from 'motion/react';

interface AttentionCountBadgeProps {
  /** How many items currently need the operator. */
  count: number;
}

/** Above this, the badge shows a capped "N+" instead of the raw count. */
const DISPLAY_CAP = 9;

/**
 * The small count pill that rides the right-panel toggle, showing how many items
 * need the operator's attention while the panel is closed.
 *
 * Honest by design: it renders NOTHING at zero — no decoration without signal.
 * The count caps its display at "{@link DISPLAY_CAP}+" so a large backlog stays a
 * single-glyph glance rather than a growing number. The pill is purely visual
 * (`aria-hidden`); the accessible count lives in the toggle button's own
 * `aria-label` (single source of truth, no double announcement).
 *
 * Positioned by its parent (the toggle button is `relative`); this component owns
 * only the pill itself and its subtle spring entrance — suppressed automatically
 * under the shell's `reducedMotion="user"` MotionConfig.
 *
 * @param props - The current needs-attention {@link AttentionCountBadgeProps.count}.
 */
export function AttentionCountBadge({ count }: AttentionCountBadgeProps) {
  if (count <= 0) return null;

  const display = count > DISPLAY_CAP ? `${DISPLAY_CAP}+` : String(count);

  return (
    <motion.span
      data-testid="right-panel-attention-badge"
      aria-hidden
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      className="bg-primary text-primary-foreground pointer-events-none absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-semibold tabular-nums"
    >
      {display}
    </motion.span>
  );
}
