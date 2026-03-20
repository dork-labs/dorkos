'use client';

/**
 * Logo17 — Architectural crosshatch "DOS".
 *
 * Each letter is a bold, blocky shape filled with a 45-degree crosshatch
 * pattern (diagonal lines in both directions). An SVG <pattern> element
 * defines the mesh, and per-letter <clipPath> elements constrain the fill
 * to each letter's silhouette. Black strokes outline each letter over the
 * hatch, giving the look of technical/architectural drafting.
 *
 * Letter construction (all rect-based, no curves):
 *   D — left vertical slab + top/bottom bars + right cap with inner void
 *   O — thick rectangular ring (outer block minus inner void)
 *   S — top bar + upper-right cap + middle bar + lower-left cap + bottom bar
 */
export function Logo17() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120" role="img" aria-label="DOS">
      <defs>
        {/*
          Crosshatch pattern: 12×12 tile with two diagonal strokes.
          Line 1: top-left → bottom-right (45°)
          Line 2: top-right → bottom-left (135°)
          Extended slightly past tile edges to prevent gaps at seams.
        */}
        <pattern
          id="l17-crosshatch"
          x="0"
          y="0"
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(0)"
        >
          {/* Diagonal \ */}
          <line x1="-2" y1="-2" x2="14" y2="14" stroke="#000" strokeWidth="1.5" />
          {/* Diagonal / */}
          <line x1="14" y1="-2" x2="-2" y2="14" stroke="#000" strokeWidth="1.5" />
        </pattern>

        {/*
          ── D clip path (x: 8..118) ──
          Left vertical slab: x8–26, full height
          Top bar: x8–118, y8–26
          Bottom bar: x8–118, y94–112
          Right cap: x100–118, full height
          Inner void subtracted via evenodd fill rule.
        */}
        <clipPath id="l17-clip-d">
          <path
            fillRule="evenodd"
            d="
              M8,8 H118 V112 H8 Z
              M26,26 H100 V94 H26 Z
            "
          />
        </clipPath>

        {/*
          ── O clip path (x: 132..242) ──
          Outer block minus inner void.
        */}
        <clipPath id="l17-clip-o">
          <path
            fillRule="evenodd"
            d="
              M132,8 H242 V112 H132 Z
              M150,26 H224 V94 H150 Z
            "
          />
        </clipPath>

        {/*
          ── S clip path (x: 256..366) ──
          S is built from five rectangular regions:
            1. Top bar (full width)
            2. Upper-left cap (left side, upper half of top counter)
            3. Middle bar (full width)
            4. Lower-right cap (right side, lower half of bottom counter)
            5. Bottom bar (full width)
          Together these form a blocky S silhouette.
        */}
        <clipPath id="l17-clip-s">
          <rect x="256" y="8" width="110" height="20" /> {/* top bar */}
          <rect x="256" y="8" width="20" height="56" /> {/* upper-left vertical */}
          <rect x="256" y="48" width="110" height="24" /> {/* middle bar */}
          <rect x="346" y="64" width="20" height="48" /> {/* lower-right vertical */}
          <rect x="256" y="92" width="110" height="20" /> {/* bottom bar */}
        </clipPath>
      </defs>

      {/* ── D fill + outline ── */}
      {/* Crosshatch fill clipped to D shape */}
      <rect
        x="8"
        y="8"
        width="110"
        height="104"
        fill="url(#l17-crosshatch)"
        clipPath="url(#l17-clip-d)"
      />
      {/* D outline strokes — outer rect */}
      <path
        fillRule="evenodd"
        d="M8,8 H118 V112 H8 Z M26,26 H100 V94 H26 Z"
        fill="none"
        stroke="#000"
        strokeWidth="2"
      />

      {/* ── O fill + outline ── */}
      <rect
        x="132"
        y="8"
        width="110"
        height="104"
        fill="url(#l17-crosshatch)"
        clipPath="url(#l17-clip-o)"
      />
      <path
        fillRule="evenodd"
        d="M132,8 H242 V112 H132 Z M150,26 H224 V94 H150 Z"
        fill="none"
        stroke="#000"
        strokeWidth="2"
      />

      {/* ── S fill + outline ── */}
      {/* Crosshatch fill clipped to S shape */}
      <rect
        x="256"
        y="8"
        width="110"
        height="104"
        fill="url(#l17-crosshatch)"
        clipPath="url(#l17-clip-s)"
      />
      {/*
        S outline: draw each rectangular block individually so the strokes
        follow the block edges and produce a clear blocky S silhouette.
      */}
      {/* top bar outline */}
      <rect x="256" y="8" width="110" height="20" fill="none" stroke="#000" strokeWidth="2" />
      {/* upper-left cap outline */}
      <rect x="256" y="8" width="20" height="56" fill="none" stroke="#000" strokeWidth="2" />
      {/* middle bar outline */}
      <rect x="256" y="48" width="110" height="24" fill="none" stroke="#000" strokeWidth="2" />
      {/* lower-right cap outline */}
      <rect x="346" y="64" width="20" height="48" fill="none" stroke="#000" strokeWidth="2" />
      {/* bottom bar outline */}
      <rect x="256" y="92" width="110" height="20" fill="none" stroke="#000" strokeWidth="2" />
    </svg>
  );
}
