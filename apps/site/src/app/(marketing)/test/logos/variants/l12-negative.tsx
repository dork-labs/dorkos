'use client';

/**
 * Logo12 — Negative space "DORK".
 * A solid black rectangle with the four letters cut out as transparent voids.
 * Letters are bold, blocky, all-caps forms constructed from rect primitives.
 * An SVG <mask> is used: white shapes inside the mask reveal the background
 * (transparent), black shapes block it (solid fill). The result is the inverse
 * of a normal filled logo — the letters become holes in a black field.
 */
export function Logo12() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 120" role="img" aria-label="DORK">
      <defs>
        {/*
          The mask covers the full viewBox.
          Black mask fill = opaque (keeps the black rectangle solid).
          White shapes = transparent cutouts (the letter voids).
        */}
        <mask id="l12-letter-mask">
          {/* Black base — keeps everything opaque by default */}
          <rect x="0" y="0" width="450" height="120" fill="black" />

          {/* ── D  (x: 8..108) ── */}
          {/* Left vertical stroke */}
          <rect x="8" y="8" width="18" height="104" fill="white" />
          {/* Top horizontal bar */}
          <rect x="8" y="8" width="72" height="18" fill="white" />
          {/* Bottom horizontal bar */}
          <rect x="8" y="94" width="72" height="18" fill="white" />
          {/* Right cap — forms the curved right side of D as a thick rect */}
          <rect x="90" y="8" width="18" height="104" fill="white" />
          {/* D bowl bridge — connects cap to top/bottom bars */}
          <rect x="72" y="8" width="18" height="28" fill="white" />
          <rect x="72" y="84" width="18" height="28" fill="white" />

          {/* ── O  (x: 118..228) ── */}
          {/* Full outer block — left stroke */}
          <rect x="118" y="8" width="18" height="104" fill="white" />
          {/* Top bar */}
          <rect x="118" y="8" width="92" height="18" fill="white" />
          {/* Bottom bar */}
          <rect x="118" y="94" width="92" height="18" fill="white" />
          {/* Right stroke */}
          <rect x="192" y="8" width="18" height="104" fill="white" />

          {/* ── R  (x: 238..338) ── */}
          {/* Left vertical stroke */}
          <rect x="238" y="8" width="18" height="104" fill="white" />
          {/* Top horizontal bar */}
          <rect x="238" y="8" width="82" height="18" fill="white" />
          {/* Middle horizontal bar (separates bowl from leg) */}
          <rect x="238" y="56" width="82" height="18" fill="white" />
          {/* Right cap — closes the top bowl */}
          <rect x="302" y="8" width="18" height="66" fill="white" />
          {/* R leg — thick vertical block lower-right */}
          <rect x="294" y="74" width="44" height="38" fill="white" />

          {/* ── K  (x: 348..442) ── */}
          {/* Left vertical stroke */}
          <rect x="348" y="8" width="18" height="104" fill="white" />
          {/* Upper arm — two stair steps toward top-right */}
          <rect x="366" y="42" width="44" height="18" fill="white" />
          <rect x="410" y="8" width="32" height="34" fill="white" />
          {/* Lower arm — mirror stair steps toward bottom-right */}
          <rect x="366" y="60" width="44" height="18" fill="white" />
          <rect x="410" y="78" width="32" height="34" fill="white" />
        </mask>
      </defs>

      {/* Solid black rectangle, masked so letters become transparent voids */}
      <rect x="0" y="0" width="450" height="120" fill="#000" mask="url(#l12-letter-mask)" />
    </svg>
  );
}
