'use client';

/**
 * Logo08 — "DOS" spelled in maze-corridor style.
 *
 * Each letter is constructed from solid black (#000) rectangular walls.
 * Narrow white corridors (~4 px) slice through the thick walls (~9 px) at
 * right angles, so the wall segments that remain form the letter outlines —
 * like a maze whose paths happen to trace the letterforms.
 *
 * Grid constants:
 *   WALL  = 9 px  — thickness of a solid wall segment
 *   GAP   = 4 px  — width of a corridor (transparent/white)
 *   UNIT  = 13 px — one maze cell (WALL + GAP)
 *
 * ViewBox: 400 × 130
 */

// ---------------------------------------------------------------------------
// Grid constants
// ---------------------------------------------------------------------------

/** Thickness of one wall stripe in pixels. */
const WALL = 9;
/** Width of one corridor (white gap) in pixels. */
const GAP = 4;
/** One maze cell = wall + corridor. */
const UNIT = WALL + GAP; // 13

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A horizontal wall stripe spanning [x, x+w) at vertical position y,
 * with height WALL. Used as the black "fill" of a maze wall row.
 */
function HWall({
  x,
  y,
  w,
}: {
  x: number;
  y: number;
  w: number;
}) {
  return <rect x={x} y={y} width={w} height={WALL} fill="#000" />;
}

/**
 * A vertical wall stripe spanning [y, y+h) at horizontal position x,
 * with width WALL.
 */
function VWall({
  x,
  y,
  h,
}: {
  x: number;
  y: number;
  h: number;
}) {
  return <rect x={x} y={y} width={WALL} height={h} fill="#000" />;
}

/**
 * A white corridor rectangle — cuts a passageway through existing walls.
 */
