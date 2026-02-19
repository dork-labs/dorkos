'use client'

import { useState, useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

/** Circumradius of each hexagon (center to vertex). */
const R = 82

/** sqrt(3) precomputed for pointy-top hex math. */
const SQRT3 = Math.sqrt(3)

/**
 * Center-to-center distance between adjacent hexagons.
 * For pointy-top: d = sqrt(3) * R (horizontal) and 1.5 * R (vertical components).
 * We place neighbors using polar angles at 60° intervals.
 */
const D = SQRT3 * R

/** SVG viewBox dimensions — wide enough for the honeycomb plus labels. */
const VB_W = 820
const VB_H = 560
const CX = VB_W / 2
const CY = VB_H / 2

// ---------------------------------------------------------------------------
// Hex vertex helpers
// ---------------------------------------------------------------------------

/**
 * Compute the 6 vertices of a pointy-top hexagon centered at (cx, cy).
 * Vertices are at 30°, 90°, 150°, 210°, 270°, 330° (offset 30° from flat-top).
 */
function hexVertices(cx: number, cy: number, r: number): [number, number][] {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 30)
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as [number, number]
  })
}

/** Convert hex vertices to SVG polygon points string. */
function toPoints(verts: [number, number][]): string {
  return verts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
}

/**
 * Return the midpoint of the shared edge between two adjacent hexagons.
 * For a pointy-top hex at (ax, ay) and neighbor at (bx, by), the shared edge
 * consists of two consecutive vertices. We find them by comparing vertex proximity.
 */
function sharedEdge(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
): [[number, number], [number, number]] {
  const av = hexVertices(ax, ay, r)
  const bv = hexVertices(bx, by, r)
  const shared: [number, number][] = []

  for (const [avx, avy] of av) {
    for (const [bvx, bvy] of bv) {
      const dist = Math.hypot(avx - bvx, avy - bvy)
      // Vertices are "shared" if they coincide within floating-point tolerance
      if (dist < 1.5) {
        shared.push([avx, avy])
        break
      }
    }
  }

  // Always returns exactly 2 vertices for adjacent hexes
  return [shared[0] ?? [ax, ay], shared[1] ?? [bx, by]]
}

// ---------------------------------------------------------------------------
// Layout data
// ---------------------------------------------------------------------------

/**
 * Ring positions as (dx, dy) offsets from center using 60°-interval polar angles.
 * Angle 0 = right; angles sweep counter-clockwise in standard math coords,
 * but SVG Y axis is flipped so clockwise visually.
 *
 * Positions:
 *   0 → top         (270° in SVG / 90° math)
 *   1 → top-right   (330° in SVG)
 *   2 → bottom-right (30° in SVG)
 *   3 → bottom      (90° in SVG)
 *   4 → bottom-left (150° in SVG)
 *   5 → top-left    (210° in SVG)
 */
const RING_ANGLES_DEG = [270, 330, 30, 90, 150, 210] as const

/** Module IDs assigned to each ring position (index 5 = empty/decorative). */
const RING_MODULE_IDS = ['console', 'wing', 'channels', 'mesh', 'pulse', null] as const

interface HexCell {
  id: string | null
  cx: number
  cy: number
  /** Whether this hex is the center Core cell. */
  isCenter: boolean
  /** Ring slot index (0-5), or -1 for center. */
  slot: number
}

function buildLayout(): HexCell[] {
  const cells: HexCell[] = [
    { id: 'core', cx: CX, cy: CY, isCenter: true, slot: -1 },
  ]

  for (let i = 0; i < 6; i++) {
    const angleDeg = RING_ANGLES_DEG[i]
    const angleRad = (Math.PI / 180) * angleDeg
    // Distance between hex centers = sqrt(3) * R for pointy-top neighbors
    const dx = D * Math.cos(angleRad)
    const dy = D * Math.sin(angleRad)
    cells.push({
      id: RING_MODULE_IDS[i],
      cx: CX + dx,
      cy: CY + dy,
      isCenter: false,
      slot: i,
    })
  }

  return cells
}

const HEX_CELLS = buildLayout()

/** All center-to-ring edge pairs (center connects to all 5 named modules). */
const CORE_EDGES = HEX_CELLS.slice(1)
  .filter((c) => c.id !== null)
  .map((c) => ({
    ax: CX,
    ay: CY,
    bx: c.cx,
    by: c.cy,
    id: c.id!,
  }))

