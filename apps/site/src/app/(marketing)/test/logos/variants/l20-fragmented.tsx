'use client';

/**
 * Logo20 — "DorkOS" as geometric shards.
 *
 * Every letter is decomposed into 3–5 explicit filled polygons separated
 * by intentional diagonal fracture lines (2–3 px optical gap). No clip-paths,
 * no strokes — only solid black polygons whose edges are computed to leave
 * a consistent HG=1.5 px inset on each side of every fracture line.
 *
 * ViewBox: 480 × 120. Cap height: y=10..110 (100 px). Lowercase descends to
 * y=22..98 (76 px x-height). Inter-letter gap: 10 px.
 *
 * Column layout:
 *   D  x=8    w=74  → right edge 82
 *   o  x=92   w=60  → right edge 152
 *   r  x=162  w=52  → right edge 214
 *   k  x=224  w=63  → right edge 287
 *   O  x=297  w=74  → right edge 371
 *   S  x=381  w=62  → right edge 443  (+pad 37 → 480 ✓)
 */

/** Half the optical fracture gap. Each shard edge is inset HG from the cut. */
const HG = 1.5;

/** Convenience: turn a 2-D array into an SVG points string. */
function pts(pairs: [number, number][]): string {
  return pairs.map(([x, y]) => `${x},${y}`).join(' ');
}

/**
 * Linearly interpolate y at position x along a diagonal cut defined by two
 * anchor points (x0, y0) and (x1, y1).
 */
