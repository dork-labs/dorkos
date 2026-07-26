import { motion, useReducedMotion } from 'motion/react';

/**
 * The composer's readout for "a second Escape will clear this".
 *
 * The first bare Escape does nothing a person can see — it only opens a 500ms
 * window — so the double-tap that wipes a draft was shipped and unreachable.
 * Nobody presses a key twice that appeared to do nothing once. This is the
 * missing representation of that window: it appears exactly when the second tap
 * would work and it is gone the instant it would not, because one timer in
 * `use-input-keyboard.ts` owns both.
 *
 * Deliberately not a live region and hidden from assistive tech. It fires on
 * every Escape, so announcing it would talk over whatever a screen-reader user
 * was listening to, several times a minute, to teach a shortcut for something
 * the labelled "Clear message" button already does.
 *
 * Floats above the composer in the same lane the command and file palettes use
 * — the one region that is guaranteed free here, since an Escape that closes a
 * palette never arms the clear — so it costs the resting composer no pixels and
 * moves nothing when it appears.
 */
export function ClearArmedHint() {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      // No exit animation on purpose: the window shuts at a known instant, and
      // a fading pill would still be claiming a shortcut that has stopped
      // working.
      initial={reducedMotion ? false : { opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      aria-hidden="true"
      data-testid="clear-armed-hint"
      className="bg-popover text-muted-foreground shadow-soft pointer-events-none absolute right-0 bottom-full z-10 mb-1.5 rounded-md border px-2 py-1 text-xs"
    >
      Press Esc again to clear
    </motion.div>
  );
}
