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
 * was listening to, several times a minute. That is only defensible because the
 * labelled "Clear message" button is the equal alternative, so the composer
 * refuses to raise the arm at all where that button is missing or disabled
 * (`clearReachable` in `ComposerInput.tsx`) — otherwise this would hand sighted
 * people a destructive shortcut and nobody else.
 *
 * Rendered by `Conversation.Composer` into the overlay lane it shares with the
 * command and file palettes, floating above the whole composer card, and NOT by
 * the text field that owns the state. Anchored to the field it would sit
 * directly on top of whatever is stacked above it: measured in a browser, it
 * landed squarely across the bottom queue row's Send-now and Remove buttons —
 * the one way out of a queue the flush pump cannot drain. Stacked in the lane
 * it costs the resting composer no pixels, moves nothing when it appears, and
 * shares the lane cleanly on the one occasion a palette is open at the same
 * time (arm on a bare Escape, then type `/` inside the window).
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
      className="bg-popover text-muted-foreground shadow-soft pointer-events-none mt-1.5 ml-auto w-fit rounded-md border px-2 py-1 text-xs"
    >
      Press Esc again to clear
    </motion.div>
  );
}
