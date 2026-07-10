/**
 * A board mark that draws itself. `X` lands as two SVG strokes drawn in
 * sequence; `O` sweeps a single circular stroke; any other glyph (or an icon
 * mark) falls back to a spring scale-in. A mark with no glyph at all renders a
 * neutral filled dot so an optimistic click still visibly "takes".
 *
 * The two classic marks carry distinct default colors ({@link defaultMarkColorClass}
 * — X in vivid info blue, O in vivid warning amber; a colorblind-safe pairing,
 * saturated in both themes) so the players read apart at a glance. Callers pass
 * the resolved class via `colorClass`; an explicit cell tone wins upstream.
 *
 * Every animation is gated on the caller's `motionOn` flag (reduced-motion →
 * final state instantly) and touches only stroke geometry / transform / opacity,
 * so it stays on the compositor at 60fps.
 *
 * @module features/gen-ui/ui/nodes/board/DrawnMark
 */
import { motion } from 'motion/react';
import type { Transition } from 'motion/react';
import { cn } from '@/layers/shared/lib';
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

/**
 * Default text-color class for a mark: anything drawn as an X gets vivid info
 * blue, anything drawn as an O gets vivid warning amber (case-insensitive on
 * the trimmed mark, matching {@link markShape}'s classification), other glyphs
 * get no default (`null` — they keep the cell's inherited color). Callers let
 * an explicit cell `tone` from the model win over this.
 *
 * @param mark - The raw mark string (e.g. `'X'`, `'o'`, `'⭕'`, `'★'`).
 */
export function defaultMarkColorClass(mark: string): string | null {
  const shape = markShape(mark);
  if (shape === 'x') return 'text-status-info';
  if (shape === 'o') return 'text-status-warning';
  return null;
}

/** Common stroke styling for the drawn X/O paths. */
const strokeProps = {
  className: 'stroke-current',
  fill: 'none',
  strokeWidth: 2.75,
  strokeLinecap: 'round',
} as const;

function DrawnX({ motionOn, colorClass }: { motionOn: boolean; colorClass?: string }) {
  const draw = (delay: number): Transition => ({
    duration: X_STROKE_DURATION,
    ease: WIDGET_EASE_OUT,
    delay,
  });
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={cn('size-[1.15em]', colorClass)}
      aria-hidden
      focusable="false"
    >
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

function DrawnO({ motionOn, colorClass }: { motionOn: boolean; colorClass?: string }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={cn('size-[1.15em]', colorClass)}
      aria-hidden
      focusable="false"
    >
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
 * @param colorClass - Text-color class for the mark (typically
 *   {@link defaultMarkColorClass}'s result); omit to inherit the cell's color.
 */
export function DrawnMark({
  mark,
  motionOn,
  colorClass,
}: {
  mark: string;
  motionOn: boolean;
  colorClass?: string;
}) {
  if (!mark.trim()) return <NeutralDot motionOn={motionOn} />;
  const shape = markShape(mark);
  if (shape === 'x') return <DrawnX motionOn={motionOn} colorClass={colorClass} />;
  if (shape === 'o') return <DrawnO motionOn={motionOn} colorClass={colorClass} />;
  // Any other glyph/emoji: a clean spring scale-in.
  return (
    <motion.span
      aria-hidden
      className={cn('block leading-none', colorClass)}
      initial={motionOn ? { scale: 0.4, opacity: 0 } : false}
      animate={motionOn ? { scale: 1, opacity: 1 } : false}
      transition={motionOn ? WIDGET_SPRING : undefined}
    >
      {mark}
    </motion.span>
  );
}
