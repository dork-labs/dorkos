'use client';

/**
 * Logo18 — Layered offset "DORK" creating a depth/shadow/motion effect.
 *
 * The same blocky rectangular letterforms are rendered three times:
 *   - Back layer offset (+4, +4) in light gray (#ccc)
 *   - Middle layer offset (+2, +2) in dark gray (#666)
 *   - Front layer at (0, 0) in solid black (#000)
 *
 * Letters are built entirely from rectangles — thick, angular, brutalist slabs.
 * ViewBox: 0 0 466 138 (500×140 letter canvas + 4px overflow for back layer).
 */

// ---------------------------------------------------------------------------
// Shape definitions — each letter as an array of rect descriptors.
// Coordinates match the brutalist slab letterforms (same as l05-brutalist).
// ---------------------------------------------------------------------------

interface RectDef {
  x: number;
  y: number;
  w: number;
  h: number;
  /** If true, this rect is a cutout (rendered as fill="white" in front layer). */
  cutout?: boolean;
}

/** D — x origin 0, width 108 */
const RECTS_D: RectDef[] = [
  { x: 0, y: 0, w: 22, h: 140 }, // left vertical slab
  { x: 0, y: 0, w: 86, h: 22 }, // top horizontal slab
  { x: 0, y: 118, w: 86, h: 22 }, // bottom horizontal slab
  { x: 86, y: 0, w: 22, h: 140 }, // right vertical cap
  { x: 22, y: 22, w: 64, h: 96, cutout: true }, // inner void
];

/** O — x origin 122, width 108 */
const RECTS_O: RectDef[] = [
  { x: 122, y: 0, w: 108, h: 140 }, // outer block
  { x: 148, y: 26, w: 56, h: 88, cutout: true }, // inner void
];

/** R — x origin 244, width 110 */
const RECTS_R: RectDef[] = [
  { x: 244, y: 0, w: 22, h: 140 }, // left vertical slab
  { x: 244, y: 0, w: 86, h: 22 }, // top horizontal slab
  { x: 244, y: 64, w: 86, h: 22 }, // middle horizontal slab
  { x: 308, y: 0, w: 22, h: 86 }, // right cap — top counter bowl
  { x: 266, y: 22, w: 42, h: 42, cutout: true }, // upper inner void (bowl)
  { x: 298, y: 86, w: 36, h: 54 }, // leg — thick rect lower-right
];

/** K — x origin 366, width 110 */
const RECTS_K: RectDef[] = [
  { x: 366, y: 0, w: 22, h: 140 }, // left vertical slab
  // upper arm staircase
  { x: 388, y: 42, w: 60, h: 22 }, // step 1
  { x: 420, y: 20, w: 28, h: 22 }, // step 2
  { x: 448, y: 0, w: 28, h: 20 }, // step 3 — top-right cap
  // lower arm staircase
  { x: 388, y: 76, w: 60, h: 22 }, // step 1
  { x: 420, y: 98, w: 28, h: 22 }, // step 2
  { x: 448, y: 120, w: 28, h: 20 }, // step 3 — bottom-right cap
];

const ALL_LETTERS: RectDef[] = [...RECTS_D, ...RECTS_O, ...RECTS_R, ...RECTS_K];

// ---------------------------------------------------------------------------
// Layer renderer
// ---------------------------------------------------------------------------

interface LayerProps {
  /** X translation for the entire layer. */
  dx: number;
  /** Y translation for the entire layer. */
  dy: number;
  /** Fill color for solid rects on this layer. */
  fill: string;
  /**
   * Fill for cutout rects. On back/middle layers, cutouts should be the
   * background color so the layer appears opaque and self-contained.
   */
  cutoutFill: string;
}

function Layer({ dx, dy, fill, cutoutFill }: LayerProps) {
  return (
    <g transform={`translate(${dx}, ${dy})`}>
      {ALL_LETTERS.map((r, i) => (
        <rect
          key={i}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill={r.cutout ? cutoutFill : fill}
        />
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Layered offset logo spelling "DORK".
 *
 * Three identical letterform layers are stacked with increasing offsets,
 * rendered back-to-front to create an isometric-style depth illusion.
 */
export function Logo18() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      // Extend viewBox right/down by 4px to contain the back layer overflow
      viewBox="0 0 466 138"
      role="img"
      aria-label="DORK"
    >
      <title>DORK</title>

      {/* Back layer — furthest depth, lightest gray, largest offset */}
      <Layer dx={4} dy={4} fill="#ccc" cutoutFill="white" />

      {/* Middle layer — mid depth, dark gray, half offset */}
      <Layer dx={2} dy={2} fill="#666" cutoutFill="white" />

      {/* Front layer — no offset, solid black, sits on top */}
      <Layer dx={0} dy={0} fill="#000" cutoutFill="white" />
    </svg>
  );
}
