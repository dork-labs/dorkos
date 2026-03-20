'use client';

const pulsePath =
  'M0,30 L80,30 L100,30 L110,10 L120,50 L130,20 L140,40 L150,30 L180,30 L200,30 L210,10 L220,50 L230,20 L240,40 L250,30 L280,30 L300,30 L310,10 L320,50 L330,20 L340,40 L350,30 L400,30';

/** Animated SVG heartbeat/EKG pulse line for the hero section. */
export function PulseAnimation() {
  return (
    <div className="mx-auto mt-12 w-full max-w-md opacity-40">
      <svg
        viewBox="0 0 400 60"
        className="h-auto w-full"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <filter id="pulse-glow">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>

        {/* Ghost path — always visible, full shape at low opacity */}
        <path
          d={pulsePath}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.1"
        />

        {/* Glow layer — blurred duplicate for CRT effect */}
        <path
          d={pulsePath}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.4"
          filter="url(#pulse-glow)"
          className="animate-pulse-draw"
        />

        {/* Main animated stroke */}
        <path
          d={pulsePath}
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-pulse-draw"
        />
      </svg>
    </div>
  );
}
