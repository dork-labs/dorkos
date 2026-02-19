'use client'

import { useState, useRef, useCallback } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Color palette ────────────────────────────────────────────────────────────

const ORANGE      = '#E85D04'
const ORANGE_GLOW = 'rgba(232, 93, 4, 0.15)'
const ORANGE_CONN  = 'rgba(232, 93, 4, 0.30)'
const CARD_BG      = 'rgba(255, 255, 255, 0.03)'
const CARD_BORDER  = 'rgba(255, 255, 255, 0.08)'
const CARD_BORDER_HOVER = 'rgba(232, 93, 4, 0.35)'

// ─── Grid layout: 3x2, module order matching the brief ────────────────────────

/** Display order: row-major, 3 columns. */
const GRID_ORDER = ['console', 'core', 'wing', 'pulse', 'mesh', 'channels']

/** Card grid positions (col 0-2, row 0-1) for connection line math. */
const CARD_COLS = 3

/** Card dimensions + gap in px (virtual units for SVG overlay math). */
const CARD_W    = 220   // px
const CARD_H    = 140   // px
const CARD_GAP  = 20    // gap between cards
const GRID_PAD  = 32    // container padding

// ─── Connection definitions ───────────────────────────────────────────────────

/** Pairs that share a visible connection arc on hover. */
const CONNECTIONS: Array<[string, string]> = [
  ['console', 'core'],
  ['core',    'wing'],
  ['core',    'pulse'],
  ['core',    'mesh'],
  ['mesh',    'channels'],
  ['mesh',    'pulse'],
]

// ─── Background beams configuration ──────────────────────────────────────────

interface BeamDef {
  /** SVG path — crosses the full container diagonally. */
  d: string
  /** How long one travel cycle takes (seconds). */
  dur: number
  /** CSS animation delay (seconds). */
  delay: number
  /** stroke-width of the beam line. */
  width: number
  /** Base opacity of the beam. */
  opacity: number
}

/**
 * Hand-tuned beam paths across an 800×480 viewBox.
 * Each path is a line or gentle curve crossing corner-to-corner,
 * deliberately varied in angle so they don't feel like a grid.
 */
const BEAMS: BeamDef[] = [
  { d: 'M -80 380 L 880 80',   dur: 4.2, delay: 0.0, width: 1.0, opacity: 0.7 },
  { d: 'M -80 460 L 880 -20',  dur: 5.8, delay: 1.1, width: 0.7, opacity: 0.5 },
  { d: 'M 120 520 L 800 -40',  dur: 3.6, delay: 0.5, width: 1.2, opacity: 0.6 },
  { d: 'M -40 200 L 840 320',  dur: 6.4, delay: 2.0, width: 0.6, opacity: 0.4 },
  { d: 'M 300 520 L 880 100',  dur: 4.8, delay: 0.8, width: 0.9, opacity: 0.55 },
  { d: 'M -80 100 L 700 480',  dur: 7.0, delay: 3.2, width: 0.6, opacity: 0.35 },
  { d: 'M 500 520 L 880 180',  dur: 5.2, delay: 1.7, width: 0.8, opacity: 0.45 },
  { d: 'M -20 -20 L 820 440',  dur: 6.0, delay: 2.8, width: 0.7, opacity: 0.40 },
]

// ─── Helper: card center in SVG coordinates ───────────────────────────────────

/**
 * Compute the center point of a card in the SVG overlay's coordinate space.
 *
 * @param index - Zero-based index into GRID_ORDER
 */
function cardCenter(index: number): { x: number; y: number } {
  const col = index % CARD_COLS
  const row = Math.floor(index / CARD_COLS)
  const x = GRID_PAD + col * (CARD_W + CARD_GAP) + CARD_W / 2
  const y = GRID_PAD + row * (CARD_H + CARD_GAP) + CARD_H / 2
  return { x, y }
}

// Pre-compute SVG overlay dimensions
const SVG_W = GRID_PAD * 2 + CARD_COLS * CARD_W + (CARD_COLS - 1) * CARD_GAP
const SVG_H = GRID_PAD * 2 + 2 * CARD_H + CARD_GAP