// ---------------------------------------------------------------------------
// Motion variants
// ---------------------------------------------------------------------------

const HEX_VARIANT = {
  hidden: { opacity: 0, scale: 0.7 },
  visible: (delay: number) => ({
    opacity: 1,
    scale: 1,
    transition: {
      delay,
      type: 'spring' as const,
      stiffness: 90,
      damping: 18,
      mass: 1,
    },
  }),
}

const EDGE_GLOW_VARIANT = {
  hidden: { opacity: 0 },
  visible: (delay: number) => ({
    opacity: 1,
    transition: { delay, duration: 0.5, ease: 'easeOut' as const },
  }),
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface HexCellProps {
  cell: HexCell
  module: SystemModule | undefined
  animDelay: number
  isDecorativeEmpty: boolean
}

/** A single hexagonal cell with label content inside. */
function HexCellShape({ cell, module, animDelay, isDecorativeEmpty }: HexCellProps) {
  const verts = hexVertices(cell.cx, cell.cy, R)
  const pts = toPoints(verts)
  // Inner hex for a double-ring effect on the center
  const innerPts = cell.isCenter ? toPoints(hexVertices(cell.cx, cell.cy, R - 10)) : null

  const isAvailable = module?.status === 'available'
  const borderColor = isDecorativeEmpty
    ? 'var(--border-warm)'
    : isAvailable
      ? 'var(--color-brand-orange)'
      : 'var(--color-warm-gray)'

  const fillColor = cell.isCenter
    ? 'var(--color-brand-orange)'
    : isDecorativeEmpty
      ? 'transparent'
      : 'var(--color-cream-white)'

  return (
    <motion.g
      custom={animDelay}
      variants={HEX_VARIANT}
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      style={{ originX: `${cell.cx}px`, originY: `${cell.cy}px` }}
      whileHover={
        isDecorativeEmpty
          ? undefined
          : {
              scale: 1.04,
              transition: { type: 'spring', stiffness: 300, damping: 22 },
            }
      }
    >
      {/* Outer hex fill */}
      <polygon
        points={pts}
        fill={fillColor}
        stroke={borderColor}
        strokeWidth={cell.isCenter ? 0 : isAvailable ? 2 : 1.5}
        strokeOpacity={isDecorativeEmpty ? 0.25 : 1}
        fillOpacity={isDecorativeEmpty ? 0 : 1}
      />

      {/* Inner double-ring on Core */}
      {innerPts && (
        <polygon
          points={innerPts}
          fill="none"
          stroke="rgba(255,255,255,0.3)"
          strokeWidth="1"
        />
      )}

      {/* Hover glow for non-core, non-empty cells */}
      {!cell.isCenter && !isDecorativeEmpty && (
        <polygon
          points={pts}
          fill="var(--color-brand-orange)"
          fillOpacity="0"
          stroke="none"
          className="transition-all duration-300 group-hover:fill-opacity-5"
        />
      )}

      {/* Content */}
      {cell.isCenter && module && (
        <>
          <text
            x={cell.cx}
            y={cell.cy - 10}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--color-cream-white)"
            fontSize="18"
            fontWeight="700"
            fontFamily="inherit"
            letterSpacing="-0.5"
          >
            {module.name}
          </text>
          <text
            x={cell.cx}
            y={cell.cy + 14}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="rgba(255,255,255,0.65)"
            fontSize="10.5"
            fontWeight="500"
            fontFamily="inherit"
            letterSpacing="1.2"
            style={{ textTransform: 'uppercase' }}
          >
            {module.label}
          </text>
        </>
      )}

      {!cell.isCenter && !isDecorativeEmpty && module && (
        <>
          <text
            x={cell.cx}
            y={cell.cy - 10}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--color-charcoal)"
            fontSize="15"
            fontWeight="600"
            fontFamily="inherit"
            letterSpacing="-0.3"
          >
            {module.name}
          </text>
          <text
            x={cell.cx}
            y={cell.cy + 12}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--color-warm-gray)"
            fontSize="9.5"
            fontWeight="500"
            fontFamily="inherit"
            letterSpacing="1"
            style={{ textTransform: 'uppercase' }}
          >
            {module.label}
          </text>
          {/* Status dot */}
          <circle
            cx={cell.cx}
            cy={cell.cy + 30}
            r="3"
            fill={isAvailable ? 'var(--color-brand-orange)' : 'var(--color-warm-gray)'}
            fillOpacity={isAvailable ? 0.9 : 0.45}
          />
        </>
      )}

      {/* Decorative empty hex — honeycomb dot pattern */}
      {isDecorativeEmpty && (
        <>
          {[-16, 0, 16].map((dx) =>
            [-8, 8].map((dy) => (
              <circle
                key={`${dx}-${dy}`}
                cx={cell.cx + dx}
                cy={cell.cy + dy}
                r="1.5"
                fill="var(--color-warm-gray)"
                fillOpacity="0.18"
              />
            )),
          )}
        </>
      )}
    </motion.g>
  )
}