function cutY(x0: number, y0: number, x1: number, y1: number, x: number): number {
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

// ─────────────────────────────────────────────────────────────────────────────
// D  (x=8, w=74)  cap height y=10..110
//
// Letterform:
//   • Left vertical stem: x=8..22, y=10..110
//   • Top horizontal bar: x=8..68, y=10..24
//   • Bottom horizontal bar: x=8..68, y=96..110
//   • Right bowl: a filled shape closing the D, approximated as a right-half
//     ellipse. Outer right edge peaks at x=82, centre y=60.
//     The bowl is bounded on the left by x=68; inner cutout starts at x=54.
//
// Bowl simplified as 5-point approximation (polygon, not bezier):
//   outer: (68,10)→(82,28)→(82,60)→(82,92)→(68,110)
//   inner: (68,24)→(72,36)→(72,60)→(72,84)→(68,96)
//   (inner inset ~14 px)
//
// Fracture lines (two diagonal cuts across the full letter width):
//   Cut A: (8, 42) → (82, 36)   — upper third, rising left-to-right
//   Cut B: (8, 78) → (82, 84)   — lower third, falling left-to-right
//
// Shards (6 total — stem and bowl each split into 3 by the two cuts):
//   D1: upper stem+bar (left side above cut A)
//   D2: mid stem (left side between cuts)
//   D3: lower stem+bar (left side below cut B)
//   D4: upper bowl piece (above cut A)
//   D5: mid bowl piece (between cuts)
//   D6: lower bowl piece (below cut B)
// ─────────────────────────────────────────────────────────────────────────────
function ShardsD() {
  // stem/bar geometry
  const L = 8,
    R = 82; // letter left / right
  const stemR = 22; // stem right edge
  const barR = 68; // bar right extent (before bowl rounds off)
  const bh = 14; // bar height

  // Cut A anchor points
  const aX0 = L,
    aY0 = 42,
    aX1 = R,
    aY1 = 36;
  // Cut B anchor points
  const bX0 = L,
    bY0 = 78,
    bX1 = R,
    bY1 = 84;

  // Cut y values at key x positions
  const aAtStemR = cutY(aX0, aY0, aX1, aY1, stemR); // ≈41.0
  const bAtStemR = cutY(bX0, bY0, bX1, bY1, stemR); // ≈78.8
  const aAtR = aY1; // cut A at right edge = 36
  const bAtR = bY1; // cut B at right edge = 84

  // Bowl polygon points (outer / inner)
  // outer: (68,10) → (82,28) → (82,60) → (82,92) → (68,110)
  // inner: (68,24) → (72,36) → (72,60) → (72,84) → (68,96)
  // Cut A intersects bowl at y≈36 (outer right edge x=82) and y≈37 (inner right edge x=72)
  // Cut B intersects bowl at y≈84 (outer right edge x=82) and y≈83 (inner right edge x=72)

  // Determine cut A y on the outer right edge (x=82): aAtR = 36
  // Determine cut A y on inner right edge (x=72): cutY(aX0,aY0,aX1,aY1,72) ≈ 37.1
  const aAtInnerR = cutY(aX0, aY0, aX1, aY1, 72); // ≈37.1

  // Determine cut B y on outer right edge (x=82): bAtR = 84
  const bAtInnerR = cutY(bX0, bY0, bX1, bY1, 72); // ≈82.9

  return (
    <g>
      {/* ── D1: upper stem + top bar (above cut A) ── */}
      <polygon
        points={pts([
          [L, 10],
          [barR, 10], // top bar spans to barR
          [barR, 10 + bh], // top bar bottom (y=24)
          [stemR, 10 + bh], // back to stem on top bar bottom
          [stemR, aAtStemR - HG],
          [L, aY0 - HG],
        ])}
      />

      {/* ── D2: mid stem (between cuts) ── */}
      <polygon
        points={pts([
          [L, aY0 + HG],
          [stemR, aAtStemR + HG],
          [stemR, bAtStemR - HG],
          [L, bY0 - HG],
        ])}
      />

      {/* ── D3: lower stem + bottom bar (below cut B) ── */}
      <polygon
        points={pts([
          [L, bY0 + HG],
          [stemR, bAtStemR + HG],
          [stemR, 110 - bh], // bottom bar top (y=96)
          [barR, 110 - bh],
          [barR, 110],
          [L, 110],
        ])}
      />

      {/* ── D4: upper bowl (above cut A) ──
          Outer boundary: (barR,10) → (82,28) → (82, aAtR−HG)
          Inner boundary reversed: (72, aAtInnerR−HG) → (72,36) → (barR,24)
          Plus the right edge of the top bar already covered by D1, so we
          connect along the cut line.
      */}
      <polygon
        points={pts([
          [barR, 10],
          [82, 28],
          [82, aAtR - HG],
          [72, aAtInnerR - HG],
          [72, 36],
          [barR, 24],
        ])}
      />

      {/* ── D5: mid bowl (between cuts) ── */}
      <polygon
        points={pts([
          [82, aAtR + HG],
          [82, 60],
          [82, bAtR - HG],
          [72, bAtInnerR - HG],
          [72, 60],
          [72, aAtInnerR + HG],
        ])}
      />

      {/* ── D6: lower bowl (below cut B) ── */}
      <polygon
        points={pts([
          [82, bAtR + HG],
          [82, 92],
          [barR, 110],
          [barR, 96],
          [72, 84],
          [72, bAtInnerR + HG],
        ])}
      />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// o  (lowercase, x=92, w=60)  x-height y=22..98
//
// Letterform: thick oval ring.
//   Outer rect: 92..152, 22..98  (w=60, h=76)
//   Inner cutout: 106..138, 36..84  (stroke≈14 px each side)
//
// Fracture lines (two diagonal cuts):
//   Cut A: (92, 46) → (152, 40)   upper, rising left-to-right
//   Cut B: (92, 74) → (152, 80)   lower, falling left-to-right
//
// Shards:
//   o1: top ring arc    (above cut A)
//   o2: left ring strip (left side between cuts — outer only, inner is air)
//   o3: right ring strip (right side between cuts)
//   o4: bottom ring arc (below cut B)
// ─────────────────────────────────────────────────────────────────────────────
function ShardsO_lower() {
  const ox = 92,
    or_ = 152;
  const oy0 = 22,
    oy1 = 98;
  const sw = 14;
  const ix = ox + sw,
    ir = or_ - sw; // 106, 138
  const iy0 = oy0 + sw,
    iy1 = oy1 - sw; // 36, 84

  // Cut A: (ox, 46) → (or_, 40)
  const aX0 = ox,
    aY0 = 46,
    aX1 = or_,
    aY1 = 40;
  // Cut B: (ox, 74) → (or_, 80)
  const bX0 = ox,
    bY0 = 74,
    bX1 = or_,
    bY1 = 80;

  const aAtIx = cutY(aX0, aY0, aX1, aY1, ix); // ≈44.6
  const aAtIr = cutY(aX0, aY0, aX1, aY1, ir); // ≈41.4
  const bAtIx = cutY(bX0, bY0, bX1, bY1, ix); // ≈75.4
  const bAtIr = cutY(bX0, bY0, bX1, bY1, ir); // ≈78.6

  return (
    <g>
      {/* o1: top ring segment (above cut A) */}
      <polygon
        points={pts([
          [ox, oy0],
          [or_, oy0], // outer top
          [or_, aY1 - HG], // outer right down to cut A
          [ir, aAtIr - HG], // inner right at cut A
          [ir, iy0], // inner top-right
          [ix, iy0], // inner top-left
          [ix, aAtIx - HG], // inner left at cut A
          [ox, aY0 - HG], // outer left at cut A
        ])}
      />

      {/* o2: left ring strip (between cuts, left thick wall only) */}
      <polygon
        points={pts([
          [ox, aY0 + HG],
          [ix, aAtIx + HG],
          [ix, bAtIx - HG],
          [ox, bY0 - HG],
        ])}
      />

      {/* o3: right ring strip (between cuts, right thick wall only) */}
      <polygon
        points={pts([
          [ir, aAtIr + HG],
          [or_, aY1 + HG],
          [or_, bY1 - HG],
          [ir, bAtIr - HG],
        ])}
      />

      {/* o4: bottom ring segment (below cut B) */}
      <polygon
        points={pts([
          [ox, bY0 + HG], // outer left at cut B
          [ix, bAtIx + HG], // inner left at cut B
          [ix, iy1], // inner bottom-left
          [ir, iy1], // inner bottom-right
          [ir, bAtIr + HG], // inner right at cut B
          [or_, bY1 + HG], // outer right at cut B
          [or_, oy1], // outer bottom-right
          [ox, oy1], // outer bottom-left
        ])}
      />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// r  (lowercase, x=162, w=52)  x-height y=22..98
//
// Letterform:
//   Stem: x=162..176, y=22..98
//   Arm: a thick hook extending right from the stem top.
//        Drawn as a trapezoid: outer top (162..214, y=22..36) narrowing
//        to nothing at y=46, returning along the inner edge.
//        Approximated as: (176,22) → (214,22) → (214,36) → (186,46) → (176,38)
//
// Fracture lines:
//   Cut A: (162, 52) → (176, 46)   upper stem, rising left-to-right
//   Cut B: (162, 76) → (176, 79)   lower stem, falling left-to-right
//
// Shards:
//   r1: arm + upper stem above cut A (all one shard)
//   r2: mid stem between cuts
//   r3: lower stem below cut B
// ─────────────────────────────────────────────────────────────────────────────
function ShardsR() {
  const rx = 162,
    rr = 176; // stem x-range
  const ry0 = 22,
    ry1 = 98;

  // Cut A: (rx, 52) → (rr, 46)
  const aAtL = 52,
    aAtR = 46;
  // Cut B: (rx, 76) → (rr, 79)
  const bAtL = 76,
    bAtR = 79;

  return (
    <g>
      {/* r1: arm + upper stem above cut A
          Path: start at stem bottom-left at cut A, ascend left edge of stem to top,
          traverse arm shape, descend stem right side to cut A.
      */}
      <polygon
        points={pts([
          // cut A bottom edge (left then right)
          [rx, aAtL - HG],
          // up left edge of stem
          [rx, ry0],
          // arm outer shape
          [214, ry0],
          [214, 36],
          [186, 46],
          // back down inner edge of arm to where it meets stem
          [rr, 38],
          // down right edge of stem to cut A
          [rr, aAtR - HG],
        ])}
      />

      {/* r2: mid stem */}
      <polygon
        points={pts([
          [rx, aAtL + HG],
          [rr, aAtR + HG],
          [rr, bAtR - HG],
          [rx, bAtL - HG],
        ])}
      />

      {/* r3: lower stem */}
      <polygon
        points={pts([
          [rx, bAtL + HG],
          [rr, bAtR + HG],
          [rr, ry1],
          [rx, ry1],
        ])}
      />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// k  (lowercase — but tall, x=224, w=63)  cap height y=10..110
//
// Letterform:
//   Stem: x=224..238, y=10..110
//   Upper arm: polygon (238,50) → (238,36) → (287,10) → (287,24)
//   Lower leg: polygon (238,60) → (238,74) → (287,110) → (287,96)
//
// Fracture lines across the stem:
//   Cut A: (224, 44) → (238, 40)  upper stem
//   Cut B: (224, 76) → (238, 80)  lower stem
//
// Shards:
//   k1: upper stem (above cut A)
//   k2: upper arm diagonal shard (detached, with HG gap from stem)
//   k3: mid stem between cuts
//   k4: lower leg diagonal shard (detached)
//   k5: lower stem (below cut B)
// ─────────────────────────────────────────────────────────────────────────────
function ShardsK() {
  const kx = 224,
    kr = 238; // stem x-range (width = 14)

  // Cut A: (kx, 44) → (kr, 40)
  const aAtL = 44,
    aAtR = 40;
  // Cut B: (kx, 76) → (kr, 80)
  const bAtL = 76,
    bAtR = 80;

  return (
    <g>
      {/* k1: upper stem (above cut A) */}
      <polygon
        points={pts([
          [kx, 10],
          [kr, 10],
          [kr, aAtR - HG],
          [kx, aAtL - HG],
        ])}
      />

      {/* k2: upper arm — leave HG gap on the left (stem-adjacent) edge */}
      {/*
        Arm shard occupies the region x > kr+HG.
        Original arm polygon: (238,50)→(238,36)→(287,10)→(287,24)
        With gap: left edge shifts to kr+HG, y values interpolated.
      */}
      <polygon
        points={pts([
          [kr + HG, aAtR + HG], // bottom-left near cut A (gap from stem)
          [kr + HG, 36 - HG], // top-left of arm
          [287, 10],
          [287, 24],
          [kr + HG, 50 - HG], // bottom-right — keep HG from cut-to-stem
        ])}
      />

      {/* k3: mid stem between cuts */}
      <polygon
        points={pts([
          [kx, aAtL + HG],
          [kr, aAtR + HG],
          [kr, bAtR - HG],
          [kx, bAtL - HG],
        ])}
      />

      {/* k4: lower leg (detached diagonal shard) */}
      <polygon
        points={pts([
          [kr + HG, bAtR - HG], // top-left near cut B
          [287, 96],
          [287, 110],
          [kr + HG, 74 + HG], // bottom-left
          [kr + HG, bAtR + HG],
        ])}
      />

      {/* k5: lower stem (below cut B) */}
      <polygon
        points={pts([
          [kx, bAtL + HG],
          [kr, bAtR + HG],
          [kr, 110],
          [kx, 110],
        ])}
      />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// O  (uppercase, x=297, w=74)  cap height y=10..110
//
// Letterform: thick rectangular ring.
//   Outer: 297..371, 10..110
//   Inner: 311..357, 24..96  (stroke ≈14 px each side)
//
// Fracture lines:
//   Cut A: (297, 40) → (371, 32)   upper, rising left-to-right
//   Cut B: (297, 80) → (371, 88)   lower, falling left-to-right
//
// Shards:
//   O1: top ring segment   (above cut A)
//   O2: left ring strip    (left side between cuts)
//   O3: right ring strip   (right side between cuts)
//   O4: bottom ring segment(below cut B)
// ─────────────────────────────────────────────────────────────────────────────
function ShardsO_upper() {
  const ox = 297,
    or_ = 371;
  const sw = 14;
  const ix = ox + sw,
    ir = or_ - sw; // 311, 357
  const iy0 = 10 + sw,
    iy1 = 110 - sw; // 24, 96

  // Cut A: (ox, 40) → (or_, 32)
  const aX0 = ox,
    aY0 = 40,
    aX1 = or_,
    aY1 = 32;
  // Cut B: (ox, 80) → (or_, 88)
  const bX0 = ox,
    bY0 = 80,
    bX1 = or_,
    bY1 = 88;

  const aAtIx = cutY(aX0, aY0, aX1, aY1, ix); // ≈38.4
  const aAtIr = cutY(aX0, aY0, aX1, aY1, ir); // ≈33.6
  const bAtIx = cutY(bX0, bY0, bX1, bY1, ix); // ≈81.6
  const bAtIr = cutY(bX0, bY0, bX1, bY1, ir); // ≈86.4

  return (
    <g>
      {/* O1: top ring segment */}
      <polygon
        points={pts([
          [ox, 10],
          [or_, 10], // outer top
          [or_, aY1 - HG], // outer right down to cut A
          [ir, aAtIr - HG], // inner right at cut A
          [ir, iy0], // inner top-right
          [ix, iy0], // inner top-left
          [ix, aAtIx - HG], // inner left at cut A
          [ox, aY0 - HG], // outer left at cut A
        ])}
      />

      {/* O2: left ring strip */}
      <polygon
        points={pts([
          [ox, aY0 + HG],
          [ix, aAtIx + HG],
          [ix, bAtIx - HG],
          [ox, bY0 - HG],
        ])}
      />

      {/* O3: right ring strip */}
      <polygon
        points={pts([
          [ir, aAtIr + HG],
          [or_, aY1 + HG],
          [or_, bY1 - HG],
          [ir, bAtIr - HG],
        ])}
      />

      {/* O4: bottom ring segment */}
      <polygon
        points={pts([
          [ox, bY0 + HG],
          [ix, bAtIx + HG],
          [ix, iy1],
          [ir, iy1],
          [ir, bAtIr + HG],
          [or_, bY1 + HG],
          [or_, 110],
          [ox, 110],
        ])}
      />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// S  (uppercase, x=381, w=62)  cap height y=10..110
//
// Letterform (S built from three bars + two half-stroke connectors):
//   Top bar:              x=381..443, y=10..24
//   Upper-left connector: x=381..395, y=24..58   (left side stroke only)
//   Mid bar:              x=381..443, y=51..65
//   Lower-right connector:x=429..443, y=65..96   (right side stroke only)
//   Bottom bar:           x=381..443, y=96..110
//
// Fracture lines:
//   Cut A: (381, 36) → (443, 30)   across upper region (rising left-to-right)
//   Cut B: (381, 80) → (443, 86)   across lower region (falling left-to-right)
//
// Shards:
//   S1: top bar  (fully above cut A → simple rect)
//   S2: upper connector above cut A
//   S3: upper connector below cut A + mid bar (two rects)
//   S4: lower connector above cut B
//   S5: lower connector below cut B + bottom bar
// ─────────────────────────────────────────────────────────────────────────────
function ShardsS() {
  const sx = 381,
    sr = 443;
  const sw_bar = sr - sx; // 62
  const stemW = 14;

  // Top bar
  const tbY0 = 10,
    tbY1 = 24;
  // Upper-left connector (left stroke of the S)
  const ulX0 = sx,
    ulX1 = sx + stemW; // 381..395
  const ulY0 = tbY1,
    ulY1 = 58; // 24..58 (connects to mid bar)
  // Mid bar
  const mbY0 = 51,
    mbY1 = 65;
  // Lower-right connector (right stroke of S)
  const lrX0 = sr - stemW,
    lrX1 = sr; // 429..443
  const lrY0 = mbY1,
    lrY1 = 96; // 65..96
  // Bottom bar
  const bbY0 = 96,
    bbY1 = 110;

  // Cut A: (sx, 36) → (sr, 30)
  const aX0 = sx,
    aY0 = 36,
    aX1 = sr,
    aY1 = 30;
  // Cut B: (sx, 80) → (sr, 86)
  const bX0 = sx,
    bY0 = 80,
    bX1 = sr,
    bY1 = 86;

  // Cut A crosses the upper connector (x=381..395):
  const aAtUlX0 = aY0; // = 36 (same as aY0 since ulX0=sx)
  const aAtUlX1 = cutY(aX0, aY0, aX1, aY1, ulX1); // ≈34.6

  // Cut B crosses the lower connector (x=429..443):
  const bAtLrX0 = cutY(bX0, bY0, bX1, bY1, lrX0); // ≈84.4
  const bAtLrX1 = bY1; // = 86 (same as bY1 since lrX1=sr)

  return (
    <g>
      {/* S1: top bar (rect above cut A — bar is y=10..24, cut A starts at y=36 so fully above) */}
      <rect x={sx} y={tbY0} width={sw_bar} height={tbY1 - tbY0} />

      {/* S2: upper-left connector piece above cut A (y=24..36 on left stroke) */}
      <polygon
        points={pts([
          [ulX0, ulY0 + HG],
          [ulX1, ulY0 + HG],
          [ulX1, aAtUlX1 - HG],
          [ulX0, aAtUlX0 - HG],
        ])}
      />

      {/* S3a: upper-left connector below cut A (y=36..58 on left stroke) */}
      <polygon
        points={pts([
          [ulX0, aAtUlX0 + HG],
          [ulX1, aAtUlX1 + HG],
          [ulX1, ulY1],
          [ulX0, ulY1],
        ])}
      />

      {/* S3b: mid bar (fully between the two cuts — cut A ends at y=30 top, cut B starts at y=80 bottom;
               mid bar is y=51..65, safely between cuts) */}
      <rect x={sx} y={mbY0} width={sw_bar} height={mbY1 - mbY0} />

      {/* S4: lower-right connector above cut B (y=65..~84 on right stroke) */}
      <polygon
        points={pts([
          [lrX0, lrY0 + HG],
          [lrX1, lrY0 + HG],
          [lrX1, bAtLrX1 - HG],
          [lrX0, bAtLrX0 - HG],
        ])}
      />

      {/* S5a: lower-right connector below cut B (y=~84..96 on right stroke) */}
      <polygon
        points={pts([
          [lrX0, bAtLrX0 + HG],
          [lrX1, bAtLrX1 + HG],
          [lrX1, lrY1],
          [lrX0, lrY1],
        ])}
      />

      {/* S5b: bottom bar */}
      <rect x={sx} y={bbY0} width={sw_bar} height={bbY1 - bbY0} />
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Root component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "DorkOS" wordmark rendered as geometric shards.
 *
 * Each letter is fractured along intentional diagonal stress lines into
 * 3–5 solid black polygons. The 3 px gaps between shards are the only
 * visual break — no outlines, no colour, just geometry.
 */
export function Logo20() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 480 120"
      fill="#000"
      role="img"
      aria-label="DorkOS"
    >
      <title>DorkOS</title>
      <ShardsD />
      <ShardsO_lower />
      <ShardsR />
      <ShardsK />
      <ShardsO_upper />
      <ShardsS />
    </svg>
  );
}
