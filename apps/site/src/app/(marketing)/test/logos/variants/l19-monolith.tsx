'use client';

/**
 * Logo19 — "DORK" as a single continuous path.
 *
 * All four letters are joined by one unbroken stroke — no pen lifts, no gaps.
 * Blocky, angular letterforms. A single `<path>` element, solid black (#000) fill.
 *
 * Technique: the path traces each letter's outer perimeter clockwise, uses a
 * hairline bridge along the bottom baseline to thread into each inner counter-
 * shape, then traces the counter counter-clockwise (punching it as a hole via
 * the evenodd fill rule), and bridges on to the next letter. One M, one Z.
 *
 * ViewBox: 0 0 450 120
 * Letter height: 100px  (y: 10 → 110)
 * Stroke weight (W): 20px
 *
 * Letter x-ranges (outer):
 *   D   10 → 106
 *   O  120 → 216
 *   R  230 → 326
 *   K  340 → 440
 */
export function Logo19() {
  // ── shared vertical constants ───────────────────────────────────────────
  const T = 10; // top of all letters
  const B = 110; // bottom of all letters
  const W = 20; // stroke / pen weight (px)
  const Ti = T + W; // inner top  = 30
  const Bi = B - W; // inner bot  = 90

  // ── D ──────────────────────────────────────────────────────────────────
  // Outer D: left spine + top bar + angled right cap + bottom bar
  //   The right side is beveled: (92,10)→(106,30)→(106,90)→(92,110)
  // Inner bowl: rectangular counter inside the D
  const dxL = 10; // outer left
  const dxRS = 92; // outer right shoulder (where bevel starts/ends)
  const dxR = 106; // outer rightmost wall
  const dxIL = 30; // inner left  = dxL + W
  const dxIS = 84; // inner right shoulder
  const dxIM = 92; // inner right mid-bulge (matches outer right shoulder)

  // ── O ──────────────────────────────────────────────────────────────────
  const oxL = 120;
  const oxR = 216;
  const oxIL = oxL + W; // 140
  const oxIR = oxR - W; // 196

  // ── R ──────────────────────────────────────────────────────────────────
  // R: left spine (full height) + arch (top half) + mid-bar + diagonal leg
  //   Arch outer right = 316, arch inner right = 296
  //   Mid-bar: y = 50..70
  //   Diagonal leg: from (250, 70) → (326, 110)  [outer]
  //                 from (270, 70) → (306, 110)   [inner]
  const rxL = 230;
  const rxAR = 316; // arch outer right x
  const rxAIR = 296; // arch inner right x  = rxAR - W
  const rxIL = rxL + W; // spine inner right x = 250
  const rMidT = 50; // mid-bar top y
  const rMidB = 70; // mid-bar bottom y
  const rxLegO = 326; // leg outer tip x
  const rxLegI = rxLegO - W; // leg inner tip x = 306

  // ── K ──────────────────────────────────────────────────────────────────
  // K: left spine (full height) + upper arm + lower arm
  //   Upper arm outer: (360, 60) → (440, 10)   — outer top edge
  //   Upper arm inner: (440, 30) → (360, 60)   — inner bottom edge
  //   Junction at spine: y = 60  (midpoint, since T=10 B=110 mid=60)
  //   Lower arm outer: (360, 60) → (440, 110)
  //   Lower arm inner: (420, 110) → (360, 80)
  const kxL = 340;
  const kxR = 440; // arm tips
  const kxIL = kxL + W; // spine inner edge = 360
  const kMid = (T + B) / 2; // 60 — vertical mid, where arms meet spine

  // ── PATH ───────────────────────────────────────────────────────────────
  //
  // Winding rule:
  //   Outer letter shells → CLOCKWISE (fills solid in SVG Y-down coords)
  //   Inner counter voids → COUNTER-CLOCKWISE (punched as holes by evenodd)
  //
  // The baseline at y=110 acts as a return highway: every time we close an
  // outer shell or inner counter we slide along y=110 to the next section.
  // The bridge segments are zero-height collinear moves that keep the path
  // continuous without creating visible artifacts.

  const d = [
    // ════════════════════════════════════════════════════════════════════
    // D outer shell — CLOCKWISE
    // Starting point: bottom-left corner of D
    // ════════════════════════════════════════════════════════════════════
    `M ${dxL} ${B}`, // (10, 110)  — start
    `L ${dxL} ${T}`, // (10,  10)  — up left spine
    `L ${dxRS} ${T}`, // (92,  10)  — top bar →
    `L ${dxR} ${Ti}`, // (106, 30)  — bevel top-right
    `L ${dxR} ${Bi}`, // (106, 90)  — down right wall
    `L ${dxRS} ${B}`, // (92, 110)  — bevel bottom-right

    // Hairline return bridge → inner counter entry
    `L ${dxIL} ${B}`, // (30, 110)  — slide left to inner-left

    // D inner counter — COUNTER-CLOCKWISE (subtracts the bowl)
    // From (30,110): up → right → up-right → up-left → left → down
    `L ${dxIL} ${Bi}`, // (30,  90)  ↑
    `L ${dxIS} ${Bi}`, // (84,  90)  →
    `L ${dxIM} ${(T + B) / 2}`, // (92,  60)  ↑ (right-wall midpoint bulge)
    `L ${dxIS} ${Ti}`, // (84,  30)  ↑
    `L ${dxIL} ${Ti}`, // (30,  30)  ←
    `L ${dxIL} ${B}`, // (30, 110)  ↓ — CCW loop complete

    // Bridge D → O
    `L ${oxL} ${B}`, // (120, 110)

    // ════════════════════════════════════════════════════════════════════
    // O outer shell — CLOCKWISE
    // ════════════════════════════════════════════════════════════════════
    `L ${oxL} ${T}`, // (120,  10)  ↑
    `L ${oxR} ${T}`, // (216,  10)  →
    `L ${oxR} ${B}`, // (216, 110)  ↓

    // Hairline return bridge → inner counter entry
    `L ${oxIL} ${B}`, // (140, 110)  ← slide to inner-left

    // O inner counter — COUNTER-CLOCKWISE
    `L ${oxIL} ${Bi}`, // (140,  90)  ↑
    `L ${oxIR} ${Bi}`, // (196,  90)  →
    `L ${oxIR} ${Ti}`, // (196,  30)  ↑
    `L ${oxIL} ${Ti}`, // (140,  30)  ←
    `L ${oxIL} ${B}`, // (140, 110)  ↓ — CCW loop complete

    // Bridge O → R
    `L ${rxL} ${B}`, // (230, 110)

    // ════════════════════════════════════════════════════════════════════
    // R outer shell — CLOCKWISE
    // Outer trace: spine up → top bar → arch right → mid-bar outward
    // Then CCW inner arch counter (bowl)
    // Then diagonal leg strip (both edges + baseline bridge)
    // ════════════════════════════════════════════════════════════════════

    // Up the spine
    `L ${rxL} ${T}`, // (230,  10)  ↑

    // Top bar across to arch
    `L ${rxAR} ${T}`, // (316,  10)  →

    // Down arch outer right wall to mid-bar top
    `L ${rxAR} ${rMidT}`, // (316,  50)  ↓

    // Mid-bar: trace its top surface inward to spine (right→left along top)
    `L ${rxIL} ${rMidT}`, // (250,  50)  ←

    // Step down across mid-bar height
    `L ${rxIL} ${rMidB}`, // (250,  70)  ↓

    // Mid-bar: trace its bottom surface outward (left→right along bottom)
    `L ${rxAIR} ${rMidB}`, // (296,  70)  →

    // ── R arch inner counter — COUNTER-CLOCKWISE ──────────────────────
    // This punches the bowl above the mid-bar.
    // From (296,70): up → left → down (CCW in Y-down)
    `L ${rxAIR} ${Ti}`, // (296,  30)  ↑
    `L ${rxIL} ${Ti}`, // (250,  30)  ←
    `L ${rxIL} ${rMidB}`, // (250,  70)  ↓ — CCW complete, back to junction

    // ── R diagonal leg ────────────────────────────────────────────────
    // The leg is a thick diagonal strip starting at (rxIL, rMidB) = (250,70)
    // Outer edge runs diagonally from (250,70) → (326,110)
    `L ${rxLegO} ${B}`, // (326, 110)  — outer leg tip

    // Step inward: inner leg tip
    `L ${rxLegI} ${B}`, // (306, 110)  ←

    // Inner edge runs back up-left from (306,110) → (270,70)
    `L ${rxIL + W} ${rMidB}`, // (270,  70)  — inner leg root at spine

    // Drop straight down inner leg root to baseline
    `L ${rxIL + W} ${B}`, // (270, 110)  ↓

    // Bridge R → K
    `L ${kxL} ${B}`, // (340, 110)

    // ════════════════════════════════════════════════════════════════════
    // K — spine + upper arm + lower arm — CLOCKWISE overall
    // ════════════════════════════════════════════════════════════════════

    // Up the left outer spine
    `L ${kxL} ${T}`, // (340,  10)  ↑

    // Across inner spine top
    `L ${kxIL} ${T}`, // (360,  10)  →

    // Down inner spine to where upper arm roots (W above mid)
    `L ${kxIL} ${kMid - W}`, // (360,  40)  ↓ — upper arm outer root

    // Upper arm: parallelogram strip, W px wide throughout
    // Outer edge: (360,40) → (440,10)
    `L ${kxR} ${T}`, // (440,  10)  — outer upper arm tip

    // Step to inner upper arm tip (W below outer tip at x=440)
    `L ${kxR} ${T + W}`, // (440,  30)  ↓

    // Inner upper arm edge returns toward spine
    // Inner root lands at kMid (= 60), W below the outer root (40)
    `L ${kxIL} ${kMid}`, // (360,  60)  — inner upper arm root

    // Lower arm: outer edge starts exactly where inner upper arm ends
    // Outer edge: (360,60) → (440,110)
    `L ${kxR} ${B}`, // (440, 110)  — outer lower arm tip

    // Step inward: inner lower arm tip (W left of outer tip)
    `L ${kxR - W} ${B}`, // (420, 110)  ←

    // Inner lower arm edge returns toward spine
    // Inner root lands at kMid+W (= 80), W below the outer start
    `L ${kxIL} ${kMid + W}`, // (360,  80)  — inner lower arm root

    // Drop inner spine down to baseline
    `L ${kxIL} ${B}`, // (360, 110)  ↓

    // Close K outer left
    `L ${kxL} ${B}`, // (340, 110)

    // ════════════════════════════════════════════════════════════════════
    'Z',
  ].join(' ');

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 450 120"
      fill="#000"
      fillRule="evenodd"
      role="img"
      aria-label="DORK"
    >
      <title>DORK</title>
      <path d={d} />
    </svg>
  );
}
