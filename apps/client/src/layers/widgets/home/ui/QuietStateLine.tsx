import { motion } from 'motion/react';

/** What {@link QuietStateLine} says. */
export interface QuietStateLineProps {
  /**
   * The forward look, when there is a real one — a scheduled run that is
   * genuinely on the books.
   *
   * `null` leaves the line at two words. A generic sentence in its place would
   * be the fake recap this whole state exists to avoid, so there is deliberately
   * no fallback string anywhere in this component.
   */
  forwardLook: string | null;
}

/**
 * "All quiet." — and, when there is one, what happens next.
 *
 * A morning where nothing happened is a real answer, and the honest way to give
 * it is to say so (team-room-home spec D3.6). No summary of a night with nothing
 * in it, no "here's what you missed" over an empty list, no reassurance card.
 * Two words, and then either a scheduled run with a real time on it or nothing
 * at all.
 *
 * One line above the feed rather than a post inside it, because it is a
 * statement about the room's current state rather than something that happened
 * in it — and a post would need an author, a timestamp and a place in the
 * history, none of which it has.
 *
 * Presentational: it is handed its sentence and draws it. Where that sentence
 * comes from — and whether the room is quiet at all — is
 * {@link HomeQuietState}'s business.
 *
 * @param props - The {@link QuietStateLineProps.forwardLook} sentence, or `null`.
 */
export function QuietStateLine({ forwardLook }: QuietStateLineProps) {
  return (
    <motion.div
      data-slot="home-quiet-state"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="border-border/60 shrink-0 border-b"
    >
      <p className="text-muted-foreground mx-auto w-full max-w-4xl px-4 py-2 text-xs sm:px-6">
        <span className="text-foreground/80 font-medium">All quiet.</span>
        {forwardLook !== null && <> {forwardLook}</>}
      </p>
    </motion.div>
  );
}
