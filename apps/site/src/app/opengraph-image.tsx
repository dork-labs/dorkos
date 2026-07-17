import { ImageResponse } from 'next/og';
import { OG_COLORS, OG_FONT_SANS, OG_SIZE, OgAccentStripes, loadOgFonts } from '@/lib/og';

export const alt = 'DorkOS: mission control for every coding agent you run';
export const size = OG_SIZE;
export const contentType = 'image/png';

/**
 * Root Open Graph card — the dark hero used for the home page and every route
 * that doesn't override its own image. Renders in the brand sans (IBM Plex Sans)
 * loaded from disk on the Node runtime.
 */
export default async function Image() {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    <div
      style={{
        background: `linear-gradient(135deg, ${OG_COLORS.darkStart} 0%, ${OG_COLORS.darkEnd} 100%)`,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        padding: '60px',
      }}
    >
      {/* Dorkian logo SVG — matches DorkLogo component (packages/icons) */}
      <svg
        width="400"
        height="138"
        viewBox="0 0 2325 799"
        fill="none"
        style={{ marginBottom: '40px' }}
      >
        <rect x="50" y="50" width="2225" height="699" stroke="#FFFFFF" strokeWidth="100" />
        <path
          d="M492.333 199.627L599.833 295.627L600 295.776V491.707L492.207 599.5H199.5V199.5H492.19L492.333 199.627ZM334 347.5V448.5H435V347.5H334Z"
          fill="#FFFFFF"
        />
        <path
          d="M1108.5 497.715L1108.34 497.862L1001.34 599.362L1001.2 599.5H699V296.283L699.158 296.135L802.158 199.635L802.303 199.5H1108.5V497.715ZM855 347.5V448.5H956V347.5H855Z"
          fill="#FFFFFF"
        />
        <path
          d="M1616.94 200.24L1510.07 395.005L1616.94 598.768L1617.64 600.103L1616.28 599.451L1409 500.056L1208.22 599.448L1207.5 599.806V199.5H1617.34L1616.94 200.24ZM1332 337.5V439.207L1433.71 337.5H1332Z"
          fill="#FFFFFF"
        />
        <path
          d="M1716.5 599V200L1841 291.5L2125 200L2017.5 400L2125 599L1841 501L1716.5 599Z"
          fill="#FFFFFF"
          stroke="#FFFFFF"
        />
      </svg>

      {/* Headline */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <span
          style={{
            fontSize: '72px',
            fontWeight: 700,
            fontFamily: OG_FONT_SANS,
            color: OG_COLORS.white,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
          }}
        >
          You, multiplied.
        </span>
        <span
          style={{
            fontSize: '40px',
            fontWeight: 700,
            fontFamily: OG_FONT_SANS,
            color: OG_COLORS.brandOrange,
            letterSpacing: '-0.03em',
            lineHeight: 1.2,
            textAlign: 'center',
            marginTop: '8px',
          }}
        >
          Every agent you run. One cockpit.
        </span>
      </div>

      {/* Tagline */}
      <span
        style={{
          fontSize: '24px',
          fontFamily: OG_FONT_SANS,
          color: OG_COLORS.darkMuted,
          marginTop: '24px',
          fontWeight: 400,
        }}
      >
        Claude Code · Codex · OpenCode
      </span>

      {OgAccentStripes({ thickness: 4 })}
    </div>,
    { ...size, fonts }
  );
}