// ─── Sub-component: AnimatedBeam ──────────────────────────────────────────────

interface BeamProps {
  beam: BeamDef
  /** Unique SVG gradient id for this beam. */
  gradId: string
}

/**
 * A single background beam — a diagonal path with a traveling gradient shimmer.
 * The shimmer travels along the path using a CSS animation on stroke-dashoffset.
 */
function AnimatedBeam({ beam, gradId }: BeamProps) {
  // We animate a gradient highlight traveling along the path.
  // The gradient is linear along the path direction; a stroke-dashoffset
  // animation makes the highlight appear to slide from one end to the other.
  const animId = `beam-anim-${gradId}`

  return (
    <>
      <defs>
        {/* The beam body gradient: transparent → orange → transparent */}
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse"
          x1="0" y1="0" x2="800" y2="0"
        >
          <stop offset="0%"   stopColor={ORANGE} stopOpacity="0" />
          <stop offset="40%"  stopColor={ORANGE} stopOpacity={String(beam.opacity * 0.3)} />
          <stop offset="50%"  stopColor={ORANGE} stopOpacity={String(beam.opacity)} />
          <stop offset="60%"  stopColor={ORANGE} stopOpacity={String(beam.opacity * 0.3)} />
          <stop offset="100%" stopColor={ORANGE} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Static faint beam baseline */}
      <path
        d={beam.d}
        fill="none"
        stroke={ORANGE}
        strokeWidth={beam.width}
        strokeOpacity={0.06}
        strokeLinecap="round"
      />

      {/* Traveling shimmer — dasharray creates a segment of ~200px that slides along */}
      <path
        d={beam.d}
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={beam.width * 2}
        strokeLinecap="round"
        strokeDasharray="160 1400"
        strokeDashoffset="0"
        className={`v14-beam v14-beam-${animId}`}
        style={{
          animationDuration: `${beam.dur}s`,
          animationDelay: `${beam.delay}s`,
        }}
      />
    </>
  )
}

// ─── Sub-component: ConnectionLines SVG overlay ───────────────────────────────

interface ConnectionLinesProps {
  /** ID of the currently hovered module, or null. */
  hoveredId: string | null
}

/**
 * SVG overlay that renders faint arc connections between related modules.
 * Lines are invisible by default; they fade in when a card is hovered.
 */
function ConnectionLines({ hoveredId }: ConnectionLinesProps) {
  // Build index mapping module id → grid index
  const indexMap: Record<string, number> = {}
  GRID_ORDER.forEach((id, i) => { indexMap[id] = i })

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="absolute inset-0 w-full h-full"
      style={{ pointerEvents: 'none' }}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <filter id="conn-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {CONNECTIONS.map(([fromId, toId]) => {
        const fromIdx = indexMap[fromId]
        const toIdx   = indexMap[toId]
        if (fromIdx === undefined || toIdx === undefined) return null

        const a = cardCenter(fromIdx)
        const b = cardCenter(toIdx)

        // Quadratic bezier — curve outward slightly for visual clarity
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        // Perpendicular offset — lift the arc toward top of container
        const curve = Math.min(len * 0.18, 40)
        const cx = mx - (dy / len) * curve
        const cy = my + (dx / len) * curve

        const d = `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`
        const isActive = hoveredId === fromId || hoveredId === toId

        return (
          <motion.path
            key={`${fromId}-${toId}`}
            d={d}
            fill="none"
            stroke={ORANGE_CONN}
            strokeWidth="1"
            strokeLinecap="round"
            strokeDasharray="4 6"
            filter={isActive ? 'url(#conn-glow)' : undefined}
            animate={{ opacity: isActive ? 1 : 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          />
        )
      })}
    </svg>
  )
}

// ─── Sub-component: SpotlightCard ─────────────────────────────────────────────

interface SpotlightCardProps {
  module: SystemModule
  index: number
  isHovered: boolean
  onHoverStart: () => void
  onHoverEnd: () => void
}

