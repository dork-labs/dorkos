/**
 * The pile — where a chip goes when it ages out of the live row.
 *
 * @module features/chat/ui/chips/ChipPile
 */
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { TouchChip as TouchChipData } from '../../lib/touch-chips';
import { PILE_WOBBLE, PILE_WOBBLE_TRANSITION } from './chip-motion';
import { VERB_ICON } from './chip-verbs';

/** How many chips the stack draws. Everything else is in the count, and in the tray. */
const STACK_DEPTH = 3;

/**
 * Each layer of the stack: the newest on top and fully lit, the ones behind it
 * overlapped and dimmer, so depth reads as age.
 */
const STACK_LAYER = ['z-30', '-ml-2 z-20 opacity-70', '-ml-2 z-10 opacity-45'];

export interface ChipPileProps {
  /** The chips that have aged out of the live row, oldest first. */
  chips: TouchChipData[];
  /** Whether the tray this pile opens is currently open. */
  expanded: boolean;
  /** DOM id of the tray, for `aria-controls`. */
  controls: string;
  /** Open or close the tray. */
  onExpand: () => void;
}

/**
 * The turn's growing record, as a thing rather than a number: a small stack of
 * the chips that have left the live row, with a running count and one click
 * target that fans the whole roster open.
 *
 * The stack wobbles once each time a chip lands on it — a landing being
 * acknowledged, not a loop. It is keyed on the count so exactly one wobble is
 * spent per arrival, and none at all when the reader has asked for less motion.
 *
 * A pile never shrinks: a turn only ever touches more things, so a chip that has
 * landed here stays counted.
 *
 * @param props - The absorbed chips, the tray's state, and the toggle.
 */
export function ChipPile({ chips, expanded, controls, onExpand }: ChipPileProps) {
  const reducedMotion = useReducedMotion() ?? false;
  // Newest first, so the chip that just landed is the one on top.
  const stack = chips.slice(-STACK_DEPTH).reverse();

  return (
    <button
      type="button"
      data-testid="chip-pile"
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={`Show everything this turn touched (${chips.length} more)`}
      onClick={onExpand}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full py-0.5 pr-1.5 pl-0.5',
        'hover:bg-accent focus-visible:ring-ring/50 outline-none focus-visible:ring-2'
      )}
    >
      <motion.span
        // One wobble per landing: a new count is a new element, and a new
        // element plays the keyframes once.
        key={chips.length}
        animate={reducedMotion ? { rotate: 0, scale: 1 } : PILE_WOBBLE}
        transition={PILE_WOBBLE_TRANSITION}
        className="flex origin-bottom items-center"
      >
        {stack.map((chip, index) => (
          <span
            key={chip.key}
            aria-hidden="true"
            className={cn(
              'bg-card border-border flex size-5 items-center justify-center rounded-full border text-3xs leading-none',
              STACK_LAYER[index]
            )}
          >
            {VERB_ICON[chip.verb]}
          </span>
        ))}
      </motion.span>
      <span
        data-testid="chip-pile-count"
        className="bg-primary text-primary-foreground rounded-full px-1.5 text-3xs tabular-nums"
      >
        {chips.length}
      </span>
    </button>
  );
}
