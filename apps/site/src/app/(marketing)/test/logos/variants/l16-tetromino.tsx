'use client';

/**
 * Logo16 — "DORK" spelled with Tetris-like tetromino block arrangements.
 *
 * Each letter is constructed from groups of 4 squares (tetromino pieces).
 * Squares are 18×18 px with a 2 px white gap between squares within each
 * tetromino group. Letters are laid out on a coarse grid with 10 px between
 * letters. ViewBox: 450×130.
 *
 * Tetromino types used:
 *   L-piece  — vertical + 1-2 horizontal extensions
 *   T-piece  — 3 in a row + 1 above/below center
 *   O-piece  — 2×2 square cluster
 *   I-piece  — 4 in a line (horizontal or vertical)
 *   S-piece  — 2 staggered pairs
 *   J-piece  — mirror of L
 */

/** Side length of one square cell in pixels. */
const SQ = 18;
/** White gap between squares within a tetromino piece. */
const GAP = 2;
/** Stride: distance from one cell origin to the next on the letter grid. */
const STRIDE = SQ + GAP;

/**
 * Render a single square at grid coordinates (col, row) offset by (ox, oy).
 *
 * @param col   - Column index on the letter's local grid
 * @param row   - Row index on the letter's local grid
 * @param ox    - X pixel offset of the letter origin
 * @param oy    - Y pixel offset of the letter origin
 * @param key   - React key
 */
function sq(col: number, row: number, ox: number, oy: number, key: string): React.ReactElement {
  return (
    <rect
      key={key}
      x={ox + col * STRIDE}
      y={oy + row * STRIDE}
      width={SQ}
      height={SQ}
      fill="#000"
    />
  );
}

/**
 * Render a tetromino piece — a group of exactly 4 [col, row] cells.
 *
 * @param cells  - Array of [col, row] coordinates (must have exactly 4 entries)
 * @param ox     - X pixel offset for the letter origin
 * @param oy     - Y pixel offset for the letter origin
 * @param id     - Unique string prefix for React keys
 */
function piece(cells: [number, number][], ox: number, oy: number, id: string): React.ReactElement {
  return <g key={id}>{cells.map(([c, r], i) => sq(c, r, ox, oy, `${id}-${i}`))}</g>;
}

// ---------------------------------------------------------------------------
// Letter definitions
//
// Each letter is an array of tetromino pieces.
// Each piece is an array of exactly 4 [col, row] cells.
// Grid origin is top-left of the letter bounding box.
// Letters are designed on a 5-col × 7-row coarse grid.
// ---------------------------------------------------------------------------

/**
 * Letter D — built from 5 tetromino pieces.
 *
 * Visual layout (5×7 grid, # = filled):
 *   # # # . .
 *   # . . # .
 *   # . . . #
 *   # . . . #
 *   # . . . #
 *   # . . # .
 *   # # # . .
 *
 * Pieces:
 *   Left spine (I-piece vertical, rows 0-3, col 0)
 *   Left spine lower (I-piece vertical, rows 4-6 with col 0 + corner)
 *   Top arch (L-piece: row 0 cols 0-2 + col 3 row 1)
 *   Right bulge (S/Z shape: col 4 rows 2-4 + col 3 rows 5)
 *   Bottom arch (J-piece: row 6 cols 0-2 + col 3 row 5)
 */
const LETTER_D: [number, number][][] = [
  // Piece 1: I-piece vertical — left spine top half (rows 0-3, col 0)
  [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ],
  // Piece 2: I-piece vertical — left spine bottom half (rows 4-6 + col 1 row 6)
  [
    [0, 4],
    [0, 5],
    [0, 6],
    [1, 6],
  ],
  // Piece 3: L-piece — top arch (row 0 cols 1-2 + col 3 row 1)
  [
    [1, 0],
    [2, 0],
    [3, 1],
    [3, 0],
  ],
  // Piece 4: T-piece — right bulge mid (col 4 rows 2-4 + col 3 row 3)
  [
    [4, 2],
    [4, 3],
    [4, 4],
    [3, 3],
  ],
  // Piece 5: J-piece — bottom arch (row 6 col 2 + col 3 row 5 + col 2 row 5)
  [
    [2, 6],
    [3, 5],
    [2, 5],
    [3, 6],
  ],
];

/**
 * Letter O — built from 5 tetromino pieces forming a hollow rectangle.
 *
 * Visual layout (5×7 grid):
 *   # # # # #
 *   # . . . #
 *   # . . . #
 *   # . . . #
 *   # . . . #
 *   # . . . #
 *   # # # # #
 *
 * Pieces:
 *   Top bar left (L-piece): cols 0-2 row 0 + col 0 row 1
 *   Top bar right (J-piece): cols 3-4 row 0 + col 4 row 1
 *   Left spine (I-piece vertical): col 0 rows 2-5
 *   Right spine (I-piece vertical): col 4 rows 2-5
 *   Bottom bar left + right (two O-pieces/S-shapes)
 */
const LETTER_O: [number, number][][] = [
  // Piece 1: L-piece — top-left corner (cols 0-2 row 0 + col 0 row 1)
  [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
  ],
  // Piece 2: J-piece — top-right corner (cols 3-4 row 0 + col 4 row 1)
  [
    [3, 0],
    [4, 0],
    [4, 1],
    [3, 1],
  ],
  // Piece 3: I-piece vertical — left spine (col 0 rows 2-5)
  [
    [0, 2],
    [0, 3],
    [0, 4],
    [0, 5],
  ],
  // Piece 4: I-piece vertical — right spine (col 4 rows 2-5)
  [
    [4, 2],
    [4, 3],
    [4, 4],
    [4, 5],
  ],
  // Piece 5: L-piece — bottom-left corner (col 0 row 6 + cols 1-2 row 6 + col 0 row 5 handled above)
  [
    [0, 6],
    [1, 6],
    [2, 6],
    [1, 5],
  ],
  // Piece 6: J-piece — bottom-right corner
  [
    [3, 6],
    [4, 6],
    [3, 5],
    [2, 5],
  ],
];

