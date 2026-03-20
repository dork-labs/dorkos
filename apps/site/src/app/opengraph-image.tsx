import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export const alt = 'DorkOS - The operating system for autonomous AI agents';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

export default async function Image() {
  return new ImageResponse(
    <div
      style={{
        background: 'linear-gradient(135deg, #1A1A1A 0%, #2A2A2A 100%)',
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
            fontSize: '48px',
            fontWeight: 700,
            color: '#FFFFFF',
            letterSpacing: '-0.03em',
            lineHeight: 1.2,
          }}
        >
          Your agents are brilliant.
        </span>
        <span
          style={{
            fontSize: '48px',
            fontWeight: 700,
            color: '#E86C3A',
            letterSpacing: '-0.03em',
            lineHeight: 1.2,
            textAlign: 'center',
          }}
        >
          They just can&apos;t do anything
        </span>
        <span
          style={{
            fontSize: '48px',
            fontWeight: 700,
            color: '#E86C3A',
            letterSpacing: '-0.03em',
            lineHeight: 1.2,
          }}
        >
          when you leave.
        </span>
      </div>

      {/* Tagline */}
      <span
        style={{
          fontSize: '24px',
          color: '#9A9A9A',
          marginTop: '24px',
          fontWeight: 300,
        }}
      >
        You slept. They shipped.
      </span>

      {/* Bottom accent stripes */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: '4px', background: '#E86C3A' }} />
        <div style={{ height: '4px', background: '#5B8C5A' }} />
      </div>
    </div>,
    { ...size }
  );
}
