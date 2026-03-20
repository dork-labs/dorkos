'use client';

/**
 * Logo02 — DorkOS spelled in pixel-art (8-bit) style on a visible grid.
 *
 * Each letter is built from 10×10 px `rect` elements on a 5-col × 7-row
 * per-character grid. A 2 px gap separates adjacent pixels; a 16 px gap
 * separates letters. The overall viewBox is 500×120 to give comfortable
 * headroom around the 70 px tall lettering.
 */

/** One "pixel" in the rendered grid, in logical units. */
const PX = 10;
/** Gap between adjacent pixel cells. */
const GAP = 2;
/** Stride: distance from the start of one pixel to the start of the next. */
const S = PX + GAP;
/** Horizontal gap between letters. */
const LETTER_GAP = 16;
/** Top-left Y offset so lettering is vertically centred in the 120 px viewBox. */
const TOP = 25;

/**
 * Render a single pixel-art character.
 *
 * @param bitmap  7-row × 5-col boolean grid (row 0 = top)
 * @param xStart  X origin of the character's bounding box
 * @param fill    Fill colour (defaults to #000)
 */
function renderChar(bitmap: boolean[][], xStart: number, fill = '#000'): React.ReactNode[] {
  const rects: React.ReactNode[] = [];
  bitmap.forEach((row, rowIdx) => {
    row.forEach((on, colIdx) => {
      if (!on) return;
      rects.push(
        <rect
          key={`${rowIdx}-${colIdx}`}
          x={xStart + colIdx * S}
          y={TOP + rowIdx * S}
          width={PX}
          height={PX}
          fill={fill}
        />
      );
    });
  });
  return rects;
}

// ---------------------------------------------------------------------------
// Pixel-art bitmaps — each is a 7-row × 5-col boolean grid.
// Row 0 is the topmost row; column 0 is leftmost.
// ---------------------------------------------------------------------------

/** D */
const D: boolean[][] = [
  [1, 1, 1, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 1, 0],
  [1, 1, 1, 0, 0],
].map((r) => r.map(Boolean));

/** o (lowercase, keeps visual variety vs capital O) */
const o: boolean[][] = [
  [0, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 0],
].map((r) => r.map(Boolean));

/** r (lowercase) */
const r: boolean[][] = [
  [0, 0, 0, 0, 0],
  [1, 0, 1, 1, 0],
  [1, 1, 0, 0, 1],
  [1, 0, 0, 0, 0],
  [1, 0, 0, 0, 0],
  [1, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
].map((r) => r.map(Boolean));

/** k (lowercase) */
const k: boolean[][] = [
  [1, 0, 0, 0, 0],
  [1, 0, 0, 0, 0],
  [1, 0, 0, 1, 0],
  [1, 0, 1, 0, 0],
  [1, 1, 0, 0, 0],
  [1, 0, 1, 0, 0],
  [1, 0, 0, 1, 0],
].map((r) => r.map(Boolean));

/** O (capital) */
const O: boolean[][] = [
  [0, 1, 1, 1, 0],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [0, 1, 1, 1, 0],
].map((r) => r.map(Boolean));

/** S (capital) */
const S_char: boolean[][] = [
  [0, 1, 1, 1, 1],
  [1, 0, 0, 0, 0],
  [1, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 1],
  [0, 0, 0, 0, 1],
  [1, 1, 1, 1, 0],
].map((r) => r.map(Boolean));

// ---------------------------------------------------------------------------
// Letter layout — compute X origin for each character.
// Each character occupies 5 columns × S px wide, then a LETTER_GAP follows.
// ---------------------------------------------------------------------------

const CHAR_WIDTH = 5 * S; // 60 px

const chars: { bitmap: boolean[][]; x: number }[] = (() => {
  const letters = [D, o, r, k, O, S_char];
  let cursor = 20; // left margin
  return letters.map((bitmap) => {
    const x = cursor;
    cursor += CHAR_WIDTH + LETTER_GAP;
    return { bitmap, x };
  });
})();

// ---------------------------------------------------------------------------
// Grid overlay — light dots at every pixel-cell intersection.
// ---------------------------------------------------------------------------

function GridDots(): React.ReactNode {
  // The grid spans all characters plus margins.
  const gridLeft = 20;
  const gridRight = chars[chars.length - 1]!.x + CHAR_WIDTH;
  const gridTop = TOP;
  const gridBottom = TOP + 7 * S;

  const dots: React.ReactNode[] = [];
  let dotId = 0;

  for (let gx = gridLeft; gx <= gridRight; gx += S) {
    for (let gy = gridTop; gy <= gridBottom; gy += S) {
      dots.push(<circle key={dotId++} cx={gx} cy={gy} r={1} fill="#ccc" opacity={0.6} />);
    }
  }
  return dots;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Logo02({
  width = 500,
  height = 120,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 500 120"
      width={width}
      height={height}
      className={className}
      aria-label="DorkOS"
      role="img"
    >
      {/* Visible grid dots for retro-computing aesthetic */}
      <GridDots />

      {/* Pixel-art letters */}
      {chars.map(({ bitmap, x }, i) => (
        <g key={i}>{renderChar(bitmap, x)}</g>
      ))}
    </svg>
  );
}