interface SharedEdgeProps {
  ax: number
  ay: number
  bx: number
  by: number
  animDelay: number
  moduleId: string
}

/** Glowing shared edge between two adjacent hexagons, with a traveling energy dot. */
function SharedEdgeGlow({ ax, ay, bx, by, animDelay, moduleId }: SharedEdgeProps) {
  const [p1, p2] = sharedEdge(ax, ay, bx, by, R)

  // Path for the edge line (used by SMIL animateMotion)
  const edgePath = `M ${p1[0].toFixed(2)},${p1[1].toFixed(2)} L ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`

  // Gradient id (unique per module)
  const gradId = `edge-grad-${moduleId}`

  return (
    <motion.g
      custom={animDelay}
      variants={EDGE_GLOW_VARIANT}
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
    >
      {/* Glow gradient def — oriented along the edge */}
      <defs>
        <linearGradient
          id={gradId}
          x1={`${p1[0]}`}
          y1={`${p1[1]}`}
          x2={`${p2[0]}`}
          y2={`${p2[1]}`}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="var(--color-brand-orange)" stopOpacity="0.9" />
          <stop offset="50%" stopColor="var(--color-brand-orange)" stopOpacity="0.5" />
          <stop offset="100%" stopColor="var(--color-brand-orange)" stopOpacity="0.9" />
        </linearGradient>
      </defs>

      {/* Soft glow stroke (blurred via filter) */}
      <line
        x1={p1[0]}
        y1={p1[1]}
        x2={p2[0]}
        y2={p2[1]}
        stroke={`url(#${gradId})`}
        strokeWidth="4"
        strokeOpacity="0.25"
        filter="url(#edge-blur)"
      />

      {/* Crisp edge line */}
      <line
        x1={p1[0]}
        y1={p1[1]}
        x2={p2[0]}
        y2={p2[1]}
        stroke="var(--color-brand-orange)"
        strokeWidth="1.8"
        strokeOpacity="0.7"
      />

      {/* Traveling energy dot along the edge */}
      <circle r="2.5" fill="var(--color-brand-orange)" opacity="0.85">
        <animateMotion
          path={edgePath}
          dur={`${1.8 + (animDelay % 3) * 0.4}s`}
          repeatCount="indefinite"
          begin={`${animDelay + 0.8}s`}
        />
      </circle>

      {/* Reverse-direction dot for bidirectional feel */}
      <circle r="2" fill="var(--color-brand-orange)" opacity="0.5">
        <animateMotion
          path={edgePath}
          dur={`${2.2 + (animDelay % 3) * 0.3}s`}
          repeatCount="indefinite"
          begin={`${animDelay + 1.6}s`}
          keyPoints="1;0"
          keyTimes="0;1"
          calcMode="linear"
        />
      </circle>
    </motion.g>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * V4 — Hexagonal Grid architecture diagram.
 *
 * Core sits at the center hexagon. Five modules surround it in a honeycomb ring.
 * Shared edges between Core and each module glow and carry traveling energy dots.
 * Staggered entrance animation ripples outward from center.
 */
export function DiagramV4({ modules }: { modules: SystemModule[] }) {
  const [edgesVisible, setEdgesVisible] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)

  // Map module id → module data for quick lookup
  const moduleMap = new Map(modules.map((m) => [m.id, m]))

  // Reveal edges after the ring animation completes.
  // Last ring cell animates at delay 0.15 + 5 * 0.1 = 0.65s,
  // plus spring settle time (~0.5s) = ~1.2s total.
  // We use an IntersectionObserver to start the timer only when visible.
  useEffect(() => {
    if (!svgRef.current) return
    let timerId: ReturnType<typeof setTimeout>

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Wait for ring cells to finish their entrance animations
          timerId = setTimeout(() => setEdgesVisible(true), 1400)
          observer.disconnect()
        }
      },
      { threshold: 0.2 },
    )

    observer.observe(svgRef.current)
    return () => {
      observer.disconnect()
      clearTimeout(timerId)
    }
  }, [])

  return (
    <div className="w-full flex items-center justify-center">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full max-w-[900px] h-auto"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        aria-label="DorkOS hexagonal architecture diagram"
        role="img"
      >
        {/* ----------------------------------------------------------------- */}
        {/* Defs: filters + gradients                                          */}
        {/* ----------------------------------------------------------------- */}
        <defs>
          {/* Gaussian blur for edge glow softening */}
          <filter id="edge-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" />
          </filter>

          {/* Subtle radial glow behind center hex */}
          <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--color-brand-orange)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--color-brand-orange)" stopOpacity="0" />
          </radialGradient>

          {/*
           * Background hex pattern for decorative depth.
           * For a pointy-top tessellation the repeating tile is:
           *   width  = sqrt(3) * R  (= D)
           *   height = 2 * R
           * with alternating rows offset by D/2.
           * We approximate this with a single-row pattern that is close enough visually.
           */}
          <pattern
            id="hex-bg-pattern"
            x="0"
            y="0"
            width={D}
            height={R * 2}
            patternUnits="userSpaceOnUse"
          >
            <polygon
              points={toPoints(hexVertices(D / 2, R, R * 0.94))}
              fill="none"
              stroke="var(--color-warm-gray)"
              strokeWidth="0.5"
              strokeOpacity="0.07"
            />
          </pattern>
        </defs>

        {/* ----------------------------------------------------------------- */}
        {/* Background: faint hex tessellation for depth                       */}
        {/* ----------------------------------------------------------------- */}
        <rect width={VB_W} height={VB_H} fill="url(#hex-bg-pattern)" />

        {/* Radial glow behind center */}
        <ellipse
          cx={CX}
          cy={CY}
          rx={R * 2.2}
          ry={R * 2.2}
          fill="url(#core-glow)"
        />

        {/* ----------------------------------------------------------------- */}
        {/* Shared edges (rendered behind hexes so hexes sit on top)           */}
        {/* ----------------------------------------------------------------- */}
        {edgesVisible &&
          CORE_EDGES.map((edge, i) => (
            <SharedEdgeGlow
              key={edge.id}
              ax={edge.ax}
              ay={edge.ay}
              bx={edge.bx}
              by={edge.by}
              animDelay={0.6 + i * 0.12}
              moduleId={edge.id}
            />
          ))}

        {/* ----------------------------------------------------------------- */}
        {/* Hex cells — center first, then ring with staggered timing          */}
        {/* ----------------------------------------------------------------- */}

        {/* Center — Core */}
        <HexCellShape
          cell={HEX_CELLS[0]}
          module={moduleMap.get('core')}
          animDelay={0}
          isDecorativeEmpty={false}
        />

        {/* Ring cells with stagger — each 100ms apart after center */}
        {HEX_CELLS.slice(1).map((cell, i) => {
          const isEmpty = cell.id === null
          return (
            <HexCellShape
              key={cell.slot}
              cell={cell}
              module={cell.id ? moduleMap.get(cell.id) : undefined}
              animDelay={0.15 + i * 0.1}
              isDecorativeEmpty={isEmpty}
            />
          )
        })}

        {/* ----------------------------------------------------------------- */}
        {/* Legend — status indicator row                                       */}
        {/* ----------------------------------------------------------------- */}
        <g transform={`translate(${CX - 100}, ${VB_H - 38})`}>
          <circle cx="8" cy="8" r="4" fill="var(--color-brand-orange)" fillOpacity="0.85" />
          <text
            x="18"
            y="8"
            dominantBaseline="middle"
            fill="var(--color-warm-gray)"
            fontSize="10"
            fontFamily="inherit"
            letterSpacing="0.8"
          >
            AVAILABLE
          </text>
          <circle cx="110" cy="8" r="4" fill="var(--color-warm-gray)" fillOpacity="0.45" />
          <text
            x="120"
            y="8"
            dominantBaseline="middle"
            fill="var(--color-warm-gray)"
            fontSize="10"
            fontFamily="inherit"
            letterSpacing="0.8"
          >
            COMING SOON
          </text>
        </g>
      </svg>
    </div>
  )
}
