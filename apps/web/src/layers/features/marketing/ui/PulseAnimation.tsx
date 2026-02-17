'use client'

/** Animated SVG heartbeat/EKG pulse line for the hero section. */
export function PulseAnimation() {
  return (
    <div className="w-full max-w-md mx-auto mt-12 opacity-40">
      <svg
        viewBox="0 0 400 60"
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <path
          d="M0,30 L80,30 L100,30 L110,10 L120,50 L130,20 L140,40 L150,30 L180,30 L200,30 L210,10 L220,50 L230,20 L240,40 L250,30 L280,30 L300,30 L310,10 L320,50 L330,20 L340,40 L350,30 L400,30"
          fill="none"
          stroke="var(--color-brand-orange)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-pulse-draw"
        />
      </svg>
      <style jsx>{`
        .animate-pulse-draw {
          stroke-dasharray: 800;
          stroke-dashoffset: 800;
          animation: draw-pulse 3s ease-in-out infinite;
        }
        @keyframes draw-pulse {
          0% {
            stroke-dashoffset: 800;
          }
          50% {
            stroke-dashoffset: 0;
          }
          100% {
            stroke-dashoffset: -800;
          }
        }
      `}</style>
    </div>
  )
}
