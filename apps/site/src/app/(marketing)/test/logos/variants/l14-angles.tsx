'use client';

/**
 * Logo14 — Ultra-angular "DORK" where every corner is chamfered at 45 degrees.
 * No right angles exist anywhere: every terminal, junction, and interior corner
 * is sliced at 45 degrees, giving the letterforms a razor-sharp, aggressive feel.
 *
 * Construction notes (stroke thickness = 22px, chamfer offset = 10px):
 *   - All rectangles are replaced by octagons (4-corner chamfers).
 *   - Diagonal strokes terminate in parallelogram-style 45-degree cuts.
 *   - Interior corners (where two strokes meet) are mitered at 45 degrees.
 */
export function Logo14() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 460 120"
      fill="#000"
      role="img"
      aria-label="DORK"
    >
      {/* ─────────────────────────────────────────────────────────────
          D  (x: 8–98)
          Thick vertical spine on the left, a chunky right-side bow.
          Every corner of the outer shape and the inner cutout is
          chamfered 10 px at 45 degrees.

          Outer polygon (clockwise from top-left, chamfered):
            TL: (18,8)→(8,18)  top chamfer
            TR-top: continues along top bar → bow apex
            BR-bottom: bow apex → right rail → bottom bar
            BL: (8,102)→(18,112)  bottom chamfer (mirrored)

          Rather than decomposing into separate rects, we define the
          full outer contour as one polygon and punch out the inner
          void with a second polygon using the SVG fill-rule evenodd.
      ─────────────────────────────────────────────────────────────── */}
      <path
        fillRule="evenodd"
        d={[
          /* Outer D contour — every corner chamfered 10 px */
          /* Start at top-left chamfer bottom point */
          'M 8,18',
          /* top-left chamfer */
          'L 18,8',
          /* top edge across spine + top bar */
          'L 68,8',
          /* top-right bow curve rendered as angular segments */
          /* The bow right side is approximated by a polygon bulge */
          'L 78,8' /* top-bar right end (chamfer into bow) */,
          'L 88,18' /* top-right chamfer of bow cap */,
          'L 98,38' /* bow upper-right angled side */,
          'L 98,82' /* bow lower-right angled side */,
          'L 88,102' /* bottom-right chamfer of bow cap */,
          'L 78,112' /* bottom bar right end */,
          'L 18,112' /* bottom edge left */,
          'L 8,102' /* bottom-left chamfer */,
          'Z',

          /* Inner cutout — same shape shrunk 20 px on all sides, with chamfers */
          /* Left inner edge at x=28 (spine width=20), top at y=28, bottom at y=92 */
          'M 28,38' /* inner TL chamfer bottom */,
          'L 38,28' /* inner TL chamfer top */,
          'L 64,28' /* inner top bar right */,
          'L 72,36' /* inner top-right chamfer (bow narrowing) */,
          'L 78,50' /* inner bow upper slope */,
          'L 78,70' /* inner bow lower slope */,
          'L 72,84' /* inner bottom-right chamfer */,
          'L 64,92' /* inner bottom bar right */,
          'L 38,92' /* inner bottom bar left */,
          'L 28,82' /* inner BL chamfer */,
          'Z',
        ].join(' ')}
      />

      {/* ─────────────────────────────────────────────────────────────
          O  (x: 112–200)
          A thick angular ring. The outer and inner contours are both
          octagons — 8 sides, each corner cut at 45 degrees.
          Centre: x=156, y=60. Outer half-width=44, inner=24.
      ─────────────────────────────────────────────────────────────── */}
      <path
        fillRule="evenodd"
        d={[
          /* Outer octagon */
          'M 112,28' /* left top chamfer start */,
          'L 122,8' /* top-left chamfer */,
          'L 190,8' /* top edge */,
          'L 200,28' /* top-right chamfer */,
          'L 200,92' /* right edge */,
          'L 190,112' /* bottom-right chamfer */,
          'L 122,112' /* bottom edge */,
          'L 112,92' /* bottom-left chamfer */,
          'Z',

          /* Inner octagon */
          'M 132,38' /* inner left top */,
          'L 140,28' /* inner TL chamfer */,
          'L 172,28' /* inner top */,
          'L 180,38' /* inner TR chamfer */,
          'L 180,82' /* inner right */,
          'L 172,92' /* inner BR chamfer */,
          'L 140,92' /* inner bottom */,
          'L 132,82' /* inner BL chamfer */,
          'Z',
        ].join(' ')}
      />

      {/* ─────────────────────────────────────────────────────────────
          R  (x: 214–310)
          Spine on the left, top arch (filled bowl), angled leg
          kicking out to the lower-right. Every right angle is
          replaced with a 45-degree miter.

          The R is built from three filled polygons:
            1. Spine (vertical stroke, full height)
            2. Bowl (top half rectangular arch — chamfered all corners)
            3. Leg  (diagonal kicking from mid-right to bottom-right)
      ─────────────────────────────────────────────────────────────── */}

      {/* R — spine, chamfered top-left, top-right, bottom-left, bottom-right */}
      <polygon
        points="
        214,18  224,8   236,8   236,102  224,112  214,112
      "
      />

      {/* R — bowl: arch from top of spine to mid; right side vertical */}
      {/* Outer bowl shape: x 224→298, y 8→64 */}
      <path
        fillRule="evenodd"
        d={[
          /* Outer bowl */
          'M 224,8',
          'L 288,8',
          'L 298,18' /* TR chamfer */,
          'L 298,54' /* right side down to mid */,
          'L 288,64' /* BR chamfer (interior junction) */,
          'L 236,64' /* bottom inner edge of bowl */,
          'L 224,64',
          'Z',

          /* Inner cutout of bowl (hollow center) */
          'M 236,28' /* inner TL — junction with spine (no chamfer needed, covered by spine) */,
          'L 244,20' /* inner top-left chamfer */,
          'L 276,20' /* inner top */,
          'L 284,28' /* inner TR chamfer */,
          'L 284,46' /* inner right */,
          'L 276,54' /* inner BR chamfer */,
          'L 236,54',
          'Z',
        ].join(' ')}
      />

      {/* R — diagonal leg: from mid-right junction, angles down to bottom-right */}
      {/* Leg is a parallelogram with 45-degree cuts at both ends */}
      <polygon
        points="
        248,64   298,64
        310,112  260,112
      "
      />

      {/* ─────────────────────────────────────────────────────────────
          K  (x: 324–452)
          Spine on left, upper arm rising to upper-right, lower leg
          descending to lower-right. Every terminal is a 45-degree cut.
          Junction at mid-spine is a sharp V-notch (no rounded join).
      ─────────────────────────────────────────────────────────────── */}

      {/* K — spine */}
      <polygon
        points="
        324,18   334,8   346,8   346,102   334,112   324,112
      "
      />

      {/* K — upper arm: from mid-spine (y≈52) rising to upper-right */}
      {/* Parallelogram: 45-degree cut at spine junction, 45-degree cut at tip */}
      <polygon
        points="
        346,52   346,30
        440,8    452,18
        440,30   356,52
      "
      />

      {/* K — lower leg: from mid-spine (y≈68) descending to lower-right */}
      <polygon
        points="
        346,70   346,90
        440,112  452,102
        440,90   356,70
      "
      />
    </svg>
  );
}
