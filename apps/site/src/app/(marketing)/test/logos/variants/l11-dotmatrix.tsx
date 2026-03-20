'use client';

/**
 * Logo11 — "DORK" rendered as an LED dot-matrix electronic display.
 *
 * Each character occupies a 5-column × 7-row grid of rounded LED cells.
 * Active dots use a solid black fill; the full inactive grid is rendered
 * at low opacity to give the characteristic "unlit LED" look of real
 * display boards. A thin border around the panel completes the effect.
 *
 * Dot size: 6×6 px with rx=1.5 for a soft-square shape.
 * Dot pitch (cell size): 8 px → 2 px gap between adjacent dots.
 * Letter spacing: 10 px gap between character grids.
 * ViewBox: 400×100 — characters are centred vertically in the panel.
 */

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Size of each LED square (logical units). */
const DOT = 6;

/** Distance from the start of one dot to the start of the next (pitch). */
const PITCH = 8; // 6 px dot + 2 px gap

/** Corner radius on each LED square. */
const RX = 1.5;

/** Number of columns per character glyph. */
const COLS = 5;

/** Number of rows per character glyph. */
const ROWS = 7;

/** Horizontal gap (in logical units) inserted between adjacent character grids. */
const LETTER_GAP = 10;

/** Width of a single character grid (all columns + internal gaps). */
const CHAR_GRID_W = COLS * PITCH - (PITCH - DOT); // = COLS*PITCH - gap = 5*8-2 = 38

/** Height of a single character grid. */
const CHAR_GRID_H = ROWS * PITCH - (PITCH - DOT); // = 7*8-2 = 54

/** Top margin so glyphs sit centred in the 100-unit-tall viewBox. */
const TOP = Math.round((100 - CHAR_GRID_H) / 2); // = 23

/** Left margin. */
const LEFT = 20;

// ---------------------------------------------------------------------------
// Classic 5×7 LED dot-matrix bitmaps
// Row 0 = topmost row; column 0 = leftmost column.
// Each row uses 1/0 for on/off; Boolean() converts at use-site.
// ---------------------------------------------------------------------------

/** D */
const GLYPH_D: number[][] = [
  [1, 1, 1, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 1, 0],
  [1, 1, 1, 0, 0],
];

/** O */
const GLYPH_O: number[][] = [
  [0, 1, 1, 1, 0],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0],
];

/** R */
const GLYPH_R: number[][] = [
  [1, 1, 1, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 0, 1, 0],
  [1, 1, 1, 0, 0],
  [1, 0, 1, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 0, 0, 1],
];

/** K */
const GLYPH_K: number[][] = [
  [1, 0, 0, 0, 1],
  [1, 0, 0, 1, 0],
  [1, 0, 1, 0, 0],
  [1, 1, 0, 0, 0],
  [1, 0, 1, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 0, 0, 1],
];

/** All four glyphs in display order. */
const GLYPHS: number[][][] = [GLYPH_D, GLYPH_O, GLYPH_R, GLYPH_K];

// ---------------------------------------------------------------------------
// X-origin for each character
// ---------------------------------------------------------------------------

const CHAR_ORIGINS: number[] = GLYPHS.map((_, i) => {
  return LEFT + i * (CHAR_GRID_W + LETTER_GAP);
});

/** Total width used by all glyphs + gaps (used for the panel border). */
const PANEL_W = CHAR_ORIGINS[CHAR_ORIGINS.length - 1]! + CHAR_GRID_W - LEFT + LEFT;

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * Render every dot in the inactive grid for one character (low opacity).
 *
 * @param xOrigin - Left edge of the character's dot grid
 */
function renderInactiveDots(xOrigin: number): React.ReactNode[] {
  const dots: React.ReactNode[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      dots.push(
        <rect
          key={`${row}-${col}`}
          x={xOrigin + col * PITCH}
          y={TOP + row * PITCH}
          width={DOT}
          height={DOT}
          rx={RX}
          ry={RX}
          fill="#000"
          fillOpacity={0.08}
        />
      );
    }
  }
  return dots;
}

/**
 * Render the active (lit) dots for one character glyph.
 *
 * @param glyph   - 7×5 bitmap where 1 = lit dot
 * @param xOrigin - Left edge of the character's dot grid
 */
function renderActiveDots(glyph: number[][], xOrigin: number): React.ReactNode[] {
  const dots: React.ReactNode[] = [];
  glyph.forEach((row, rowIdx) => {
    row.forEach((on, colIdx) => {
      if (!on) return;
      dots.push(
        <rect
          key={`${rowIdx}-${colIdx}`}
          x={xOrigin + colIdx * PITCH}
          y={TOP + rowIdx * PITCH}
          width={DOT}
          height={DOT}
          rx={RX}
          ry={RX}
          fill="#000"
        />
      );
    });
  });
  return dots;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * LED dot-matrix logo spelling "DORK".
 *
 * Renders a classic electronic display panel with a 5×7 dot grid per letter.
 * Active LEDs are solid black; inactive LEDs ghost at 8% opacity.
 *
 * @param width     - SVG intrinsic width (default 400)
 * @param height    - SVG intrinsic height (default 100)
 * @param className - Optional CSS class forwarded to the `<svg>` element
 */
export function Logo11({
  width = 400,
  height = 100,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 400 100"
      width={width}
      height={height}
      className={className}
      aria-label="DORK"
      role="img"
    >
      {/* Panel border — thin rect that frames the whole display */}
      <rect
        x={LEFT - 8}
        y={TOP - 8}
        width={PANEL_W + 16}
        height={CHAR_GRID_H + 16}
        rx={3}
        ry={3}
        fill="none"
        stroke="#000"
        strokeWidth={1.5}
        strokeOpacity={0.18}
      />

      {/* Per-character dot grids */}
      {GLYPHS.map((glyph, i) => {
        const xOrigin = CHAR_ORIGINS[i]!;
        return (
          <g key={i}>
            {/* Unlit dot layer — gives the "empty LED cell" feel */}
            {renderInactiveDots(xOrigin)}
            {/* Lit dot layer */}
            {renderActiveDots(glyph, xOrigin)}
          </g>
        );
      })}
    </svg>
  );
}
