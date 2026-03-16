'use client'

/**
 * Device mockup components for HeroV1 (Device Showcase).
 * Pure CSS/HTML device frames — laptop, tablet, phone.
 */

export interface ParallaxOffset {
  x: number
  y: number
}

const CHARCOAL = '#1A1814'

/** Laptop mockup with screen content placeholder. */
export function LaptopMockup({ offset }: { offset: ParallaxOffset }) {
  return (
    <div
      style={{
        transform: `translate(${offset.x * 1.2}px, ${offset.y * 1.2}px)`,
        transition: 'transform 0.15s ease-out',
      }}
    >
      {/* Screen */}
      <div
        className="rounded-t-lg overflow-hidden"
        style={{
          width: 220,
          height: 140,
          background: CHARCOAL,
          border: '2px solid rgba(139, 90, 43, 0.15)',
          borderBottom: 'none',
        }}
      >
        {/* Fake UI content */}
        <div className="p-3 space-y-2">
          {/* Title bar dots */}
          <div className="flex gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(232,93,4,0.6)' }} />
            <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(34,139,34,0.5)' }} />
            <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(139,90,43,0.3)' }} />
          </div>
          {/* Fake sidebar + content */}
          <div className="flex gap-2 mt-2">
            <div className="space-y-1.5 flex-shrink-0" style={{ width: 50 }}>
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(232,93,4,0.3)', width: '80%' }} />
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.1)', width: '100%' }} />
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.1)', width: '60%' }} />
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', width: '90%' }} />
            </div>
            <div className="flex-1 space-y-1.5">
              <div className="h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.12)', width: '70%' }} />
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', width: '100%' }} />
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', width: '85%' }} />
              <div className="h-8 rounded" style={{ background: 'rgba(232,93,4,0.12)', marginTop: 4 }} />
            </div>
          </div>
        </div>
      </div>
      {/* Base */}
      <div
        style={{
          width: 260,
          height: 12,
          background: 'rgba(139, 90, 43, 0.12)',
          borderRadius: '0 0 8px 8px',
          marginLeft: -20,
          borderTop: '1px solid rgba(139, 90, 43, 0.1)',
        }}
      />
      {/* Hinge notch */}
      <div
        className="mx-auto"
        style={{
          width: 40,
          height: 4,
          background: 'rgba(139, 90, 43, 0.08)',
          borderRadius: '0 0 4px 4px',
        }}
      />
    </div>
  )
}

/** Tablet mockup. */
export function TabletMockup({ offset }: { offset: ParallaxOffset }) {
  return (
    <div
      style={{
        transform: `translate(${offset.x * 0.6}px, ${offset.y * 0.6}px) rotate(6deg)`,
        transition: 'transform 0.15s ease-out',
      }}
    >
      <div
        className="rounded-xl overflow-hidden"
        style={{
          width: 120,
          height: 160,
          background: CHARCOAL,
          border: '2px solid rgba(139, 90, 43, 0.15)',
          padding: 8,
        }}
      >
        {/* Fake UI */}
        <div className="space-y-2">
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(232,93,4,0.5)' }} />
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(34,139,34,0.4)' }} />
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(139,90,43,0.2)' }} />
          </div>
          <div className="space-y-1.5">
            <div className="h-1.5 rounded-full" style={{ background: 'rgba(232,93,4,0.25)', width: '60%' }} />
            <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', width: '100%' }} />
            <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', width: '80%' }} />
            <div className="h-6 rounded" style={{ background: 'rgba(232,93,4,0.1)', marginTop: 4 }} />
            <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', width: '90%' }} />
            <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', width: '70%' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Phone mockup. */
export function PhoneMockup({ offset }: { offset: ParallaxOffset }) {
  return (
    <div
      style={{
        transform: `translate(${offset.x * 0.8}px, ${offset.y * 0.8}px) rotate(-4deg)`,
        transition: 'transform 0.15s ease-out',
      }}
    >
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          width: 80,
          height: 150,
          background: CHARCOAL,
          border: '2px solid rgba(139, 90, 43, 0.15)',
          padding: 6,
        }}
      >
        {/* Status bar */}
        <div className="flex justify-between items-center mb-2">
          <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.15)', width: 16 }} />
          <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.1)', width: 10 }} />
        </div>
        {/* Content */}
        <div className="space-y-1.5">
          <div className="h-1.5 rounded-full" style={{ background: 'rgba(232,93,4,0.3)', width: '50%' }} />
          <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', width: '100%' }} />
          <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', width: '70%' }} />
          <div className="h-5 rounded" style={{ background: 'rgba(232,93,4,0.1)', marginTop: 3 }} />
          <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', width: '85%' }} />
          <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', width: '60%' }} />
          <div className="h-5 rounded" style={{ background: 'rgba(34,139,34,0.08)', marginTop: 3 }} />
          <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', width: '100%' }} />
        </div>
        {/* Home bar */}
        <div className="mt-3 mx-auto h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.2)', width: 30 }} />
      </div>
    </div>
  )
}
