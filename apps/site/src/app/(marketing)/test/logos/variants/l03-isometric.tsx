'use client';

/**
 * Logo03 — Isometric Stack
 *
 * Each letter of "DORK" rendered as an extruded 3D block using isometric
 * projection. Three visible faces per voxel: front (#000), top (#333),
 * right-side (#666). Letters are built from unit-cube voxels on a shared
 * isometric grid, then grouped with horizontal spacing.
 */

// ---------------------------------------------------------------------------
// Isometric projection helpers
// ---------------------------------------------------------------------------

// Unit vectors for the three isometric axes (screen coordinates).
// Standard isometric: 30° angle, 2:1 ratio. Scale factor sets pixel size.
const S = 8; // voxel face size in screen pixels (half-width of rhombus face)

/**
 * Convert isometric grid coordinates (col, row, layer) to screen (x, y).
 * col  = rightward along the grid floor
 * row  = backward along the grid floor (increases away from viewer)
 * layer = upward (z)
 */
function iso(col: number, row: number, layer: number): [number, number] {
  const x = (col - row) * S;
  const y = (col + row) * (S / 2) - layer * S;
  return [x, y];
}

// ---------------------------------------------------------------------------
// Voxel face drawing
// ---------------------------------------------------------------------------

interface VoxelProps {
  col: number;
  row: number;
  layer: number;
}

/**
 * Render one isometric voxel cube at grid position (col, row, layer).
 * Three faces: top (lightest), left/front-left (#000), right/front-right (#555).
 * We draw "D","O","R","K" from a viewer looking at the front-left face,
 * so "front" = left face, "side" = right face.
 */
