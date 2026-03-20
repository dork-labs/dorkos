'use client';

/**
 * Logo07 — "DORK" in bold blocky type with a static glitch/slice effect.
 *
 * Three horizontal slices of the letterforms are rendered at different
 * x-offsets, simulating a data-corruption glitch displacement. ClipPaths
 * carve the text into bands; each band copy is shifted independently.
 *
 * Slice boundaries (viewBox height 120):
 *   Top band    y 0–38    offset  +0 px  (anchored)
 *   Middle band y 38–76   offset  -6 px  (shifted left)
 *   Bottom band y 76–120  offset  +5 px  (shifted right)
 */
export function Logo07() {
  // Letter geometry constants — makes slice offsets easier to reason about.
  // All coordinates are in the 450×120 viewBox.

  // Horizontal slice boundaries
  const TOP_Y = 0;
  const MID_Y = 38;
  const BOT_Y = 76;
  const END_Y = 120;

  // Per-slice x translation (glitch displacement)
  const TOP_DX = 0;
  const MID_DX = -6;
  const BOT_DX = 5;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 450 120"
      fill="#000"
      role="img"
      aria-label="DORK"
    >
      <defs>
        {/* Three horizontal clip bands */}
        <clipPath id="l07-clip-top">
          <rect x="-20" y={TOP_Y} width="510" height={MID_Y - TOP_Y} />
        </clipPath>
        <clipPath id="l07-clip-mid">
          <rect x="-20" y={MID_Y} width="510" height={BOT_Y - MID_Y} />
        </clipPath>
        <clipPath id="l07-clip-bot">
          <rect x="-20" y={BOT_Y} width="510" height={END_Y - BOT_Y} />
        </clipPath>
      </defs>

      {/* ── Top slice (anchored) ── */}
      <g clipPath="url(#l07-clip-top)" transform={`translate(${TOP_DX}, 0)`}>
        <Letterforms />
      </g>

      {/* ── Middle slice (shifted left) ── */}
      <g clipPath="url(#l07-clip-mid)" transform={`translate(${MID_DX}, 0)`}>
        <Letterforms />
      </g>

      {/* ── Bottom slice (shifted right) ── */}
      <g clipPath="url(#l07-clip-bot)" transform={`translate(${BOT_DX}, 0)`}>
        <Letterforms />
      </g>
    </svg>
  );
}

/**
 * Raw letterform paths for "DORK" in a 450×120 viewBox.
 *
 * Each letter occupies a generous column with 14 px of padding between
 * letters. Strokes are all solid filled shapes — no stroke attributes —
 * so clipping works cleanly.
 *
 * Column layout (x origin, width):
 *   D  x=10   w=90
 *   O  x=118  w=90
 *   R  x=226  w=96
 *   K  x=340  w=100
 */
function Letterforms() {
  return (
    <>
      {/* ── D ── */}
      {/* Left vertical stroke */}
      <rect x="10" y="10" width="16" height="100" />
      {/* Top horizontal bar */}
      <rect x="10" y="10" width="70" height="16" />
      {/* Bottom horizontal bar */}
      <rect x="10" y="94" width="70" height="16" />
      {/*
        Right curved cap: a thick arc closing the bowl.
        Approximated with a filled path: outer arc minus inner arc.
      */}
      <path
        d="
        M 80 10
        Q 100 10 100 60
        Q 100 110 80 110
        L 60 110
        Q 84 110 84 60
        Q 84 10 60 10
        Z
      "
      />
      {/* Bridge fill connecting bars to curve cap */}
      <rect x="60" y="10" width="20" height="16" />
      <rect x="60" y="94" width="20" height="16" />

      {/* ── O ── */}
      {/* Outer filled rect */}
      <rect x="118" y="10" width="90" height="100" />
      {/* Inner cutout (bowl) */}
      <rect x="136" y="28" width="54" height="64" fill="white" />

      {/* ── R ── */}
      {/* Left vertical stroke */}
      <rect x="226" y="10" width="16" height="100" />
      {/* Top horizontal bar */}
      <rect x="226" y="10" width="64" height="16" />
      {/* Mid horizontal bar (bowl base) */}
      <rect x="226" y="56" width="64" height="16" />
      {/* Right vertical of bowl (top half only) */}
      <rect x="274" y="26" width="16" height="30" />
      {/*
        Diagonal leg: from mid-right down to bottom-right.
        A parallelogram drawn as a polygon.
      */}
      <polygon points="242,72 258,72 322,110 306,110" />

      {/* ── K ── */}
      {/* Left vertical stroke */}
      <rect x="340" y="10" width="16" height="100" />
      {/*
        Upper arm: diagonal from mid-left up to top-right.
        Polygon: thick diagonal band.
      */}
      <polygon points="356,56 356,42 440,10 440,24" />
      {/*
        Lower leg: diagonal from mid-left down to bottom-right.
      */}
      <polygon points="356,64 356,78 440,110 440,96" />
    </>
  );
}