/**
 * Letter R — built from 5 tetromino pieces.
 *
 * Visual layout (5×7 grid):
 *   # # # # .
 *   # . . . #
 *   # . . . #
 *   # # # # .
 *   # . . # .
 *   # . . . #
 *   # . . . #
 *
 * Pieces:
 *   Left spine (I-piece vertical, col 0 rows 0-3)
 *   Left spine lower (I-piece vertical, col 0 rows 4-6 + extends)
 *   Top arch bar (T-piece and L combos)
 *   Right arch side + mid bar
 *   Diagonal leg (J/S shapes)
 */
const LETTER_R: [number, number][][] = [
  // Piece 1: I-piece vertical — left spine top (col 0 rows 0-3)
  [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ],
  // Piece 2: I-piece vertical — left spine bottom (col 0 rows 4-6 + leg start)
  [
    [0, 4],
    [0, 5],
    [0, 6],
    [1, 5],
  ],
  // Piece 3: L-piece — top bar (cols 1-3 row 0 + col 4 row 1)
  [
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 1],
  ],
  // Piece 4: T-piece — right arch (col 4 rows 1-2 + col 3 row 3 + col 4 row 2)
  [
    [4, 2],
    [3, 3],
    [2, 3],
    [1, 3],
  ],
  // Piece 5: S-piece — upper-right of arch (col 4 row 1 already used — use bump)
  [
    [3, 1],
    [3, 2],
    [4, 0],
    [4, 1],
  ],
  // Piece 6: L-piece — diagonal leg (col 2-4 rows 4-6)
  [
    [2, 4],
    [3, 5],
    [4, 6],
    [3, 4],
  ],
  // Piece 7: right-side leg filler
  [
    [4, 5],
    [4, 4],
    [2, 5],
    [2, 6],
  ],
];

/**
 * Letter K — built from 5 tetromino pieces.
 *
 * Visual layout (5×7 grid):
 *   # . . . #
 *   # . . # .
 *   # . # . .
 *   # # . . .
 *   # . # . .
 *   # . . # .
 *   # . . . #
 *
 * Pieces:
 *   Left spine (two I-pieces vertical)
 *   Upper arm diagonal (S/L pieces)
 *   Lower leg diagonal (Z/J pieces)
 */
const LETTER_K: [number, number][][] = [
  // Piece 1: I-piece vertical — left spine top (col 0 rows 0-3)
  [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ],
  // Piece 2: I-piece vertical — left spine bottom (col 0 rows 4-6 + junction)
  [
    [0, 4],
    [0, 5],
    [0, 6],
    [1, 3],
  ],
  // Piece 3: S-piece — upper arm upper (col 4 row 0 + col 3 row 1 + col 2 row 2)
  [
    [4, 0],
    [3, 1],
    [3, 0],
    [4, 1],
  ],
  // Piece 4: L-piece — upper arm lower (col 2 row 2 + col 1 row 2 + junction)
  [
    [2, 2],
    [1, 2],
    [2, 3],
    [1, 3],
  ],
  // Piece 5: L-piece — lower leg upper (col 1 row 4 + col 2 row 4 + col 2 row 5)
  [
    [1, 4],
    [2, 4],
    [2, 5],
    [1, 5],
  ],
  // Piece 6: S-piece — lower leg lower (col 3 row 5 + col 4 row 6)
  [
    [3, 5],
    [3, 6],
    [4, 6],
    [4, 5],
  ],
];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Width of each letter bounding box in grid columns. */
const LETTER_COLS = 5;
/** Width of one letter in pixels (5 columns of squares + gaps). */
const LETTER_PX_WIDTH = LETTER_COLS * STRIDE - GAP; // 5*20 - 2 = 98
/** Horizontal gap between adjacent letters in pixels. */
const LETTER_SPACING = 12;
/** Top padding inside the viewBox. */
const ORIGIN_Y = 15;
/** Left margin inside the viewBox. */
const ORIGIN_X = 10;

/** Letter definitions in display order. */
const LETTERS: { pieces: [number, number][][]; label: string }[] = [
  { pieces: LETTER_D, label: 'D' },
  { pieces: LETTER_O, label: 'O' },
  { pieces: LETTER_R, label: 'R' },
  { pieces: LETTER_K, label: 'K' },
];

/** Compute the X pixel origin for letter at index i. */
function letterOriginX(i: number): number {
  return ORIGIN_X + i * (LETTER_PX_WIDTH + LETTER_SPACING);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * DorkOS logo built from Tetris tetromino block arrangements.
 *
 * Each letter in "DORK" is assembled from groups of 4 squares (tetromino
 * pieces). Solid black fill with thin white gaps between individual squares
 * within each piece.
 */
export function Logo16({
  width = 450,
  height = 130,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 450 130"
      width={width}
      height={height}
      className={className}
      aria-label="DORK"
      role="img"
    >
      {LETTERS.map(({ pieces, label }, letterIdx) => {
        const ox = letterOriginX(letterIdx);
        return (
          <g key={label} aria-label={label}>
            {pieces.map((cells, pieceIdx) => piece(cells, ox, ORIGIN_Y, `${label}-p${pieceIdx}`))}
          </g>
        );
      })}
    </svg>
  );
}
