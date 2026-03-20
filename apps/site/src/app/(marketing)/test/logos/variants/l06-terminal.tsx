'use client';

export function Logo06() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 100" role="img" aria-label="DorkOS">
      <style>{`
        @keyframes blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        .cursor { animation: blink 1s step-end infinite; }
      `}</style>

      {/*
        All letters drawn as pure geometric rectangles — monospace terminal aesthetic.
        Each glyph occupies a 56px-wide cell with 8px kerning gap between letters.
        Cap height: 72px, baseline at y=14, top at y=14, bottom at y=86.
        Stroke weight: 10px for all strokes.
        Glyph cells: D@0, o@64, r@128, k@192, O@256, S@320. Cursor@384.
      */}

      {/* ── D ── */}
      {/* vertical left stroke */}
      <rect x="0" y="14" width="10" height="72" fill="#000" />
      {/* top horizontal bar */}
      <rect x="0" y="14" width="46" height="10" fill="#000" />
      {/* bottom horizontal bar */}
      <rect x="0" y="76" width="46" height="10" fill="#000" />
      {/* right vertical cap — partial height to form the D curve */}
      <rect x="46" y="24" width="10" height="52" fill="#000" />

      {/* ── o ── (lowercase, vertically centered; x-height 44px, y=28..72) */}
      {/* top bar */}
      <rect x="64" y="28" width="46" height="10" fill="#000" />
      {/* bottom bar */}
      <rect x="64" y="62" width="46" height="10" fill="#000" />
      {/* left stroke */}
      <rect x="64" y="28" width="10" height="44" fill="#000" />
      {/* right stroke */}
      <rect x="100" y="28" width="10" height="44" fill="#000" />

      {/* ── r ── (lowercase; x-height zone y=28..86) */}
      {/* left vertical stroke */}
      <rect x="128" y="28" width="10" height="58" fill="#000" />
      {/* top horizontal arm */}
      <rect x="128" y="28" width="46" height="10" fill="#000" />
      {/* right shoulder — short vertical drop from arm */}
      <rect x="164" y="38" width="10" height="16" fill="#000" />

      {/* ── k ── (lowercase; full cap height y=14..86) */}
      {/* left vertical stroke */}
      <rect x="192" y="14" width="10" height="72" fill="#000" />
      {/* upper diagonal arm — from mid-left to upper-right */}
      {/* rendered as a thin parallelogram via polygon */}
      <polygon points="202,52 202,40 238,28 238,40" fill="#000" />
      {/* lower diagonal leg — from mid-left to lower-right */}
      <polygon points="202,56 202,68 238,80 238,68" fill="#000" />

      {/* ── O ── (uppercase; full cap height y=14..86) */}
      {/* top bar */}
      <rect x="256" y="14" width="46" height="10" fill="#000" />
      {/* bottom bar */}
      <rect x="256" y="76" width="46" height="10" fill="#000" />
      {/* left stroke */}
      <rect x="256" y="14" width="10" height="72" fill="#000" />
      {/* right stroke */}
      <rect x="292" y="14" width="10" height="72" fill="#000" />

      {/* ── S ── (uppercase; full cap height y=14..86) */}
      {/* top bar */}
      <rect x="320" y="14" width="46" height="10" fill="#000" />
      {/* middle bar */}
      <rect x="320" y="49" width="46" height="10" fill="#000" />
      {/* bottom bar */}
      <rect x="320" y="76" width="46" height="10" fill="#000" />
      {/* upper-left vertical (top half, left side) */}
      <rect x="320" y="14" width="10" height="45" fill="#000" />
      {/* lower-right vertical (bottom half, right side) */}
      <rect x="356" y="49" width="10" height="37" fill="#000" />

      {/* ── Blinking block cursor ── */}
      <rect className="cursor" x="384" y="14" width="36" height="72" fill="#000" />
    </svg>
  );
}
