'use client';

/**
 * Logo13 — "DOS" spelled in square-module construction.
 *
 * Each letter is built from 12×12 filled squares arranged on a strict grid
 * with 2px gaps between modules. Module cell pitch = 14px (12px fill + 2px gap).
 * Letter canvas: 5 columns × 7 rows per letter. Inter-letter gap: 2 columns.
 * Total width: 3 letters × 5 cols + 2 gaps × 2 cols = 19 cols.
 * Height: 7 rows.
 * Canvas in module-units: 19 × 7 → px: 19×14 × 7×14 = 266 × 98 plus 1 gap.
 * ViewBox padded to 280 × 112 to add breathing room.
 */

const MODULE = 12; // filled square side
const GAP = 2; // gap between modules
const PITCH = MODULE + GAP; // 14px per cell

/** Render a single filled square module at grid column c, row r, offset by ox/oy. */
function mod(c: number, r: number, ox: number, oy: number) {
  return { x: ox + c * PITCH, y: oy + r * PITCH };
}

interface ModuleSquareProps {
  x: number;
  y: number;
  fill?: string;
}

function ModuleSquare({ x, y, fill = '#000' }: ModuleSquareProps) {
  return <rect x={x} y={y} width={MODULE} height={MODULE} fill={fill} />;
}

/**
 * Render an array of [col, row] grid positions as module squares.
 * ox/oy = pixel offset for the letter's origin.
 */
function Letter({ cells, ox, oy }: { cells: [number, number][]; ox: number; oy: number }) {
  return (
    <>
      {cells.map(([c, r]) => {
        const { x, y } = mod(c, r, ox, oy);
        return <ModuleSquare key={`${c}-${r}`} x={x} y={y} />;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Letter definitions — 5-wide × 7-tall grids, 0-indexed [col, row]
// ---------------------------------------------------------------------------

/**
 * D
 * █ █ █ █ .
 * █ . . . █
 * █ . . . █
 * █ . . . █
 * █ . . . █
 * █ . . . █
 * █ █ █ █ .
 */
const CELLS_D: [number, number][] = [
  // top bar (cols 0-3)
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  // left column (rows 1-5)
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  // right cap (rows 1-5, col 4)
  [4, 1],
  [4, 2],
  [4, 3],
  [4, 4],
  [4, 5],
  // bottom bar (cols 0-3)
  [0, 6],
  [1, 6],
  [2, 6],
  [3, 6],
];

/**
 * O
 * . █ █ █ .
 * █ . . . █
 * █ . . . █
 * █ . . . █
 * █ . . . █
 * █ . . . █
 * . █ █ █ .
 */
const CELLS_O: [number, number][] = [
  // top bar (cols 1-3)
  [1, 0],
  [2, 0],
  [3, 0],
  // left column (rows 1-5)
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  // right column (rows 1-5)
  [4, 1],
  [4, 2],
  [4, 3],
  [4, 4],
  [4, 5],
  // bottom bar (cols 1-3)
  [1, 6],
  [2, 6],
  [3, 6],
];

/**
 * S
 * . █ █ █ █
 * █ . . . .
 * █ . . . .
 * . █ █ █ .
 * . . . . █
 * . . . . █
 * █ █ █ █ .
 */
const CELLS_S: [number, number][] = [
  // top bar (cols 1-4)
  [1, 0],
  [2, 0],
  [3, 0],
  [4, 0],
  // top-left column (rows 1-2)
  [0, 1],
  [0, 2],
  // middle bar (cols 1-3)
  [1, 3],
  [2, 3],
  [3, 3],
  // bottom-right column (rows 4-5)
  [4, 4],
  [4, 5],
  // bottom bar (cols 0-3)
  [0, 6],
  [1, 6],
  [2, 6],
  [3, 6],
];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Each letter is 5 columns wide. Gap between letters = 2 columns = 2 * PITCH.
const LETTER_WIDTH_PX = 5 * PITCH; // 70px
const INTER_LETTER_PX = 2 * PITCH; // 28px

const PAD_X = 8; // horizontal padding
const PAD_Y = 8; // vertical padding

const OX_D = PAD_X;
const OX_O = OX_D + LETTER_WIDTH_PX + INTER_LETTER_PX;
const OX_S = OX_O + LETTER_WIDTH_PX + INTER_LETTER_PX;

const LETTER_HEIGHT_PX = 7 * PITCH; // 98px

const VIEWBOX_W = OX_S + LETTER_WIDTH_PX + PAD_X; // ~8 + 70 + 28 + 70 + 28 + 70 + 8 = 282
const VIEWBOX_H = LETTER_HEIGHT_PX + PAD_Y * 2; // 98 + 16 = 114

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Logo13() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
      aria-label="DOS"
      role="img"
    >
      <title>DOS</title>
      <Letter cells={CELLS_D} ox={OX_D} oy={PAD_Y} />
      <Letter cells={CELLS_O} ox={OX_O} oy={PAD_Y} />
      <Letter cells={CELLS_S} ox={OX_S} oy={PAD_Y} />
    </svg>
  );
}
