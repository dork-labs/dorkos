/**
 * Loudness as a position rather than as a word.
 *
 * @module entities/room/ui/LoudnessMeter
 */
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib';
import type { LoudnessLevel } from '../lib/loudness';

/**
 * Only the container's height changes between sizes; the bars are fractions of
 * it. One rule covers every size, instead of a table of four heights per size
 * that has to be kept in proportion by hand.
 */
const loudnessMeterVariants = cva('inline-flex shrink-0 items-end gap-0.5', {
  variants: {
    size: {
      /** Inside a member's loudness pill, beside its label. */
      pill: 'h-3',
      /** On the room line, where one meter stands for the whole roster. */
      room: 'h-3.5',
      /** The room line while it is showing what a change would do. */
      preview: 'h-4',
    },
  },
  defaultVariants: { size: 'pill' },
});

/** The four bars, quietest first, as fractions of the meter's own height. */
const BAR_HEIGHTS = ['h-1/4', 'h-2/4', 'h-3/4', 'h-full'] as const;

export interface LoudnessMeterProps extends VariantProps<typeof loudnessMeterVariants> {
  /** How many bars are lit. `0` lights none — see {@link LoudnessLevel}. */
  level: LoudnessLevel;
  /**
   * Whether the setting behind this meter is real but not in effect — an
   * archived room triggers nobody. The bars still show where the agent stands,
   * in grey rather than in the brand colour.
   */
  dormant?: boolean;
  className?: string;
}

/** What one bar is painted with, given whether it is lit and whether it counts. */
function barTint(lit: boolean, dormant: boolean): string {
  if (!lit) return 'bg-muted-foreground/30';
  // Grey rather than unlit: the rung is still the stored setting and still what
  // this agent will do the moment the room comes back, so an empty meter would
  // be as false as a bright one.
  return dormant ? 'bg-muted-foreground/60' : 'bg-brand';
}

/**
 * Four ascending bars, lit up to a level.
 *
 * The point is the **position**. Five peer sentences could not be ranked by
 * anybody — that is the defect this whole scale replaces — and a rung's place on
 * a rising row of bars says louder-than and quieter-than without a word of help.
 * The same mark stands for one agent (in its pill) and for a whole room (on the
 * room line), which is what lets a person see one cause the other.
 *
 * **Decoration, and nothing in the accessibility tree.** A meter announcing
 * "3 of 4" beside a label that already says `Engaged` is the same fact twice,
 * and the second telling is the one nobody asked for. Every place this is drawn
 * has the words next to it; if one ever does not, that surface gives it a label,
 * rather than this growing one.
 *
 * The colour transitions, so changing a rung reads as the member's meter and the
 * room's meter moving as one system rather than as two separate repaints.
 *
 * **Whether a meter is dormant is the caller's to say.** `roomLoudness` knows
 * nothing about archived rooms, deliberately — it answers what a roster does,
 * and the room being retired is a fact about the room. The surface drawing the
 * meter is the one that has both.
 */
export function LoudnessMeter({ level, size, dormant = false, className }: LoudnessMeterProps) {
  return (
    <span
      aria-hidden
      data-slot="loudness-meter"
      data-dormant={dormant || undefined}
      className={cn(loudnessMeterVariants({ size }), className)}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <span
          key={height}
          className={cn(
            'w-0.5 rounded-full transition-colors',
            height,
            barTint(index < level, dormant)
          )}
        />
      ))}
    </span>
  );
}

export { loudnessMeterVariants };
