/**
 * A board mark that draws itself. `X` lands as two SVG strokes drawn in
 * sequence; `O` sweeps a single circular stroke; any other glyph (or an icon
 * mark) falls back to a spring scale-in. A mark with no glyph at all renders a
 * neutral filled dot so an optimistic click still visibly "takes".
 *
 * Every animation is gated on the caller's `motionOn` flag (reduced-motion →
 * final state instantly) and touches only stroke geometry / transform / opacity,
 * so it stays on the compositor at 60fps.
 *
 * @module features/gen-ui/ui/nodes/board/DrawnMark
 */
import { motion } from 'motion/react';
import type { Transition } from 'motion/react';
import { WIDGET_EASE_OUT, WIDGET_SPRING } from '../../../lib/widget-motion';

/** Seconds to draw one stroke of an X; the second starts as the first finishes. */
const X_STROKE_DURATION = 0.12;
/** Seconds to sweep the O's circular stroke. */
const O_SWEEP_DURATION = 0.2;

/** Shared SVG canvas for every drawn mark — square, unstretched (safe for pathLength). */
const MARK_VIEWBOX = '0 0 24 24';

type MarkShape = 'x' | 'o' | 'glyph';

/** Classify a mark string into the shape we know how to draw. */
function markShape(mark: string): MarkShape {
  const m = mark.trim().toLowerCase();
  if (m === 'x') return 'x';
  if (m === 'o' || m === '0' || m === '⭕' || m === '◯') return 'o';
  return 'glyph';
}

/** Common stroke styling for the drawn X/O paths. */
const strokeProps = {
  className: 'stroke-current',
  fill: 'none',
  strokeWidth: 2.75,
  strokeLinecap: 'round',
} as const;

function DrawnX({ motionOn }: { motionOn: boolean }) {
  const draw = (delay: number): Transition => ({
    duration: X_STROKE_DURATION,
    ease: WIDGET_EASE_OUT,
    delay,
  });
  return (
    <svg viewBox={MARK_VIEWBOX} className="size-[1.15em]" aria-hidden focusable="false">
      <motion.path
        {...strokeProps}
        d="M7 7 L17 17"
        initial={motionOn ? { pathLength: 0 } : false}
        animate={motionOn ? { pathLength: 1 } : false}
        transition={motionOn ? draw(0) : undefined}
      />
      <motion.path
        {...strokeProps}
        d="M17 7 L7 17"
        initial={motionOn ? { pathLength: 0 } : false}
        animate={motionOn ? { pathLength: 1 } : false}
        transition={motionOn ? draw(X_STROKE_DURATION) : undefined}
      />
    </svg>
  );
}

function DrawnO({ motionOn }: { motionOn: boolean }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className="size-[1.15em]" aria-hidden focusable="false">
      <motion.circle
        {...strokeProps}
        cx={12}
        cy={12}
        r={6.5}
        // Start the sweep from 12 o'clock so it reads as a hand-drawn ring.
        transform="rotate(-90 12 12)"
        initial={motionOn ? { pathLength: 0 } : false}
        animate={motionOn ? { pathLength: 1 } : false}
        transition={motionOn ? { duration: O_SWEEP_DURATION, ease: WIDGET_EASE_OUT } : undefined}
      />
    </svg>
  );
}

/** A neutral placeholder mark — a solid dot that scale-pops into place. */
function NeutralDot({ motionOn }: { motionOn: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="bg-foreground/70 block size-[0.5em] rounded-full"
      initial={motionOn ? { scale: 0, opacity: 0 } : false}
      animate={motionOn ? { scale: 1, opacity: 1 } : false}
      transition={motionOn ? WIDGET_SPRING : undefined}
    />
  );
}

/**
 * Render a self-drawing board mark.
 *
 * @param mark - The mark string (`'X'`, `'O'`, an emoji/glyph, or empty for the
 *   neutral dot).
 * @param motionOn - Whether to animate (pass {@link useWidgetMotion}'s result).
 */
export function DrawnMark({ mark, motionOn }: { mark: string; motionOn: boolean }) {
  if (!mark.trim()) return <NeutralDot motionOn={motionOn} />;
  const shape = markShape(mark);
  if (shape === 'x') return <DrawnX motionOn={motionOn} />;
  if (shape === 'o') return <DrawnO motionOn={motionOn} />;
  // Any other glyph/emoji: a clean spring scale-in.
  return (
    <motion.span
      aria-hidden
      className="block leading-none"
      initial={motionOn ? { scale: 0.4, opacity: 0 } : false}
      animate={motionOn ? { scale: 1, opacity: 1 } : false}
      transition={motionOn ? WIDGET_SPRING : undefined}
    >
      {mark}
    </motion.span>
  );
}
