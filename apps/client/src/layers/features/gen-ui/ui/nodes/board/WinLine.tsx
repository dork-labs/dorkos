/**
 * The victory stroke — an animated line drawn through the winning cells of a
 * completed board. Rendered as an absolutely-positioned SVG overlay spanning the
 * grid, so it never perturbs the grid's layout. Draws on mount, after the cells
 * have settled.
 *
 * @module features/gen-ui/ui/nodes/board/WinLine
 */
import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { WinLine as WinLineData } from '../../../lib/board-lines';
import { WIDGET_EASE_OUT } from '../../../lib/widget-motion';

/** Seconds to wait before drawing, so the cells finish landing first. */
const WIN_LINE_DELAY = 0.28;
/** Seconds to draw the stroke across the board (~300ms). */
const WIN_LINE_DURATION = 0.3;
/**
 * Stroke thickness as a fraction of one cell's edge. The viewBox is in cell
 * units (a cell is ~2.5–3.25 units), so an absolute `strokeWidth` would be a
 * huge fraction of the board — a hardcoded 2.25 once rendered as a bar covering
 * ~70% of a cell's height (the "giant pill" bug). ~12% reads as a pen stroke.
 */
const WIN_STROKE_CELL_FRACTION = 0.12;
/** Slightly translucent so the marks underneath stay visible through the stroke. */
const WIN_STROKE_OPACITY = 0.8;

interface WinLineProps {
  win: WinLineData;
  /** Board size (square: rows === columns). */
  size: number;
  /** Cell edge length in the shared unit system (matches the grid's `minmax`). */
  cellUnit: number;
  /** Gap between cells in the same unit system. */
  gapUnit: number;
  /** Text-color class the stroke inherits via `stroke-current` (winning tone). */
  colorClass: string;
  motionOn: boolean;
}

/** Center coordinate of cell index `i` along one axis, in overlay units. */
function center(i: number, cellUnit: number, gapUnit: number): number {
  return i * (cellUnit + gapUnit) + cellUnit / 2;
}

/**
 * Draw the winning line through the first and last cells of the detected line.
 * The overlay's viewBox mirrors the grid's real geometry (cell + gap units), so
 * the endpoints land dead-center on their cells at any root font size.
 */
export function WinLine({ win, size, cellUnit, gapUnit, colorClass, motionOn }: WinLineProps) {
  const extent = size * cellUnit + (size - 1) * gapUnit;
  const first = win.cells[0];
  const last = win.cells[win.cells.length - 1];
  const x1 = center(first.col, cellUnit, gapUnit);
  const y1 = center(first.row, cellUnit, gapUnit);
  const x2 = center(last.col, cellUnit, gapUnit);
  const y2 = center(last.row, cellUnit, gapUnit);

  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      className={cn('pointer-events-none absolute inset-0 h-full w-full', colorClass)}
      aria-hidden
      focusable="false"
    >
      <motion.line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className="stroke-current"
        strokeWidth={cellUnit * WIN_STROKE_CELL_FRACTION}
        strokeOpacity={WIN_STROKE_OPACITY}
        strokeLinecap="round"
        initial={motionOn ? { pathLength: 0, opacity: 0 } : false}
        animate={motionOn ? { pathLength: 1, opacity: 1 } : false}
        transition={
          motionOn
            ? {
                pathLength: {
                  duration: WIN_LINE_DURATION,
                  ease: WIDGET_EASE_OUT,
                  delay: WIN_LINE_DELAY,
                },
                opacity: { duration: 0.12, delay: WIN_LINE_DELAY },
              }
            : undefined
        }
      />
    </svg>
  );
}
