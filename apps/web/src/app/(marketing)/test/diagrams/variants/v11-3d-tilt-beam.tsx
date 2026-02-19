'use client'

import { useState, useRef, useCallback, useEffect, type MouseEvent, type RefObject } from 'react'
import { motion, AnimatePresence, useInView, type Variants } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Constants ────────────────────────────────────────────────────────────────

const ORANGE      = '#E85D04'
const ORANGE_GLOW = 'rgba(232, 93, 4, 0.35)'
const MAX_TILT    = 15 // degrees

/** Module ID → [row, col] in the 3×2 grid. */
const GRID_POS: Record<string, [number, number]> = {
  console:  [0, 0],
  core:     [0, 1],
  wing:    [0, 2],
  pulse:    [1, 0],
  mesh:     [1, 1],
  channels: [1, 2],
}

/** Directed edges for tracing beams. */
const CONNECTIONS: [string, string][] = [
  ['core', 'console'],
  ['core', 'wing'],
  ['core', 'pulse'],
  ['core', 'mesh'],
  ['core', 'channels'],
  ['mesh', 'channels'],
]

// ─── Tilt math ────────────────────────────────────────────────────────────────

interface TiltState {
  rotateX: number
  rotateY: number
  spotX: number
  spotY: number
}

const NEUTRAL_TILT: TiltState = { rotateX: 0, rotateY: 0, spotX: 50, spotY: 50 }

/**
 * Compute 3D tilt angles and spotlight position from a mouse event
 * relative to the card element.
 *
 * @param e - Mouse event over the card
 * @param el - The card DOM element
 */
function computeTilt(e: MouseEvent<HTMLDivElement>, el: HTMLElement): TiltState {
  const rect    = el.getBoundingClientRect()
  const centerX = rect.left + rect.width  / 2
  const centerY = rect.top  + rect.height / 2

  // Normalise to [-1, +1]
  const nx = (e.clientX - centerX) / (rect.width  / 2)
  const ny = (e.clientY - centerY) / (rect.height / 2)

  return {
    rotateX:  -ny * MAX_TILT, // tilt toward cursor
    rotateY:   nx * MAX_TILT,
    spotX:    ((e.clientX - rect.left) / rect.width)  * 100,
    spotY:    ((e.clientY - rect.top)  / rect.height) * 100,
  }
}

// ─── Beam geometry ────────────────────────────────────────────────────────────

interface Rect {
  cx: number
  cy: number
}

// ─── TiltCard sub-component ───────────────────────────────────────────────────

interface TiltCardProps {
  module:      SystemModule
  isHovered:   boolean
  isExpanded:  boolean
  isAnyHovered: boolean
  onHoverStart: () => void
  onHoverEnd:   () => void
  onToggle:     () => void
  cardRef:      RefObject<HTMLDivElement | null>
  entryVariant: Variants
}

/**
 * A single 3D tilt card representing one DorkOS module.
 *
 * Tracks mouse position for perspective tilt and a radial spotlight gradient.
 * Clicking the card toggles an expanded detail view.
 */