function Voxel({ col, row, layer }: VoxelProps) {
  // Eight corners of the unit cube in isometric screen coords.
  // Naming: bottom-front = bf, top-front = tf, etc.
  const [cx, cy] = iso(col, row, layer);

  // Face: TOP — rhombus at the top of the cube
  // corners: (col,row,layer+1), (col+1,row,layer+1), (col+1,row+1,layer+1), (col,row+1,layer+1)
  const [t0x, t0y] = iso(col, row, layer + 1);
  const [t1x, t1y] = iso(col + 1, row, layer + 1);
  const [t2x, t2y] = iso(col + 1, row + 1, layer + 1);
  const [t3x, t3y] = iso(col, row + 1, layer + 1);

  // Face: FRONT LEFT — parallelogram (viewer-facing left face)
  // corners: (col,row,layer), (col+1,row,layer), (col+1,row,layer+1), (col,row,layer+1)
  const [fl0x, fl0y] = iso(col, row, layer);
  const [fl1x, fl1y] = iso(col + 1, row, layer);
  const [fl2x, fl2y] = iso(col + 1, row, layer + 1);
  const [fl3x, fl3y] = iso(col, row, layer + 1);

  // Face: FRONT RIGHT — parallelogram (viewer-facing right face)
  // corners: (col+1,row,layer), (col+1,row+1,layer), (col+1,row+1,layer+1), (col+1,row,layer+1)
  const [fr0x, fr0y] = iso(col + 1, row, layer);
  const [fr1x, fr1y] = iso(col + 1, row + 1, layer);
  const [fr2x, fr2y] = iso(col + 1, row + 1, layer + 1);
  const [fr3x, fr3y] = iso(col + 1, row, layer + 1);

  const topPts = `${t0x},${t0y} ${t1x},${t1y} ${t2x},${t2y} ${t3x},${t3y}`;
  const frontLeftPts = `${fl0x},${fl0y} ${fl1x},${fl1y} ${fl2x},${fl2y} ${fl3x},${fl3y}`;
  const frontRightPts = `${fr0x},${fr0y} ${fr1x},${fr1y} ${fr2x},${fr2y} ${fr3x},${fr3y}`;

  // Suppress unused variable warning — cx/cy aren't used directly but kept
  // for conceptual clarity that col/row/layer anchors the cube.
  void cx;
  void cy;

  return (
    <g>
      {/* Top face — lightest gray, receives the most light */}
      <polygon points={topPts} fill="#444" stroke="#000" strokeWidth="0.5" />
      {/* Front-left face — darkest, acts as the "writing surface" */}
      <polygon points={frontLeftPts} fill="#000" stroke="#000" strokeWidth="0.5" />
      {/* Front-right face — mid-gray for visible depth */}
      <polygon points={frontRightPts} fill="#666" stroke="#000" strokeWidth="0.5" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Letter glyph definitions
// ---------------------------------------------------------------------------
// Each letter is an array of (col, row, layer) voxel positions.
// Grid is 5 wide × 7 tall (col 0-4, layer 0-6), row depth = 1 voxel.
// We use row=0 for all voxels (flat slab, 1 voxel deep) so the front face
// is the entire glyph face.

type VoxelCoord = [number, number, number];

/** "D" — 5×7 pixel font rendered as voxels */
const LETTER_D: VoxelCoord[] = [
  // Col 0: full left spine
  [0, 0, 0],
  [0, 0, 1],
  [0, 0, 2],
  [0, 0, 3],
  [0, 0, 4],
  [0, 0, 5],
  [0, 0, 6],
  // Col 1: top and bottom connectors + curve
  [1, 0, 0],
  [1, 0, 6],
  [1, 0, 1],
  [1, 0, 5],
  // Col 2: the bulge
  [2, 0, 1],
  [2, 0, 2],
  [2, 0, 4],
  [2, 0, 5],
  // Col 3: far-right curve body
  [3, 0, 2],
  [3, 0, 3],
  [3, 0, 4],
];

/** "O" — 5×7 pixel font */
const LETTER_O: VoxelCoord[] = [
  // Left spine
  [0, 0, 1],
  [0, 0, 2],
  [0, 0, 3],
  [0, 0, 4],
  [0, 0, 5],
  // Right spine
  [4, 0, 1],
  [4, 0, 2],
  [4, 0, 3],
  [4, 0, 4],
  [4, 0, 5],
  // Top bar
  [1, 0, 6],
  [2, 0, 6],
  [3, 0, 6],
  // Bottom bar
  [1, 0, 0],
  [2, 0, 0],
  [3, 0, 0],
];

/** "R" — 5×7 pixel font */
const LETTER_R: VoxelCoord[] = [
  // Left spine
  [0, 0, 0],
  [0, 0, 1],
  [0, 0, 2],
  [0, 0, 3],
  [0, 0, 4],
  [0, 0, 5],
  [0, 0, 6],
  // Top bar
  [1, 0, 6],
  [2, 0, 6],
  [3, 0, 6],
  // Top-right corner
  [4, 0, 5],
  // Mid connector
  [4, 0, 4],
  // Mid bar
  [1, 0, 3],
  [2, 0, 3],
  [3, 0, 3],
  // Leg going down-right
  [2, 0, 2],
  [3, 0, 1],
  [4, 0, 0],
];

/** "K" — 5×7 pixel font */
const LETTER_K: VoxelCoord[] = [
  // Left spine
  [0, 0, 0],
  [0, 0, 1],
  [0, 0, 2],
  [0, 0, 3],
  [0, 0, 4],
  [0, 0, 5],
  [0, 0, 6],
  // Upper arm: 4 → 1 going up-right
  [3, 0, 6],
  [2, 0, 5],
  [1, 0, 4],
  // Mid junction
  [1, 0, 3],
  // Lower arm: 4 → 1 going down-right
  [1, 0, 2],
  [2, 0, 1],
  [3, 0, 0],
  [4, 0, 0],
  // Extra upper arm tip
  [4, 0, 6],
];

// ---------------------------------------------------------------------------
// Letter group with isometric offset
// ---------------------------------------------------------------------------

interface LetterGroupProps {
  voxels: VoxelCoord[];
  /** Horizontal offset in col units (added to each voxel's col) */
  colOffset: number;
}

/** Render a set of voxels, each shifted by colOffset columns. */
function LetterGroup({ voxels, colOffset }: LetterGroupProps) {
  return (
    <g>
      {voxels.map(([col, row, layer], i) => (
        <Voxel key={i} col={col + colOffset} row={row} layer={layer} />
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Bounds calculation for viewBox
// ---------------------------------------------------------------------------

/** Collect all screen-space vertices across a set of voxels at a col offset. */
function voxelScreenPoints(voxels: VoxelCoord[], colOffset: number): [number, number][] {
  const pts: [number, number][] = [];
  for (const [col, row, layer] of voxels) {
    const c = col + colOffset;
    // All 8 corners of the unit cube
    for (let dc = 0; dc <= 1; dc++) {
      for (let dr = 0; dr <= 1; dr++) {
        for (let dl = 0; dl <= 1; dl++) {
          pts.push(iso(c + dc, row + dr, layer + dl));
        }
      }
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// Letter spacing: each letter occupies 5 cols, gap of 1 col between letters.
const COL_STRIDE = 6;

const LETTERS: { voxels: VoxelCoord[]; colOffset: number }[] = [
  { voxels: LETTER_D, colOffset: 0 },
  { voxels: LETTER_O, colOffset: COL_STRIDE },
  { voxels: LETTER_R, colOffset: COL_STRIDE * 2 },
  { voxels: LETTER_K, colOffset: COL_STRIDE * 3 },
];

/** Compute a tight viewBox around all rendered voxels with padding. */
function computeViewBox(padding = 10): string {
  const allPts: [number, number][] = [];
  for (const { voxels, colOffset } of LETTERS) {
    allPts.push(...voxelScreenPoints(voxels, colOffset));
  }

  const xs = allPts.map(([x]) => x);
  const ys = allPts.map(([, y]) => y);
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  const maxX = Math.max(...xs) + padding;
  const maxY = Math.max(...ys) + padding;

  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
}

const VIEW_BOX = computeViewBox(12);

/** Logo03 — "DORK" in extruded isometric block letterforms. */
export function Logo03() {
  return (
    <svg
      viewBox={VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: '100%', maxWidth: 500, height: 'auto', display: 'block' }}
      aria-label="DORK logo in isometric 3D block style"
      role="img"
    >
      {LETTERS.map(({ voxels, colOffset }, i) => (
        <LetterGroup key={i} voxels={voxels} colOffset={colOffset} />
      ))}
    </svg>
  );
}