/**
 * A single module card with a cursor-following radial gradient spotlight.
 * The spotlight gradient follows `onMouseMove` via CSS custom properties.
 * The card lifts on hover with a spring animation.
 */
function SpotlightCard({ module, index, isHovered, onHoverStart, onHoverEnd }: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const rafRef  = useRef<number | null>(null)
  const isAvailable = module.status === 'available'

  /** Update the CSS custom properties that position the spotlight gradient. */
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return
    // Throttle to one rAF per frame
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (!cardRef.current) return
      const rect = cardRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      cardRef.current.style.setProperty('--spotlight-x', `${x}px`)
      cardRef.current.style.setProperty('--spotlight-y', `${y}px`)
    })
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    onHoverEnd()
  }, [onHoverEnd])

  const borderColor = isHovered ? CARD_BORDER_HOVER : CARD_BORDER

  return (
    <motion.div
      variants={REVEAL}
      custom={index}
      whileHover={{ y: -4, transition: { type: 'spring', stiffness: 260, damping: 20 } }}
      onHoverStart={onHoverStart}
      onHoverEnd={handleMouseLeave}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ willChange: 'transform' }}
    >
      <div
        ref={cardRef}
        className="relative overflow-hidden rounded-xl"
        style={{
          background: CARD_BG,
          border: `1px solid ${borderColor}`,
          backdropFilter: 'blur(8px)',
          transition: `border-color 0.25s ease`,
          padding: '24px',
          minHeight: '140px',
          cursor: 'default',
          // CSS custom properties for the spotlight — default to card center
          '--spotlight-x': '50%',
          '--spotlight-y': '50%',
        } as React.CSSProperties}
      >
        {/* Cursor-following spotlight gradient */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: isHovered
              ? `radial-gradient(300px circle at var(--spotlight-x) var(--spotlight-y), ${ORANGE_GLOW}, transparent 80%)`
              : 'none',
            transition: 'background 0.15s ease',
            borderRadius: 'inherit',
          }}
        />

        {/* Subtle dot-grid pattern — revealed by spotlight */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)`,
            backgroundSize: '20px 20px',
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 0.3s ease',
            borderRadius: 'inherit',
          }}
        />

        {/* Card content */}
        <div className="relative" style={{ zIndex: 1 }}>
          {/* Status dot + label row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            {/* Status indicator */}
            <div
              aria-label={module.status === 'available' ? 'Available' : 'Coming soon'}
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: isAvailable ? '#4ade80' : '#6b7280',
                flexShrink: 0,
                boxShadow: isAvailable ? '0 0 6px rgba(74, 222, 128, 0.6)' : 'none',
              }}
              className={isAvailable ? 'v14-status-dot' : undefined}
            />
            {/* Module label */}
            <span
              style={{
                fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
                fontSize: '9px',
                letterSpacing: '0.12em',
                color: isAvailable ? `rgba(232, 93, 4, 0.75)` : 'rgba(255,255,255,0.25)',
                textTransform: 'uppercase',
              }}
            >
              {module.label}
            </span>
          </div>

          {/* Module name */}
          <h3
            style={{
              fontSize: '18px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: isAvailable ? '#FFFEFB' : 'rgba(255, 254, 251, 0.45)',
              marginBottom: '8px',
              lineHeight: 1.2,
            }}
          >
            {module.name}
          </h3>

          {/* Description — fades in on hover */}
          <p
            style={{
              fontSize: '11.5px',
              lineHeight: 1.55,
              color: 'rgba(255, 254, 251, 0.50)',
              opacity: isHovered ? 1 : 0,
              transform: isHovered ? 'translateY(0)' : 'translateY(4px)',
              transition: 'opacity 0.25s ease, transform 0.25s ease',
              margin: 0,
            }}
          >
            {module.description}
          </p>
        </div>

        {/* Coming-soon badge — bottom-right corner */}
        {!isAvailable && (
          <div
            style={{
              position: 'absolute',
              bottom: '12px',
              right: '14px',
              fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
              fontSize: '8px',
              letterSpacing: '0.12em',
              color: 'rgba(232, 93, 4, 0.40)',
              textTransform: 'uppercase',
            }}
          >
            SOON
          </div>
        )}

        {/* Corner accent — top-right for available modules */}
        {isAvailable && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: '32px',
              height: '32px',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: '8px',
                right: '8px',
                width: '4px',
                height: '4px',
                borderRadius: '50%',
                background: ORANGE,
                opacity: 0.55,
              }}
            />
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * DiagramV14 — Spotlight Beams architecture diagram.
 *
 * A cinematic, dark-themed 3x2 grid of module cards overlaid on animated
 * diagonal background beams. Each card has an independent cursor-following
 * radial gradient spotlight. Connection arcs between related modules fade in
 * when a card is hovered, revealing the system topology.
 *
 * Inspired by Aceternity UI's Spotlight, Card Spotlight, and Background Beams.
 */
export function DiagramV14({ modules }: { modules: SystemModule[] }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Build a lookup from module id to SystemModule
  const moduleMap: Record<string, SystemModule> = {}
  modules.forEach((m) => { moduleMap[m.id] = m })

  return (
    <>
      {/* ── Inline keyframes for beams and status dot ─────────────────────── */}
      <style>{`
        @keyframes v14-beam-travel {
          0%   { stroke-dashoffset:  1560; }
          100% { stroke-dashoffset: -160; }
        }
        @keyframes v14-dot-pulse {
          0%, 100% { opacity: 0.8; box-shadow: 0 0 6px rgba(74, 222, 128, 0.6); }
          50%       { opacity: 0.4; box-shadow: 0 0 2px rgba(74, 222, 128, 0.2); }
        }
        .v14-beam {
          animation-name: v14-beam-travel;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          animation-fill-mode: both;
        }
        .v14-status-dot {
          animation: v14-dot-pulse 2.6s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .v14-beam         { animation: none !important; }
          .v14-status-dot   { animation: none !important; }
        }
      `}</style>

      {/* ── Outer container ──────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={VIEWPORT}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="relative w-full rounded-xl overflow-hidden"
        style={{ background: '#0a0a0f', minHeight: '480px' }}
      >
        {/* ── Layer 0: Background beams (SVG) ─────────────────────────────── */}
        <svg
          viewBox="0 0 800 480"
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          {BEAMS.map((beam, i) => (
            <AnimatedBeam
              key={i}
              beam={beam}
              gradId={`v14-beam-grad-${i}`}
            />
          ))}

          {/* Radial vignette overlay — darkens edges, focuses the center */}
          <defs>
            <radialGradient id="v14-vignette" cx="50%" cy="50%" r="70%">
              <stop offset="0%"   stopColor="#0a0a0f" stopOpacity="0"   />
              <stop offset="100%" stopColor="#0a0a0f" stopOpacity="0.7" />
            </radialGradient>
          </defs>
          <rect width="800" height="480" fill="url(#v14-vignette)" />
        </svg>

        {/* ── Layer 1: Connection lines SVG overlay ────────────────────────── */}
        <ConnectionLines hoveredId={hoveredId} />

        {/* ── Layer 2: Module card grid ────────────────────────────────────── */}
        <motion.div
          variants={STAGGER}
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          className="relative"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: `${CARD_GAP}px`,
            padding: `${GRID_PAD}px`,
            zIndex: 2,
          }}
        >
          {GRID_ORDER.map((id, index) => {
            const mod = moduleMap[id]
            if (!mod) return null
            return (
              <SpotlightCard
                key={id}
                module={mod}
                index={index}
                isHovered={hoveredId === id}
                onHoverStart={() => setHoveredId(id)}
                onHoverEnd={() => setHoveredId(null)}
              />
            )
          })}
        </motion.div>

        {/* ── Watermark ─────────────────────────────────────────────────────── */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: '12px',
            right: '16px',
            fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
            fontSize: '7.5px',
            letterSpacing: '0.1em',
            color: 'rgba(255, 255, 255, 0.12)',
            textTransform: 'uppercase',
            pointerEvents: 'none',
          }}
        >
          DRK-OS · V14 · SPOTLIGHT
        </div>
      </motion.div>
    </>
  )
}