function Corridor({
  x,
  y,
  w,
  h,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  return <rect x={x} y={y} width={w} height={h} fill="white" />;
}

// ---------------------------------------------------------------------------
// Letter dimensions (all in pixels from their own local origin)
//
// Each letter sits in a bounding box:
//   D  — 80 px wide × 110 px tall
//   O  — 80 px wide × 110 px tall
//   S  — 75 px wide × 110 px tall
//
// The maze grid has cells of UNIT=13 px. Letters are designed on a
// 6-column × 8-row grid (6×13=78, 8×13=104) plus outer walls, fitting
// comfortably inside 80×110. All coordinates below are absolute (shifted
// by the letter's X offset).
// ---------------------------------------------------------------------------

/**
 * Render the letter "D" as a maze starting at x-offset `ox`, y-offset `oy`.
 *
 * Structure:
 *   - Left vertical wall (full height)
 *   - Top horizontal wall (full width)
 *   - Bottom horizontal wall (full width)
 *   - Right curved edge approximated as two stepped verticals + connecting bars
 *   - Interior: white cutout with horizontal corridor stripes running L→R
 *     and one vertical corridor on the left spine
 */
function LetterD({ ox, oy }: { ox: number; oy: number }) {
  // Letter bounding box: 80 wide, 110 tall
  // We design on a 6-col × 8-row cell grid (UNIT=13) with outer walls:
  //   Col positions (x):  ox+0, ox+13, ox+26, ox+39, ox+52, ox+65
  //   Row positions (y):  oy+0, oy+13, oy+26, oy+39, oy+52, oy+65, oy+78, oy+91
  //
  // "D" shape on this grid (wall=filled, gap=corridor):
  //   Left spine:  col 0, full height
  //   Top cap:     row 0, cols 0–4
  //   Bottom cap:  row 7+wall, cols 0–4
  //   Right curve (stepped rectangle approximation):
  //     col 4-5 rows 1–2  (top shoulder)
  //     col 5   rows 2–5  (widest right side)
  //     col 4-5 rows 5–6  (bottom shoulder)
  //   Interior hollow: cut out with white, then add corridor stripes

  const H = 110; // letter height
  // Right-side step column positions
  const colR1 = ox + 52; // step-in column (cols 4–5 zone)
  const colR2 = ox + 65; // outer right column

  return (
    <g>
      {/* ── Solid letter fill (black rectangle covering the D shape) ── */}

      {/* Left vertical spine — full height */}
      <VWall x={ox} y={oy} h={H} />

      {/* Top horizontal cap */}
      <HWall x={ox} y={oy} w={colR1 - ox + WALL} />

      {/* Bottom horizontal cap */}
      <HWall x={ox} y={oy + H - WALL} w={colR1 - ox + WALL} />

      {/* Right shoulder top: step from colR1 down ~2 rows */}
      <HWall x={colR1} y={oy + UNIT} w={WALL + GAP + WALL} />
      {/* Right outer vertical — middle section (rows 2–6) */}
      <VWall x={colR2} y={oy + UNIT + WALL} h={H - 2 * (UNIT + WALL)} />
      {/* Right shoulder bottom */}
      <HWall x={colR1} y={oy + H - UNIT - WALL} w={WALL + GAP + WALL} />

      {/* Fill in the top-right corner block (between top cap and shoulder) */}
      <VWall x={colR1} y={oy + WALL} h={UNIT - WALL} />

      {/* Fill in the bottom-right corner block */}
      <VWall x={colR1} y={oy + H - UNIT} h={UNIT - WALL} />

      {/* ── White interior cutout ── */}
      {/* Main hollow interior */}
      <Corridor
        x={ox + WALL}
        y={oy + WALL}
        w={colR1 - ox - WALL}
        h={H - 2 * WALL}
      />
      {/* Right bulge interior */}
      <Corridor
        x={colR1 + WALL}
        y={oy + UNIT + WALL}
        w={GAP}
        h={H - 2 * (UNIT + WALL)}
      />

      {/* ── Maze corridors: horizontal stripes through the solid walls ── */}
      {/* These run through the left spine and right walls, creating passages */}

      {/* Horizontal corridor row 1 (through left spine at y = oy+UNIT) */}
      <Corridor x={ox + WALL} y={oy + UNIT} w={WALL} h={GAP} />
      {/* Horizontal corridor row 2 */}
      <Corridor x={ox + WALL} y={oy + 2 * UNIT} w={WALL} h={GAP} />
      {/* Horizontal corridor row 3 */}
      <Corridor x={ox + WALL} y={oy + 3 * UNIT} w={WALL} h={GAP} />
      {/* Horizontal corridor row 4 */}
      <Corridor x={ox + WALL} y={oy + 4 * UNIT} w={WALL} h={GAP} />
      {/* Horizontal corridor row 5 */}
      <Corridor x={ox + WALL} y={oy + 5 * UNIT} w={WALL} h={GAP} />
      {/* Horizontal corridor row 6 */}
      <Corridor x={ox + WALL} y={oy + 6 * UNIT} w={WALL} h={GAP} />

      {/* Right-side corridors through the outer right wall */}
      <Corridor x={colR2 + WALL} y={oy + 2 * UNIT} w={GAP} h={GAP} />
      <Corridor x={colR2 + WALL} y={oy + 3 * UNIT} w={GAP} h={GAP} />
      <Corridor x={colR2 + WALL} y={oy + 4 * UNIT} w={GAP} h={GAP} />
      <Corridor x={colR2 + WALL} y={oy + 5 * UNIT} w={GAP} h={GAP} />

      {/* Vertical corridor through top cap (interior column at col 2) */}
      <Corridor x={ox + 2 * UNIT} y={oy} w={GAP} h={WALL} />
      {/* Vertical corridor through top cap at col 3 */}
      <Corridor x={ox + 3 * UNIT} y={oy} w={GAP} h={WALL} />

      {/* Vertical corridor through bottom cap at col 2 */}
      <Corridor x={ox + 2 * UNIT} y={oy + H - WALL} w={GAP} h={WALL} />
      {/* Vertical corridor through bottom cap at col 3 */}
      <Corridor x={ox + 3 * UNIT} y={oy + H - WALL} w={GAP} h={WALL} />

      {/* Top shoulder corridors */}
      <Corridor x={colR1} y={oy + UNIT} w={GAP} h={WALL} />
      {/* Bottom shoulder corridors */}
      <Corridor x={colR1} y={oy + H - UNIT - WALL} w={GAP} h={WALL} />
    </g>
  );
}

/**
 * Render the letter "O" as a maze starting at x-offset `ox`, y-offset `oy`.
 *
 * Structure:
 *   - Outer rectangular ring (4 sides)
 *   - Inner white hollow
 *   - Horizontal maze corridors slicing through left and right walls
 *   - Vertical maze corridors slicing through top and bottom walls
 */
function LetterO({ ox, oy }: { ox: number; oy: number }) {
  const H = 110;
  const W = 80;
  // Inner hollow inset by one UNIT from each side
  const innerX = ox + UNIT;
  const innerY = oy + UNIT;
  const innerW = W - 2 * UNIT;
  const innerH = H - 2 * UNIT;

  return (
    <g>
      {/* ── Outer ring walls ── */}

      {/* Top wall */}
      <HWall x={ox} y={oy} w={W} />
      {/* Bottom wall */}
      <HWall x={ox} y={oy + H - WALL} w={W} />
      {/* Left wall */}
      <VWall x={ox} y={oy + WALL} h={H - 2 * WALL} />
      {/* Right wall */}
      <VWall x={ox + W - WALL} y={oy + WALL} h={H - 2 * WALL} />

      {/* Inner ring (inset by one UNIT) */}
      {/* Inner top */}
      <HWall x={innerX} y={innerY} w={innerW} />
      {/* Inner bottom */}
      <HWall x={innerX} y={innerY + innerH - WALL} w={innerW} />
      {/* Inner left */}
      <VWall x={innerX} y={innerY + WALL} h={innerH - 2 * WALL} />
      {/* Inner right */}
      <VWall x={innerX + innerW - WALL} y={innerY + WALL} h={innerH - 2 * WALL} />

      {/* ── White cutouts ── */}

      {/* Corridor between outer and inner rings — all four sides */}
      {/* Top annular corridor */}
      <Corridor x={ox + WALL} y={oy + WALL} w={W - 2 * WALL} h={GAP} />
      {/* Bottom annular corridor */}
      <Corridor x={ox + WALL} y={oy + H - UNIT} w={W - 2 * WALL} h={GAP} />
      {/* Left annular corridor */}
      <Corridor x={ox + WALL} y={oy + UNIT} w={GAP} h={H - 2 * UNIT} />
      {/* Right annular corridor */}
      <Corridor x={ox + W - UNIT} y={oy + UNIT} w={GAP} h={H - 2 * UNIT} />

      {/* Inner hollow */}
      <Corridor
        x={innerX + WALL}
        y={innerY + WALL}
        w={innerW - 2 * WALL}
        h={innerH - 2 * WALL}
      />
      {/* Inner annular corridors */}
      <Corridor x={innerX + WALL} y={innerY + WALL} w={innerW - 2 * WALL} h={GAP} />
      <Corridor
        x={innerX + WALL}
        y={innerY + innerH - UNIT}
        w={innerW - 2 * WALL}
        h={GAP}
      />
      <Corridor x={innerX + WALL} y={innerY + UNIT} w={GAP} h={innerH - 2 * UNIT} />
      <Corridor
        x={innerX + innerW - UNIT}
        y={innerY + UNIT}
        w={GAP}
        h={innerH - 2 * UNIT}
      />

      {/* ── Maze corridors through outer ring walls ── */}

      {/* Through top outer wall — vertical passages */}
      <Corridor x={ox + 2 * UNIT} y={oy} w={GAP} h={WALL} />
      <Corridor x={ox + 4 * UNIT} y={oy} w={GAP} h={WALL} />

      {/* Through bottom outer wall — vertical passages */}
      <Corridor x={ox + 2 * UNIT} y={oy + H - WALL} w={GAP} h={WALL} />
      <Corridor x={ox + 4 * UNIT} y={oy + H - WALL} w={GAP} h={WALL} />

      {/* Through left outer wall — horizontal passages */}
      <Corridor x={ox} y={oy + 2 * UNIT} w={WALL} h={GAP} />
      <Corridor x={ox} y={oy + 4 * UNIT} w={WALL} h={GAP} />
      <Corridor x={ox} y={oy + 6 * UNIT} w={WALL} h={GAP} />

      {/* Through right outer wall — horizontal passages */}
      <Corridor x={ox + W - WALL} y={oy + 2 * UNIT} w={WALL} h={GAP} />
      <Corridor x={ox + W - WALL} y={oy + 4 * UNIT} w={WALL} h={GAP} />
      <Corridor x={ox + W - WALL} y={oy + 6 * UNIT} w={WALL} h={GAP} />

      {/* Through inner ring walls */}
      <Corridor x={innerX + 2 * UNIT} y={innerY} w={GAP} h={WALL} />
      <Corridor x={innerX + 2 * UNIT} y={innerY + innerH - WALL} w={GAP} h={WALL} />
      <Corridor x={innerX} y={innerY + 2 * UNIT} w={WALL} h={GAP} />
      <Corridor
        x={innerX + innerW - WALL}
        y={innerY + 2 * UNIT}
        w={WALL}
        h={GAP}
      />
      <Corridor x={innerX} y={innerY + 4 * UNIT} w={WALL} h={GAP} />
      <Corridor
        x={innerX + innerW - WALL}
        y={innerY + 4 * UNIT}
        w={WALL}
        h={GAP}
      />
    </g>
  );
}

/**
 * Render the letter "S" as a maze starting at x-offset `ox`, y-offset `oy`.
 *
 * Structure (reverse-S / Z / S shape):
 *   - Top horizontal wall
 *   - Upper-left vertical wall
 *   - Middle horizontal wall (full width)
 *   - Lower-right vertical wall
 *   - Bottom horizontal wall
 *   - Maze corridors slicing through each segment
 */
function LetterS({ ox, oy }: { ox: number; oy: number }) {
  const H = 110;
  const W = 76; // slightly narrower

  // Vertical midpoint dividing upper and lower halves
  const midY = oy + Math.round(H / 2) - Math.round(WALL / 2);

  // Upper half height (from top to mid-wall top)
  const upperH = midY - oy;
  // Lower half height (from mid-wall bottom to bottom)
  const lowerH = H - (upperH + WALL);

  return (
    <g>
      {/* ── Top horizontal wall ── */}
      <HWall x={ox} y={oy} w={W} />

      {/* ── Upper-left vertical wall (left side, top half) ── */}
      <VWall x={ox} y={oy + WALL} h={upperH - WALL} />

      {/* ── Middle horizontal wall ── */}
      <HWall x={ox} y={midY} w={W} />

      {/* ── Lower-right vertical wall (right side, bottom half) ── */}
      <VWall x={ox + W - WALL} y={midY + WALL} h={lowerH - WALL} />

      {/* ── Bottom horizontal wall ── */}
      <HWall x={ox} y={oy + H - WALL} w={W} />

      {/* ── End caps to close the S terminals ── */}
      {/* Top-right cap (connects top bar at right) */}
      <VWall x={ox + W - WALL} y={oy + WALL} h={upperH - WALL} />
      {/* Bottom-left cap (connects bottom bar at left) */}
      <VWall x={ox} y={midY + WALL} h={lowerH - WALL} />

      {/* ── White corridors: open the interiors ── */}
      {/* Upper interior (between top wall, left wall, right cap, mid wall) */}
      <Corridor x={ox + WALL} y={oy + WALL} w={W - 2 * WALL} h={upperH - WALL} />
      {/* Lower interior (between mid wall, right wall, left cap, bottom wall) */}
      <Corridor x={ox + WALL} y={midY + WALL} w={W - 2 * WALL} h={lowerH - WALL} />

      {/* ── Maze corridors through the walls ── */}

      {/* Top wall — vertical passages */}
      <Corridor x={ox + UNIT} y={oy} w={GAP} h={WALL} />
      <Corridor x={ox + 3 * UNIT} y={oy} w={GAP} h={WALL} />
      <Corridor x={ox + 5 * UNIT} y={oy} w={GAP} h={WALL} />

      {/* Upper-left vertical wall — horizontal passages */}
      <Corridor x={ox} y={oy + UNIT} w={WALL} h={GAP} />
      <Corridor x={ox} y={oy + 2 * UNIT} w={WALL} h={GAP} />

      {/* Upper-right cap wall — horizontal passages */}
      <Corridor x={ox + W - WALL} y={oy + UNIT} w={WALL} h={GAP} />
      <Corridor x={ox + W - WALL} y={oy + 2 * UNIT} w={WALL} h={GAP} />

      {/* Middle horizontal wall — vertical passages */}
      <Corridor x={ox + UNIT} y={midY} w={GAP} h={WALL} />
      <Corridor x={ox + 3 * UNIT} y={midY} w={GAP} h={WALL} />
      <Corridor x={ox + 5 * UNIT} y={midY} w={GAP} h={WALL} />

      {/* Lower-right vertical wall — horizontal passages */}
      <Corridor x={ox + W - WALL} y={midY + UNIT} w={WALL} h={GAP} />
      <Corridor x={ox + W - WALL} y={midY + 2 * UNIT} w={WALL} h={GAP} />

      {/* Lower-left cap wall — horizontal passages */}
      <Corridor x={ox} y={midY + UNIT} w={WALL} h={GAP} />
      <Corridor x={ox} y={midY + 2 * UNIT} w={WALL} h={GAP} />

      {/* Bottom wall — vertical passages */}
      <Corridor x={ox + UNIT} y={oy + H - WALL} w={GAP} h={WALL} />
      <Corridor x={ox + 3 * UNIT} y={oy + H - WALL} w={GAP} h={WALL} />
      <Corridor x={ox + 5 * UNIT} y={oy + H - WALL} w={GAP} h={WALL} />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Horizontal gap between letters. */
const LETTER_SPACING = 20;

/** Left margin. */
const MARGIN_X = 10;

/** Top margin (centers 110px letters in 130px viewBox). */
const MARGIN_Y = 10;

/** Width of each letter's bounding box. */
const D_WIDTH = 80;
const O_WIDTH = 80;
const S_WIDTH = 76;

/** Total viewBox width: margins + letters + gaps. */
const VB_WIDTH =
  MARGIN_X * 2 + D_WIDTH + LETTER_SPACING + O_WIDTH + LETTER_SPACING + S_WIDTH;

/**
 * "DOS" logotype whose letters are formed by right-angle maze corridors.
 * Thick black walls (~9 px) with narrow white passages (~4 px) running
 * through them create the letterforms — like a maze whose paths spell DOS.
 */
export function Logo08() {
  const dX = MARGIN_X;
  const oX = dX + D_WIDTH + LETTER_SPACING;
  const sX = oX + O_WIDTH + LETTER_SPACING;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VB_WIDTH} 130`}
      role="img"
      aria-label="DOS"
    >
      <LetterD ox={dX} oy={MARGIN_Y} />
      <LetterO ox={oX} oy={MARGIN_Y} />
      <LetterS ox={sX} oy={MARGIN_Y} />
    </svg>
  );
}
