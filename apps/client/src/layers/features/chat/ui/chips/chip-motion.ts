/**
 * The motion vocabulary the chip surfaces share.
 *
 * Timing and easing are ported from the design record's mockups
 * (`specs/chat-touch-chips/mockups/03-chips-v2-hybrid.html`), not copied: the
 * mockups loop forever to demonstrate themselves, while every value here is
 * spent once, on a state change the transcript actually produced.
 *
 * Two rules decide everything in this file. **Motion means in-progress**, so
 * nothing here loops on a settled chip. And **motion stays inside the strip**,
 * so no value moves a neighbour: arrivals move the chip itself, absorption
 * shrinks it away inside a clipped row, and the only height that animates is
 * the row's own as it collapses into the summary line.
 *
 * @module features/chat/ui/chips/chip-motion
 */
import type { MotionProps, SpringOptions, Transition } from 'motion/react';

/** How many chips stay in the live row; older ones are absorbed into the pile. */
export const LIVE_WINDOW = 4;

/**
 * The message list's collapse curve, shared so the strip settles on the same
 * beat as a tool card auto-hiding above it.
 */
const EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

/** Arrival: a spring with just enough overshoot to read as a landing. */
export const CHIP_POP_IN: Transition = { type: 'spring', stiffness: 320, damping: 28 };

/** Absorption: the chip shrinks leftward toward the pile, and is gone. */
export const CHIP_ABSORB: Transition = { duration: 0.25, ease: EASE };

/** Where an absorbed chip goes — toward the pile on the left, small and gone. */
export const CHIP_ABSORB_TO = { x: -16, scale: 0.45, opacity: 0 };

/** The plain fade that replaces every chip movement when a reader asks for less motion. */
export const CHIP_FADE: Transition = { duration: 0.15, ease: EASE };

/** The live row collapsing into the settled line, and the line fading in behind it. */
export const CHIP_SETTLE: Transition = { duration: 0.3, ease: EASE };

/** The icon's read→edit flip. Half the settle, so the morph is over before it is noticed. */
export const CHIP_MORPH: Transition = { duration: 0.15, ease: EASE };

/** One expanding ring, the whole of the upgrade's punctuation. */
export const CHIP_RING: Transition = { duration: 0.3, ease: EASE };

/**
 * The diffstat climbing to a new count. Critically damped on purpose: a count
 * that overshoots shows a number of lines the edit did not add, and a diffstat
 * that lies for 80ms is worse than one that simply arrives.
 */
export const DIFFSTAT_TICK: SpringOptions = { stiffness: 220, damping: 30 };

/** The pile acknowledging a landing: a nudge and a settle, never a shake. */
export const PILE_WOBBLE: MotionProps['animate'] = {
  rotate: [0, -4, 3, 0],
  scale: [1, 1.08, 1, 1],
};

/** The wobble's beat, ported from the mockup's `p-wob` keyframe. */
export const PILE_WOBBLE_TRANSITION: Transition = { duration: 0.3, ease: EASE };

/**
 * The arrival and absorption a chip in the live row plays.
 *
 * A chip anywhere else — the tray's roster, a playground showcase — gets nothing
 * at all: those chips are a record being read, not a thing arriving, and twenty
 * of them springing in at once is noise rather than information.
 *
 * @param animated - Whether this chip lives in the live row.
 * @param reducedMotion - Whether the reader has asked for less motion.
 * @returns Motion props to spread onto the chip's root, empty when it is still.
 */
export function chipEntryMotion(animated: boolean, reducedMotion: boolean): MotionProps {
  if (!animated) return {};
  if (reducedMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0, transition: CHIP_FADE },
      transition: CHIP_FADE,
    };
  }
  return {
    initial: { opacity: 0, y: 7 },
    animate: { opacity: 1, y: 0 },
    exit: { ...CHIP_ABSORB_TO, transition: CHIP_ABSORB },
    transition: CHIP_POP_IN,
  };
}
