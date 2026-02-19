'use client'

import { useState, useRef, useCallback } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { STAGGER, REVEAL, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Color palette ────────────────────────────────────────────────────────────

const ORANGE      = '#E85D04'
const ORANGE_GLOW = 'rgba(232, 93, 4, 0.35)'
const ORANGE_DIM  = 'rgba(232, 93, 4, 0.15)'
const BLUE_SOON   = '#3B82F6'
const BLUE_GLOW   = 'rgba(59, 130, 246, 0.25)'

// ─── Layout — organic network positions ──────────────────────────────────────
//
// Percentages of container width/height — cards are absolutely positioned.
// Core sits near center. Others spiral loosely around it.
// The SVG beam layer uses the same percentage system to draw connections.

interface CardLayout {
  top:    string
  left:   string
  width:  number   // px — approximate; container is ~1000px ref width
  height: number   // px
}

const CARD_LAYOUT: Record<string, CardLayout> = {
  core:     { top: '33%',  left: '37%',  width: 172, height: 132 },
  console:  { top: '5%',   left: '7%',   width: 152, height: 118 },
  mesh:     { top: '7%',   left: '66%',  width: 152, height: 118 },
  wing:    { top: '63%',  left: '5%',   width: 152, height: 118 },
  pulse:    { top: '65%',  left: '65%',  width: 152, height: 118 },
  channels: { top: '69%',  left: '34%',  width: 152, height: 118 },
}

// ─── Connection beam definitions ──────────────────────────────────────────────

interface BeamDef {
  from:     string
  to:       string
  /** Travel speed in seconds for the animated gradient sweep. */
  dur:      number
}

const BEAMS: BeamDef[] = [
  { from: 'core',    to: 'console',  dur: 2.2 },
  { from: 'core',    to: 'mesh',     dur: 2.5 },
  { from: 'core',    to: 'wing',    dur: 2.8 },
  { from: 'core',    to: 'pulse',    dur: 2.4 },
  { from: 'core',    to: 'channels', dur: 2.0 },
  { from: 'mesh',    to: 'pulse',    dur: 3.1 },
  { from: 'console', to: 'wing',    dur: 3.4 },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return the approximate center of a card in percentage units of the
 * 1000×680 reference container.
 *
 * @param layout - Card layout descriptor
 */
function cardCenter(layout: CardLayout): { cx: string; cy: string } {
  const REF_W = 1000
  const REF_H = 680

  const topPct  = parseFloat(layout.top)
  const leftPct = parseFloat(layout.left)
  const cx = leftPct + (layout.width  / 2 / REF_W) * 100
  const cy = topPct  + (layout.height / 2 / REF_H) * 100

  return {
    cx: `${cx.toFixed(2)}%`,
    cy: `${cy.toFixed(2)}%`,
  }
}

// Pre-compute all card centres once at module load
const CENTERS: Record<string, { cx: string; cy: string }> = Object.fromEntries(
  Object.entries(CARD_LAYOUT).map(([id, layout]) => [id, cardCenter(layout)])
)

// ─── CSS Keyframes ────────────────────────────────────────────────────────────
//
// The moving-border uses a rotating div with a `conic-gradient` rather than
// `@property` + animated custom property, which maximises browser compat.
// The rotating div is masked by an inner cutout so only the border ring shows.

const KEYFRAMES = `
  @keyframes v12-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes v12-live-dot {
    0%, 100% { opacity: 1;    transform: scale(1);    }
    50%      { opacity: 0.3;  transform: scale(0.7);  }
  }
  @keyframes v12-core-pulse {
    0%   { box-shadow: 0 0 0 0   rgba(232, 93, 4, 0.45); }
    70%  { box-shadow: 0 0 0 18px rgba(232, 93, 4, 0);    }
    100% { box-shadow: 0 0 0 0   rgba(232, 93, 4, 0);    }
  }
  .v12-spin     { animation: v12-spin     3.2s linear      infinite; }
  .v12-spin-slow{ animation: v12-spin     5.0s linear      infinite; }
  .v12-live-dot { animation: v12-live-dot 2.0s ease-in-out infinite; }
  .v12-core-pulse { animation: v12-core-pulse 2.8s ease-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .v12-spin, .v12-spin-slow, .v12-live-dot, .v12-core-pulse {
      animation: none !important;
    }
  }
`

// ─── Sub-components ───────────────────────────────────────────────────────────

interface MovingBorderProps {
  isCore:   boolean
  isActive: boolean
  isAvail:  boolean
}

/**
 * Animated moving-border effect.
 *
 * Wraps the card in a clipped container. A square div with `conic-gradient`
 * rotates inside it, producing the illusion of a light tracing the perimeter.
 * An inner div masks the card center so only the border ring is exposed.
 */
function MovingBorder({ isCore, isActive, isAvail }: MovingBorderProps) {
  const color  = isAvail ? ORANGE : BLUE_SOON
  const glow   = isAvail ? ORANGE_GLOW : BLUE_GLOW
  const radius = isCore ? '14px' : '12px'
  const spinCls = isCore ? 'v12-spin' : 'v12-spin-slow'

  // Active state: brighter sweep + secondary ghost arc
  const gradient = isActive
    ? `conic-gradient(from 0deg,
        transparent 0deg,
        ${color}55 15deg,
        ${color}   30deg,
        #ffffff     38deg,
        ${color}   48deg,
        transparent 90deg,
        ${glow}     200deg,
        transparent 280deg
      )`
    : `conic-gradient(from 0deg,
        transparent 0deg,
        ${color}66 18deg,
        #ffffffcc   28deg,
        ${color}66 38deg,
        transparent 80deg
      )`

  return (
    <div
      aria-hidden
      style={{
        position:     'absolute',
        inset:        '-1px',
        borderRadius: radius,
        overflow:     'hidden',
        zIndex:       0,
      }}
    >
      {/* Rotating conic gradient */}
      <div
        className={spinCls}
        style={{
          position:   'absolute',
          top:        '50%',
          left:       '50%',
          width:      '220%',
          height:     '220%',
          transform:  'translate(-50%, -50%)',
          background: gradient,
        }}
      />
      {/* Inner mask — covers the card body, revealing only the border zone */}
      <div
        style={{
          position:     'absolute',
          inset:        '2px',
          borderRadius: isCore ? '13px' : '11px',
          background:   '#0a0a0f',
          zIndex:       1,
        }}
      />
    </div>
  )
}

interface GlowCardProps {
  module:     SystemModule
  isHovered:  boolean
  isActive:   boolean
  onHover:    (id: string | null) => void
  onActivate: (id: string) => void
}

/** A single module card with moving border, content, and glow effects. */
function GlowCard({ module, isHovered, isActive, onHover, onActivate }: GlowCardProps) {
  const layout  = CARD_LAYOUT[module.id]
  const isAvail = module.status === 'available'
  const isCore  = module.id === 'core'

  if (!layout) return null

  const color      = isAvail ? ORANGE : BLUE_SOON
  const glowColor  = isAvail ? ORANGE_GLOW : BLUE_GLOW
  const glowBright = isAvail ? 'rgba(232, 93, 4, 0.6)' : 'rgba(59, 130, 246, 0.5)'

  const boxShadow = isActive
    ? `0 0 0 1px ${color}, 0 0 24px ${glowBright}, 0 0 48px ${glowColor}, inset 0 0 24px rgba(0,0,0,0.7)`
    : isHovered
    ? `0 0 0 1px ${color}88, 0 0 16px ${glowColor}, inset 0 0 16px rgba(0,0,0,0.6)`
    : `0 0 0 1px rgba(255,255,255,0.055), inset 0 0 16px rgba(0,0,0,0.4)`

  const cardBg = isActive
    ? 'linear-gradient(135deg, rgba(28,14,4,0.96) 0%, rgba(14,8,4,0.98) 100%)'
    : 'linear-gradient(135deg, rgba(16,16,22,0.96) 0%, rgba(10,10,16,0.98) 100%)'

  return (
    <motion.div
      variants={REVEAL}
      style={{
        position: 'absolute',
        top:      layout.top,
        left:     layout.left,
        width:    layout.width,
        height:   layout.height,
        cursor:   'pointer',
        zIndex:   4,
      }}
      whileHover={{ scale: 1.025 }}
      whileTap={{  scale: 0.975 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      onMouseEnter={() => onHover(module.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onActivate(module.id)}
    >
      {/* Animated moving border */}
      <MovingBorder isCore={isCore} isActive={isActive} isAvail={isAvail} />

      {/* Card surface */}
      <div
        className={isCore && isActive ? 'v12-core-pulse' : undefined}
        style={{
          position:      'relative',
          width:         '100%',
          height:        '100%',
          borderRadius:  isCore ? '13px' : '11px',
          background:    cardBg,
          boxShadow,
          zIndex:        2,
          padding:       isCore ? '16px 18px' : '14px 16px',
          display:       'flex',
          flexDirection: 'column',
          justifyContent:'space-between',
          overflow:      'hidden',
          transition:    'box-shadow 0.35s ease, background 0.35s ease',
        }}
      >
        {/* Subtle inner dot-grid texture */}
        <div
          aria-hidden
          style={{
            position:         'absolute',
            inset:            0,
            backgroundImage:  'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize:   '14px 14px',
            borderRadius:     'inherit',
            pointerEvents:    'none',
            opacity:          isHovered || isActive ? 1 : 0.5,
            transition:       'opacity 0.3s ease',
          }}
        />

        {/* Inner scanline — very subtle CRT texture */}
        <div
          aria-hidden
          style={{
            position:       'absolute',
            inset:          0,
            background:     'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px)',
            borderRadius:   'inherit',
            pointerEvents:  'none',
          }}
        />

        {/* Top row: module name + status dot */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', zIndex: 1 }}>
          <span
            style={{
              fontFamily:    'var(--font-ibm-plex-mono, ui-monospace, monospace)',
              fontSize:      isCore ? '13px' : '11px',
              fontWeight:    700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color:         isActive ? '#ffffff' : isHovered ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.78)',
              transition:    'color 0.3s ease',
            }}
          >
            {module.name}
          </span>

          <span
            className={isAvail ? 'v12-live-dot' : undefined}
            style={{
              display:      'inline-block',
              width:        isAvail ? 7 : 6,
              height:       isAvail ? 7 : 6,
              borderRadius: '50%',
              background:   color,
              boxShadow:    isAvail
                ? `0 0 6px ${ORANGE_GLOW}, 0 0 14px ${ORANGE_DIM}`
                : `0 0 6px ${BLUE_GLOW}`,
              opacity:      isAvail ? 1 : 0.5,
              flexShrink:   0,
            }}
          />
        </div>

        {/* Module label + description */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          <span
            style={{
              display:       'block',
              fontFamily:    'var(--font-ibm-plex-mono, ui-monospace, monospace)',
              fontSize:      '8px',
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              color,
              opacity:       isAvail ? 0.9 : 0.45,
              marginBottom:  '5px',
            }}
          >
            {module.label}
          </span>

          <p
            style={{
              fontFamily:          'var(--font-ibm-plex-mono, ui-monospace, monospace)',
              fontSize:            '9px',
              lineHeight:          '1.6',
              color:               isHovered || isActive ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.33)',
              margin:              0,
              transition:          'color 0.3s ease',
              display:             '-webkit-box',
              WebkitLineClamp:     3,
              WebkitBoxOrient:     'vertical',
              overflow:            'hidden',
            }}
          >
            {module.description}
          </p>
        </div>

        {/* Footer row: status text + bracket decoration */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', zIndex: 1 }}>
          <span
            style={{
              fontFamily:    'var(--font-ibm-plex-mono, ui-monospace, monospace)',
              fontSize:      '7.5px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color:         isAvail ? ORANGE : BLUE_SOON,
              opacity:       isActive ? 0.95 : isAvail ? 0.55 : 0.4,
              transition:    'opacity 0.3s ease',
            }}
          >
            {isActive && isAvail ? '● Online' : isAvail ? 'Active' : 'Coming soon'}
          </span>

          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
            <path
              d="M1 7 L1 1 L7 1"
              stroke={color}
              strokeWidth="1.2"
              strokeOpacity={isActive ? 0.9 : 0.3}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transition: 'stroke-opacity 0.35s ease' }}
            />
          </svg>
        </div>
      </div>
    </motion.div>
  )
}

interface BeamLayerProps {
  hoveredId: string | null
  activeIds: Set<string>
}

/**
 * SVG overlay that draws connection beams between module cards.
 *
 * Each beam has two layers:
 *   1. A static dim track line
 *   2. A traveling gradient pulse animated via `gradientTransform`
 *
 * The `gradientUnits="userSpaceOnUse"` with percentage coords lets the
 * gradients align with the percentage-positioned cards.
 */
function BeamLayer({ hoveredId, activeIds }: BeamLayerProps) {
  return (
    <svg
      aria-hidden
      style={{
        position:      'absolute',
        inset:         0,
        width:         '100%',
        height:        '100%',
        overflow:      'visible',
        pointerEvents: 'none',
        zIndex:        2,
      }}
      // Use a viewBox so % values on gradient coords are consistent
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <defs>
        <filter id="v12-beam-glow" x="-30%" y="-200%" width="160%" height="500%">
          <feGaussianBlur stdDeviation="0.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {BEAMS.map((beam, i) => {
          const fromC = CENTERS[beam.from]
          const toC   = CENTERS[beam.to]
          if (!fromC || !toC) return null

          const isLit = hoveredId === beam.from || hoveredId === beam.to
            || activeIds.has(beam.from) || activeIds.has(beam.to)

          // Convert e.g. "52.30%" → "52.30" for viewBox-based SVG coords
          const x1 = parseFloat(fromC.cx)
          const y1 = parseFloat(fromC.cy)
          const x2 = parseFloat(toC.cx)
          const y2 = parseFloat(toC.cy)

          return (
            <linearGradient
              key={`v12-grad-${i}`}
              id={`v12-grad-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={x1} y1={y1}
              x2={x2} y2={y2}
            >
              <stop offset="0%"   stopColor={ORANGE} stopOpacity="0" />
              <stop offset="35%"  stopColor={ORANGE} stopOpacity={isLit ? '0.9' : '0.4'} />
              <stop offset="50%"  stopColor="#ffffff" stopOpacity={isLit ? '1.0' : '0.5'} />
              <stop offset="65%"  stopColor={ORANGE} stopOpacity={isLit ? '0.9' : '0.4'} />
              <stop offset="100%" stopColor={ORANGE} stopOpacity="0" />
              <animateTransform
                attributeName="gradientTransform"
                type="translate"
                from={`${-(x2 - x1) * 1.4} 0`}
                to={`${(x2 - x1) * 1.4} 0`}
                dur={`${beam.dur}s`}
                repeatCount="indefinite"
                additive="sum"
              />
            </linearGradient>
          )
        })}
      </defs>

      {BEAMS.map((beam, i) => {
        const fromC = CENTERS[beam.from]
        const toC   = CENTERS[beam.to]
        if (!fromC || !toC) return null

        const isLit = hoveredId === beam.from || hoveredId === beam.to
          || activeIds.has(beam.from) || activeIds.has(beam.to)

        const x1 = parseFloat(fromC.cx)
        const y1 = parseFloat(fromC.cy)
        const x2 = parseFloat(toC.cx)
        const y2 = parseFloat(toC.cy)

        return (
          <g key={`v12-beam-${i}`}>
            {/* Static dim track */}
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isLit ? ORANGE_GLOW : 'rgba(255,255,255,0.05)'}
              strokeWidth={isLit ? 0.18 : 0.08}
              style={{ transition: 'stroke 0.35s ease, stroke-width 0.35s ease' }}
            />
            {/* Animated traveling pulse */}
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={`url(#v12-grad-${i})`}
              strokeWidth={isLit ? 0.28 : 0.12}
              strokeLinecap="round"
              filter={isLit ? 'url(#v12-beam-glow)' : undefined}
              opacity={isLit ? 1 : 0.6}
              style={{ transition: 'stroke-width 0.35s ease, opacity 0.35s ease' }}
            />
          </g>
        )
      })}
    </svg>
  )
}

interface SpotlightProps {
  x:       number
  y:       number
  visible: boolean
}

/** Radial gradient spotlight that follows the cursor across the container. */
function Spotlight({ x, y, visible }: SpotlightProps) {
  return (
    <div
      aria-hidden
      style={{
        position:      'absolute',
        inset:         0,
        pointerEvents: 'none',
        zIndex:        3,
        opacity:       visible ? 1 : 0,
        transition:    'opacity 0.5s ease',
        background:    `radial-gradient(
          480px circle at ${x}px ${y}px,
          rgba(232, 93, 4, 0.065) 0%,
          rgba(232, 93, 4, 0.022) 40%,
          transparent 68%
        )`,
        borderRadius:  'inherit',
      }}
    />
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * DiagramV12 — Glowing Border Network architecture visualization.
 *
 * Each DorkOS module is a card with an animated moving-border (rotating
 * conic-gradient). Cards connect via SVG beams with traveling gradient
 * pulses. Dark cyberpunk aesthetic: hover to illuminate, click to activate.
 */
export function DiagramV12({ modules }: { modules: SystemModule[] }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set(['core']))
  const [spotlight, setSpotlight] = useState({ x: 0, y: 0, visible: false })

  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setSpotlight({ x: e.clientX - rect.left, y: e.clientY - rect.top, visible: true })
  }, [])

  const handleMouseLeave = useCallback(() => {
    setSpotlight((prev) => ({ ...prev, visible: false }))
    setHoveredId(null)
  }, [])

  const handleHover = useCallback((id: string | null) => {
    setHoveredId(id)
  }, [])

  const handleActivate = useCallback((id: string) => {
    setActiveIds((prev) => {
      const next = new Set(prev)
      // Core is always active — cannot be toggled off
      if (id === 'core') return next
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  return (
    <>
      <style>{KEYFRAMES}</style>

      {/* Outermost wrapper — provides the dark background this diagram needs */}
      <div
        style={{
          position:     'relative',
          width:        '100%',
          borderRadius: '16px',
          overflow:     'hidden',
          background:   'linear-gradient(160deg, #09090f 0%, #0d0a0f 45%, #080810 100%)',
          minHeight:    '600px',
        }}
      >
        {/* Background pixel-grid texture */}
        <div
          aria-hidden
          style={{
            position:        'absolute',
            inset:           0,
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)
            `,
            backgroundSize: '52px 52px',
            pointerEvents:  'none',
          }}
        />

        {/* Ambient core glow blob */}
        <div
          aria-hidden
          style={{
            position:      'absolute',
            top:           '33%',
            left:          '37%',
            width:         '300px',
            height:        '240px',
            borderRadius:  '50%',
            background:    'radial-gradient(ellipse, rgba(232,93,4,0.07) 0%, transparent 70%)',
            transform:     'translate(-50%, -50%)',
            filter:        'blur(32px)',
            pointerEvents: 'none',
          }}
        />

        {/* Corner brackets — HUD aesthetic */}
        {[
          { style: { top: '12px',    left:  '12px',  transform: 'rotate(0deg)'   } },
          { style: { top: '12px',    right: '12px',  transform: 'rotate(90deg)'  } },
          { style: { bottom: '12px', left:  '12px',  transform: 'rotate(270deg)' } },
          { style: { bottom: '12px', right: '12px',  transform: 'rotate(180deg)' } },
        ].map(({ style }, i) => (
          <svg
            key={i}
            aria-hidden
            width="18" height="18"
            viewBox="0 0 18 18"
            fill="none"
            style={{ position: 'absolute', opacity: 0.28, zIndex: 6, ...style }}
          >
            <path
              d="M1 9 L1 1 L9 1"
              stroke={ORANGE}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ))}

        {/* Interactive region */}
        <div
          ref={containerRef}
          style={{ position: 'relative', width: '100%', minHeight: '600px' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* Cursor spotlight */}
          <Spotlight x={spotlight.x} y={spotlight.y} visible={spotlight.visible} />

          {/* SVG beam network — sits below the cards */}
          <BeamLayer hoveredId={hoveredId} activeIds={activeIds} />

          {/* Module cards — staggered Framer Motion entrance */}
          <motion.div
            variants={STAGGER}
            initial="hidden"
            whileInView="visible"
            viewport={VIEWPORT}
            style={{ position: 'absolute', inset: 0 }}
          >
            {modules.map((module) => (
              <GlowCard
                key={module.id}
                module={module}
                isHovered={hoveredId === module.id}
                isActive={activeIds.has(module.id)}
                onHover={handleHover}
                onActivate={handleActivate}
              />
            ))}
          </motion.div>

          {/* Watermark */}
          <div
            aria-hidden
            style={{
              position:      'absolute',
              bottom:        '14px',
              left:          '18px',
              zIndex:        10,
              fontFamily:    'var(--font-ibm-plex-mono, ui-monospace, monospace)',
              fontSize:      '7.5px',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color:         ORANGE,
              opacity:       0.35,
              pointerEvents: 'none',
            }}
          >
            DRK-OS · V12 · Glowing Network
          </div>

          {/* Legend */}
          <div
            aria-hidden
            style={{
              position:      'absolute',
              bottom:        '14px',
              right:         '18px',
              zIndex:        10,
              display:       'flex',
              alignItems:    'center',
              gap:           '16px',
              pointerEvents: 'none',
            }}
          >
            {[
              { color: ORANGE,    glow: ORANGE_GLOW, label: 'Available', opacity: 1    },
              { color: BLUE_SOON, glow: BLUE_GLOW,   label: 'Planned',   opacity: 0.55 },
            ].map(({ color, glow, label, opacity }) => (
              <span
                key={label}
                style={{
                  display:       'flex',
                  alignItems:    'center',
                  gap:           '5px',
                  fontFamily:    'var(--font-ibm-plex-mono, ui-monospace, monospace)',
                  fontSize:      '7.5px',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color:         'rgba(255,255,255,0.28)',
                }}
              >
                <span
                  style={{
                    display:      'inline-block',
                    width:        6, height: 6,
                    borderRadius: '50%',
                    background:   color,
                    boxShadow:    `0 0 5px ${glow}`,
                    opacity,
                  }}
                />
                {label}
              </span>
            ))}
          </div>

          {/* Interaction hint */}
          <p
            aria-hidden
            style={{
              position:      'absolute',
              top:           '14px',
              left:          '50%',
              transform:     'translateX(-50%)',
              zIndex:        10,
              fontFamily:    'var(--font-ibm-plex-mono, ui-monospace, monospace)',
              fontSize:      '7.5px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color:         'rgba(255,255,255,0.18)',
              whiteSpace:    'nowrap',
              pointerEvents: 'none',
              margin:        0,
            }}
          >
            Hover to illuminate · Click to activate
          </p>
        </div>
      </div>
    </>
  )
}
