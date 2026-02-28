import { ImageResponse } from 'next/og'

export const runtime = 'edge'

export const alt = 'DorkOS - The operating system for autonomous AI agents'
export const size = {
  width: 1200,
  height: 630,
}
export const contentType = 'image/png'

export default async function Image() {
  return new ImageResponse(
    (
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
        {/* Dorkian logo SVG -- geometric DORK lettering in white */}
        <svg
          width="400"
          height="138"
          viewBox="0 0 2325 799"
          fill="none"
          style={{ marginBottom: '40px' }}
        >
          <rect
            x="50"
            y="50"
            width="2225"
            height="699"
            stroke="#FFFFFF"
            strokeWidth="100"
          />
          <path
            d="M200 599V200H492L599.5 296V491.5L492 599H200Z"
            fill="#FFFFFF"
          />
          <path
            d="M699.5 599V296.5L802.5 200H1108V497.5L1001 599H699.5Z"
            fill="#FFFFFF"
          />
          <path
            d="M1208 599V200H1616.5L1509.5 395L1616.5 599L1409 499.5L1208 599Z"
            fill="#FFFFFF"
          />
          <path
            d="M1716.5 599V200L1917.5 291.5L2125 200L2017.5 400L2125 599H1917.5H1716.5Z"
            fill="#FFFFFF"
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
      </div>
    ),
    { ...size }
  )
}