function TiltCard({
  module,
  isHovered,
  isExpanded,
  isAnyHovered,
  onHoverStart,
  onHoverEnd,
  onToggle,
  cardRef,
  entryVariant,
}: TiltCardProps) {
  const [tilt, setTilt] = useState<TiltState>(NEUTRAL_TILT)

  const available = module.status === 'available'
  const isCore    = module.id === 'core'

  const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setTilt(computeTilt(e, el))
  }, [])

  const handleMouseLeave = useCallback(() => {
    setTilt(NEUTRAL_TILT)
    onHoverEnd()
  }, [onHoverEnd])

  // Dim cards that aren't active when something else is hovered
  const dimmed = isAnyHovered && !isHovered

  return (
    <motion.div
      variants={entryVariant}
      style={{ perspective: '1000px' }}
      className="w-full"
    >
      {/* Glow halo behind card — brightens when hovered or connected */}
      <motion.div
        animate={{
          opacity: isHovered ? 1 : available ? 0.3 : 0.1,
          scale:   isHovered ? 1.06 : 1,
        }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{
          background: `radial-gradient(ellipse at center, ${ORANGE_GLOW} 0%, transparent 70%)`,
          zIndex: 0,
        }}
      />

      {/* Card body — 3D tilt wrapper */}
      <motion.div
        ref={cardRef}
        layout
        onClick={onToggle}
        onMouseMove={handleMouseMove}
        onMouseEnter={onHoverStart}
        onMouseLeave={handleMouseLeave}
        animate={{
          rotateX:  tilt.rotateX,
          rotateY:  tilt.rotateY,
          scale:    isHovered ? 1.04 : dimmed ? 0.97 : 1,
          opacity:  dimmed ? 0.55 : 1,
        }}
        transition={{
          rotateX: { type: 'spring', stiffness: 280, damping: 28 },
          rotateY: { type: 'spring', stiffness: 280, damping: 28 },
          scale:   { type: 'spring', stiffness: 300, damping: 25 },
          opacity: { duration: 0.2 },
        }}
        style={{
          transformStyle:  'preserve-3d',
          willChange:      'transform',
          cursor:          'pointer',
          position:        'relative',
          zIndex:          isHovered ? 10 : 1,
        }}
        className="relative rounded-2xl overflow-hidden select-none"
      >
        {/* Card surface */}
        <div
          className="relative overflow-hidden rounded-2xl"
          style={{
            background:   'var(--color-cream-white)',
            border:       `1px solid var(--border-warm)`,
            boxShadow:    isHovered
              ? `0 20px 60px rgba(232,93,4,0.18), 0 8px 24px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.9)`
              : `0 2px 12px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)`,
            transition: 'box-shadow 0.3s ease',
          }}
        >
          {/* Spotlight gradient — follows cursor */}
          <div
            className="pointer-events-none absolute inset-0 rounded-2xl"
            style={{
              background: isHovered
                ? `radial-gradient(280px circle at ${tilt.spotX}% ${tilt.spotY}%, rgba(232,93,4,0.12) 0%, transparent 70%)`
                : 'none',
              zIndex: 1,
              transition: 'background 0.05s',
            }}
          />

          {/* Orange top accent line — thicker for core */}
          <div
            className="absolute top-0 left-0 right-0"
            style={{
              height:  isCore ? '3px' : '2px',
              background: available
                ? `linear-gradient(90deg, transparent 0%, ${ORANGE} 30%, ${ORANGE} 70%, transparent 100%)`
                : `linear-gradient(90deg, transparent 0%, rgba(232,93,4,0.3) 30%, rgba(232,93,4,0.3) 70%, transparent 100%)`,
              opacity: isHovered ? 1 : 0.6,
              transition: 'opacity 0.3s ease',
              zIndex: 2,
            }}
          />

          {/* Card content */}
          <div className="relative p-5" style={{ zIndex: 3 }}>
            {/* Header row */}
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="font-mono text-xs tracking-[0.12em] uppercase"
                    style={{ color: ORANGE, opacity: available ? 1 : 0.45 }}
                  >
                    {module.label}
                  </span>
                </div>
                <h3
                  className="font-semibold tracking-tight leading-none"
                  style={{
                    color:    'var(--color-charcoal)',
                    fontSize: isCore ? '20px' : '17px',
                  }}
                >
                  {module.name}
                </h3>
              </div>

              {/* Status badge */}
              <div
                className="shrink-0 font-mono text-[10px] tracking-[0.1em] uppercase px-2 py-1 rounded-full"
                style={{
                  background: available
                    ? 'rgba(34, 139, 34, 0.10)'
                    : 'rgba(74, 70, 64, 0.08)',
                  color: available ? 'var(--brand-green)' : 'var(--warm-gray-light)',
                  border: available
                    ? '1px solid rgba(34,139,34,0.2)'
                    : '1px solid rgba(74,70,64,0.12)',
                }}
              >
                {available ? 'Live' : 'Soon'}
              </div>
            </div>

            {/* Expand indicator */}
            <div
              className="flex items-center gap-1.5 mb-0"
              style={{ color: 'var(--warm-gray-light)', fontSize: '11px' }}
            >
              <motion.span
                animate={{ rotate: isExpanded ? 90 : 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="inline-block font-mono"
                style={{ color: ORANGE, opacity: 0.7 }}
              >
                ›
              </motion.span>
              <span className="font-mono tracking-wide text-[10px] uppercase opacity-60">
                {isExpanded ? 'collapse' : 'details'}
              </span>
            </div>

            {/* Expandable description */}
            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  key="expanded"
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 12 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                  style={{ overflow: 'hidden' }}
                >
                  <div
                    className="pt-3"
                    style={{
                      borderTop: '1px solid var(--border-warm)',
                    }}
                  >
                    <p
                      className="text-sm leading-relaxed"
                      style={{ color: 'var(--warm-gray)' }}
                    >
                      {module.description}
                    </p>

                    {/* ID chip */}
                    <div className="mt-3 flex items-center gap-2">
                      <span
                        className="font-mono text-[10px] tracking-[0.15em] uppercase px-2 py-0.5 rounded"
                        style={{
                          background: 'rgba(232,93,4,0.07)',
                          color:      ORANGE,
                          border:     `1px solid rgba(232,93,4,0.15)`,
                        }}
                      >
                        {module.id}
                      </span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Tracing beam SVG overlay ─────────────────────────────────────────────────

interface BeamOverlayProps {
  containerRef: RefObject<HTMLDivElement | null>
  cardRefs:     Record<string, RefObject<HTMLDivElement | null>>
  activeId:     string | null
  isVisible:    boolean
}

/**
 * Absolute-positioned SVG layer that draws animated tracing beams between
 * module cards. Each beam is a curved cubic Bezier path that draws itself
 * on scroll entry, then pulses a traveling light gradient.
 *
 * Beams connected to the hovered card glow brighter.
 */
function BeamOverlay({ containerRef, cardRefs, activeId, isVisible }: BeamOverlayProps) {
  const [centers, setCenters] = useState<Record<string, Rect>>({})
  const [svgSize,  setSvgSize] = useState({ w: 0, h: 0 })

  // Measure card centers on mount and resize
  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const cRect = container.getBoundingClientRect()
    setSvgSize({ w: cRect.width, h: cRect.height })

    const next: Record<string, Rect> = {}
    for (const [id, ref] of Object.entries(cardRefs)) {
      const el = ref.current
      if (!el) continue
      const kRect = el.getBoundingClientRect()
      next[id] = {
        cx: kRect.left + kRect.width  / 2 - cRect.left,
        cy: kRect.top  + kRect.height / 2 - cRect.top,
      }
    }
    setCenters(next)
  }, [containerRef, cardRefs])

  useEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [measure, containerRef])

  if (svgSize.w === 0) return null

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={svgSize.w}
      height={svgSize.h}
      style={{ zIndex: 0, overflow: 'visible' }}
      aria-hidden="true"
    >
      <defs>
        {/* Soft glow filter for beams */}
        <filter id="v11-beam-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Gradient for traveling pulse dot */}
        {CONNECTIONS.map(([from, to], i) => (
          <linearGradient
            key={`grad-${i}`}
            id={`v11-beam-grad-${i}`}
            gradientUnits="userSpaceOnUse"
            x1={centers[from]?.cx ?? 0}
            y1={centers[from]?.cy ?? 0}
            x2={centers[to]?.cx ?? 0}
            y2={centers[to]?.cy ?? 0}
          >
            <stop offset="0%"   stopColor={ORANGE} stopOpacity="0" />
            <stop offset="50%"  stopColor={ORANGE} stopOpacity="1" />
            <stop offset="100%" stopColor={ORANGE} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>

      {CONNECTIONS.map(([from, to], i) => {
        const a = centers[from]
        const b = centers[to]
        if (!a || !b) return null

        const isActive = activeId === from || activeId === to

        // Cubic bezier control points — gently arc upward between cards
        const mx  = (a.cx + b.cx) / 2
        const my  = (a.cy + b.cy) / 2
        const dx  = b.cx - a.cx
        const dy  = b.cy - a.cy
        const len = Math.sqrt(dx * dx + dy * dy) || 1

        // Perpendicular offset — curve beams away from each other
        const perpX = (-dy / len) * 40 * (i % 2 === 0 ? 1 : -1)
        const perpY = ( dx / len) * 40 * (i % 2 === 0 ? 1 : -1)

        const cx1 = a.cx + (mx - a.cx) * 0.5 + perpX
        const cy1 = a.cy + (my - a.cy) * 0.5 + perpY
        const cx2 = b.cx + (mx - b.cx) * 0.5 + perpX
        const cy2 = b.cy + (my - b.cy) * 0.5 + perpY

        const d = `M ${a.cx} ${a.cy} C ${cx1} ${cy1} ${cx2} ${cy2} ${b.cx} ${b.cy}`

        const baseOpacity  = isActive ? 0.55 : 0.18
        const pulseOpacity = isActive ? 1.0  : 0.45

        return (
          <g key={`beam-${i}`}>
            {/* Static guide path */}
            <motion.path
              d={d}
              fill="none"
              stroke={ORANGE}
              strokeWidth={isActive ? 1.5 : 1}
              filter={isActive ? 'url(#v11-beam-glow)' : undefined}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={isVisible
                ? { pathLength: 1, opacity: baseOpacity }
                : { pathLength: 0, opacity: 0 }}
              transition={{
                pathLength: { duration: 1.4, delay: 0.3 + i * 0.15, ease: 'easeOut' },
                opacity:    { duration: 0.5, delay: 0.3 + i * 0.15 },
              }}
              strokeLinecap="round"
            />

            {/* Blurred duplicate for glow */}
            {isActive && (
              <motion.path
                d={d}
                fill="none"
                stroke={ORANGE}
                strokeWidth={3}
                strokeOpacity={0.25}
                filter="url(#v11-beam-glow)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                strokeLinecap="round"
              />
            )}

            {/* Traveling pulse — animated dot along the path */}
            {isVisible && (
              <motion.circle
                r={isActive ? 3 : 2}
                fill={ORANGE}
                opacity={pulseOpacity}
                filter={isActive ? 'url(#v11-beam-glow)' : undefined}
              >
                <animateMotion
                  path={d}
                  dur={`${2.4 + i * 0.3}s`}
                  begin={`${0.5 + i * 0.2}s`}
                  repeatCount="indefinite"
                  calcMode="spline"
                  keyPoints="0;1"
                  keyTimes="0;1"
                  keySplines="0.42 0 0.58 1"
                />
              </motion.circle>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * 3D Tilt Cards + Tracing Beams architecture diagram (V11).
 *
 * Modules are arranged in a 3×2 grid of cards with:
 * - Aceternity-style 3D perspective tilt on mouse hover
 * - Radial spotlight gradient following the cursor
 * - AnimatePresence-powered expand/collapse for module details
 * - Animated SVG tracing beams that draw on viewport entry
 * - Traveling light pulses along beam paths
 * - Beam glow intensifies when the connected card is hovered
 *
 * @param modules - The six DorkOS system modules to render
 */
export function DiagramV11({ modules }: { modules: SystemModule[] }) {
  const [hoveredId,  setHoveredId]  = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const isInView     = useInView(containerRef, VIEWPORT)

  // One ref per card for beam anchor measurement
  const cardRefs = useRef<Record<string, RefObject<HTMLDivElement | null>>>({})
  for (const m of modules) {
    if (!cardRefs.current[m.id]) {
      cardRefs.current[m.id] = { current: null }
    }
  }

  const handleToggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  // Sort modules into 3×2 grid order: [console, core, wing, pulse, mesh, channels]
  const sorted = [...modules].sort((a, b) => {
    const [ar, ac] = GRID_POS[a.id] ?? [99, 99]
    const [br, bc] = GRID_POS[b.id] ?? [99, 99]
    return ar !== br ? ar - br : ac - bc
  })

  return (
    <div className="relative w-full" style={{ minHeight: '360px' }}>
      {/* Outer stagger container */}
      <motion.div
        ref={containerRef}
        className="relative w-full"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* 3×2 card grid */}
        <div
          className="relative grid gap-4"
          style={{
            gridTemplateColumns: 'repeat(3, 1fr)',
            gridTemplateRows:    'auto auto',
            zIndex: 1,
          }}
        >
          {sorted.map((module, index) => {
            const staggeredReveal: Variants = {
              hidden:  { opacity: 0, y: 24 },
              visible: {
                opacity: 1,
                y: 0,
                transition: {
                  type:      'spring' as const,
                  stiffness: 120,
                  damping:   18,
                  delay:     index * 0.08,
                },
              },
            }

            return (
              <div key={module.id} className="relative">
                <TiltCard
                  module={module}
                  isHovered={hoveredId === module.id}
                  isExpanded={expandedId === module.id}
                  isAnyHovered={hoveredId !== null}
                  onHoverStart={() => setHoveredId(module.id)}
                  onHoverEnd={() => setHoveredId(null)}
                  onToggle={() => handleToggle(module.id)}
                  cardRef={cardRefs.current[module.id]}
                  entryVariant={staggeredReveal}
                />
              </div>
            )
          })}
        </div>

        {/* SVG beam overlay — absolute, sits behind cards */}
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 0 }}>
          <BeamOverlay
            containerRef={containerRef}
            cardRefs={cardRefs.current}
            activeId={hoveredId}
            isVisible={isInView}
          />
        </div>
      </motion.div>

      {/* Bottom legend row */}
      <motion.div
        variants={REVEAL}
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        className="flex items-center gap-6 mt-6 pl-1"
      >
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: 'var(--brand-green)', opacity: 0.85 }}
          />
          <span
            className="font-mono text-[10px] tracking-[0.12em] uppercase"
            style={{ color: 'var(--warm-gray-light)' }}
          >
            Available
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: 'var(--warm-gray-light)', opacity: 0.5 }}
          />
          <span
            className="font-mono text-[10px] tracking-[0.12em] uppercase"
            style={{ color: 'var(--warm-gray-light)' }}
          >
            Coming Soon
          </span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="20" height="4" style={{ overflow: 'visible' }}>
            <line
              x1="0" y1="2" x2="20" y2="2"
              stroke={ORANGE}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeOpacity="0.6"
            />
            <circle cx="10" cy="2" r="2" fill={ORANGE} opacity="0.9" />
          </svg>
          <span
            className="font-mono text-[10px] tracking-[0.12em] uppercase"
            style={{ color: 'var(--warm-gray-light)' }}
          >
            Data Flow
          </span>
        </div>
        <span
          className="font-mono text-[10px] tracking-[0.12em] uppercase ml-auto opacity-30"
          style={{ color: 'var(--warm-gray-light)' }}
        >
          DRK-OS · V11 · TILT CARDS
        </span>
      </motion.div>
    </div>
  )
}
