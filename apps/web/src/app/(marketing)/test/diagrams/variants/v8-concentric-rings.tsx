'use client'

import { useState, useId } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import {
  STAGGER,
  SCALE_IN,
  DRAW_PATH,
  VIEWPORT,
} from '@/layers/features/marketing/lib/motion-variants'

// ─── Geometry constants ────────────────────────────────────────────────────────

const CX = 300
const CY = 300
const RING_RADII = [100, 170, 240] as const
const TICK_COUNT = 36 // one tick every 10°
const CORE_R = 28
const DOT_R_AVAILABLE = 7
const DOT_R_COMING = 5
// Rotation period for the radar sweep (seconds)
const SWEEP_PERIOD = 5

// ─── Module layout ─────────────────────────────────────────────────────────────
// Angles in degrees, 0 = right (3 o'clock), increasing clockwise.
// We start from -90 (12 o'clock) for natural compass feel.

interface ModuleLayout {
  id: string
  ring: 0 | 1 | 2 // index into RING_RADII
  angleDeg: number
}

// Explicit placement for visual balance
const MODULE_LAYOUT: ModuleLayout[] = [
  // Core is always at center, not on any ring
  { id: 'console', ring: 0, angleDeg: -60 },
  { id: 'wing', ring: 1, angleDeg: 210 },
  { id: 'pulse', ring: 1, angleDeg: 30 },
  { id: 'mesh', ring: 2, angleDeg: -120 },
  { id: 'channels', ring: 2, angleDeg: 70 },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert polar coords (origin = CX,CY) to SVG x,y. */
function polar(r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) }
}

/** SVG path for a full circle using two arcs (compatible with pathLength). */
function circlePath(r: number): string {
  return [
    `M ${CX - r} ${CY}`,
    `A ${r} ${r} 0 1 1 ${CX + r} ${CY}`,
    `A ${r} ${r} 0 1 1 ${CX - r} ${CY}`,
    'Z',
  ].join(' ')
}

/**
 * Build an SVG path for a filled sector (pie slice) of angle degrees,
 * centered at CX,CY, from radius 0 to maxR, opening from startDeg to endDeg.
 */
function sectorPath(maxR: number, startDeg: number, sweepDeg: number): string {
  const endDeg = startDeg + sweepDeg
  const s = polar(maxR, startDeg)
  const e = polar(maxR, endDeg)
  const large = sweepDeg > 180 ? 1 : 0
  return [
    `M ${CX} ${CY}`,
    `L ${s.x} ${s.y}`,
    `A ${maxR} ${maxR} 0 ${large} 1 ${e.x} ${e.y}`,
    'Z',
  ].join(' ')
}

/** Determine text-anchor for a label based on position relative to center. */
function anchorFor(x: number): 'start' | 'middle' | 'end' {
  if (x < CX - 20) return 'end'
  if (x > CX + 20) return 'start'
  return 'middle'
}

/**
 * Push label outward from a node so it clears the dot.
 * Returns the label position and text-anchor.
 */
function labelPos(
  nx: number,
  ny: number,
  clearance: number,
): { lx: number; ly: number; anchor: 'start' | 'middle' | 'end' } {
  const dx = nx - CX
  const dy = ny - CY
  const dist = Math.sqrt(dx * dx + dy * dy) || 1
  return {
    lx: nx + (dx / dist) * clearance,
    ly: ny + (dy / dist) * clearance,
    anchor: anchorFor(nx),
  }
}

/**
 * How long (in seconds) the sweep takes to reach a given angle,
 * given the sweep starts at -90° (12 o'clock) and rotates clockwise.
 */
function revealDelay(angleDeg: number, entranceDelay: number): number {
  // Normalize to 0–360 range starting from -90° (top)
  let normalized = (angleDeg + 90) % 360
  if (normalized < 0) normalized += 360
  // Fraction of the sweep period
  return entranceDelay + (normalized / 360) * SWEEP_PERIOD
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface RingTicksProps {
  r: number
  count: number
  id: string
}

/** Tick marks along a ring at uniform angular intervals. */
function RingTicks({ r, count, id }: RingTicksProps) {
  const ticks = Array.from({ length: count }, (_, i) => {
    const deg = (i / count) * 360
    const inner = polar(r - 4, deg)
    const outer = polar(r + 4, deg)
    return { inner, outer, key: `${id}-tick-${i}` }
  })
  return (
    <g>
      {ticks.map(({ inner, outer, key }) => (
        <line
          key={key}
          x1={inner.x}
          y1={inner.y}
          x2={outer.x}
          y2={outer.y}
          stroke="#E85D04"
          strokeWidth="0.75"
          strokeOpacity="0.25"
        />
      ))}
    </g>
  )
}

interface ModuleNodeProps {
  mod: SystemModule
  layout: ModuleLayout
  revealDelaySec: number
}

/** A single module dot + label on the radar display. */
function ModuleNode({ mod, layout, revealDelaySec }: ModuleNodeProps) {
  const r = RING_RADII[layout.ring]
  const { x, y } = polar(r, layout.angleDeg)
  const available = mod.status === 'available'
  const dotR = available ? DOT_R_AVAILABLE : DOT_R_COMING
  const clearance = dotR + 22
  const { lx, ly, anchor } = labelPos(x, y, clearance)

  return (
    <motion.g
      initial={{ opacity: 0, scale: 0 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={VIEWPORT}
      transition={{ delay: revealDelaySec, duration: 0.4, ease: 'easeOut' }}
    >
      {/* Glow halo behind dot */}
      <circle
        cx={x}
        cy={y}
        r={dotR + 6}
        fill="#E85D04"
        opacity={available ? 0.15 : 0.06}
      />

      {/* Main dot */}
      <circle
        cx={x}
        cy={y}
        r={dotR}
        fill={available ? '#E85D04' : '#6B5E50'}
        opacity={available ? 0.9 : 0.55}
        stroke={available ? '#E85D04' : '#6B5E50'}
        strokeWidth="1"
        strokeOpacity={available ? 0.6 : 0.35}
      />

      {/* Center pip for available modules */}
      {available && (
        <circle cx={x} cy={y} r={2.5} fill="#FFFEFB" opacity={0.9} />
      )}

      {/* Module name label */}
      <text
        x={lx}
        y={ly - 6}
        textAnchor={anchor}
        dominantBaseline="middle"
        style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.04em',
          fill: available ? '#FFFEFB' : '#7A6B5A',
          fontFamily: 'monospace',
        }}
      >
        {mod.name}
      </text>

      {/* Module label (role descriptor) */}
      <text
        x={lx}
        y={ly + 8}
        textAnchor={anchor}
        dominantBaseline="middle"
        style={{
          fontSize: '9px',
          fontWeight: 400,
          letterSpacing: '0.12em',
          textTransform: 'uppercase' as const,
          fill: available ? '#C8A882' : '#5A4E3E',
          fontFamily: 'monospace',
        }}
      >
        {mod.label}
      </text>
    </motion.g>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

/**
 * Concentric rings / radar scope architecture diagram.
 * Dark sonar-screen aesthetic with a rotating sweep line and progressive
 * module reveal as the sweep first passes over each position.
 */
export function DiagramV8({ modules }: { modules: SystemModule[] }) {
  const uid = useId().replace(/:/g, '')
  const [entranceDone, setEntranceDone] = useState(false)

  const coreModule = modules.find((m) => m.id === 'core')

  // Build resolved node list: match layout entries to module data
  const nodes = MODULE_LAYOUT.flatMap((layout) => {
    const mod = modules.find((m) => m.id === layout.id)
    if (!mod) return []
    // Entrance animation for rings takes ~1.2s; add small stagger on top
    const entranceDelay = 1.4
    return [{ mod, layout, revealDelaySec: revealDelay(layout.angleDeg, entranceDelay) }]
  })

  // IDs for SVG defs (scoped with useId to avoid collisions if rendered twice)
  const sweepGradId = `sweep-grad-${uid}`
  const sweepMaskId = `sweep-mask-${uid}`
  const glowFilterId = `glow-${uid}`
  const coreGlowId = `core-glow-${uid}`
  const sweepGroupId = `sweep-group-${uid}`

  // The sweep sector spans 110° so the tail fades naturally
  const SWEEP_ANGLE = 110

  return (
    <div
      style={{
        background: '#1A1814',
        borderRadius: '12px',
        overflow: 'hidden',
        aspectRatio: '1 / 1',
        maxWidth: '600px',
        margin: '0 auto',
      }}
    >
      {/* Inject keyframes for the radar sweep rotation */}
      <style>{`
        @keyframes radar-sweep-${uid} {
          from { transform: rotate(-90deg); }
          to   { transform: rotate(270deg); }
        }
        #${sweepGroupId} {
          transform-origin: ${CX}px ${CY}px;
          animation: radar-sweep-${uid} ${SWEEP_PERIOD}s linear infinite;
          animation-play-state: ${entranceDone ? 'running' : 'paused'};
        }
      `}</style>

      <motion.svg
        viewBox="0 0 600 600"
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
        aria-label="DorkOS concentric rings radar architecture diagram"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
        onAnimationComplete={() => setEntranceDone(true)}
      >
        <defs>
          {/* Sweep sector gradient: opaque orange at leading edge (right), transparent at tail */}
          <linearGradient
            id={sweepGradId}
            x1="1"
            y1="0"
            x2="0"
            y2="0"
            gradientUnits="objectBoundingBox"
          >
            <stop offset="0%" stopColor="#E85D04" stopOpacity="0.55" />
            <stop offset="60%" stopColor="#E85D04" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#E85D04" stopOpacity="0" />
          </linearGradient>

          {/* Clip the sweep sector within the outermost ring radius */}
          <clipPath id={sweepMaskId}>
            <circle cx={CX} cy={CY} r={RING_RADII[2] + 2} />
          </clipPath>

          {/* Soft glow filter for the sweep leading-edge line */}
          <filter id={glowFilterId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Core radial glow */}
          <radialGradient id={coreGlowId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#E85D04" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#E85D04" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* ── Background: faint polar-graph grid ── */}
        {/* Crosshair lines */}
        <line
          x1={CX}
          y1={20}
          x2={CX}
          y2={580}
          stroke="#8B7355"
          strokeWidth="0.5"
          strokeOpacity="0.12"
        />
        <line
          x1={20}
          y1={CY}
          x2={580}
          y2={CY}
          stroke="#8B7355"
          strokeWidth="0.5"
          strokeOpacity="0.12"
        />
        {/* 45-degree diagonal guides */}
        <line
          x1={CX - 280}
          y1={CY - 280}
          x2={CX + 280}
          y2={CY + 280}
          stroke="#8B7355"
          strokeWidth="0.5"
          strokeOpacity="0.06"
        />
        <line
          x1={CX + 280}
          y1={CY - 280}
          x2={CX - 280}
          y2={CY + 280}
          stroke="#8B7355"
          strokeWidth="0.5"
          strokeOpacity="0.06"
        />

        {/* ── Concentric rings ── */}
        {RING_RADII.map((r, i) => (
          <motion.path
            key={`ring-${i}`}
            d={circlePath(r)}
            fill="none"
            stroke="#E85D04"
            strokeWidth={i === 0 ? 1.5 : 1}
            strokeOpacity={i === 0 ? 0.35 : 0.2}
            strokeDasharray={i === 2 ? '4 6' : i === 1 ? '2 4' : 'none'}
            variants={DRAW_PATH}
            custom={i}
          />
        ))}

        {/* ── Ring tick marks ── */}
        {RING_RADII.map((r, i) => (
          <RingTicks key={`ticks-${i}`} r={r} count={TICK_COUNT} id={`r${i}`} />
        ))}

        {/* ── Ring distance labels (compass-rose style, at 3 o'clock) ── */}
        {RING_RADII.map((r, i) => {
          const labels = ['INNER', 'MID', 'OUTER']
          const lx = CX + r + 6
          return (
            <text
              key={`rlabel-${i}`}
              x={lx}
              y={CY - 4}
              style={{
                fontSize: '7px',
                fontFamily: 'monospace',
                letterSpacing: '0.1em',
                fill: '#6B5E50',
              }}
            >
              {labels[i]}
            </text>
          )
        })}

        {/* ── Radar sweep sector (CSS-animated rotation) ── */}
        <g id={sweepGroupId} clipPath={`url(#${sweepMaskId})`}>
          {/* Sweep fill: wide fade sector */}
          <path
            d={sectorPath(RING_RADII[2] + 2, -SWEEP_ANGLE, SWEEP_ANGLE)}
            fill={`url(#${sweepGradId})`}
            opacity={0.85}
          />
          {/* Leading edge line: bright orange spoke */}
          <line
            x1={CX}
            y1={CY}
            x2={CX + RING_RADII[2] + 2}
            y2={CY}
            stroke="#E85D04"
            strokeWidth="1.5"
            strokeOpacity="0.9"
            filter={`url(#${glowFilterId})`}
          />
        </g>

        {/* ── Ambient glow at core ── */}
        <motion.circle
          cx={CX}
          cy={CY}
          r={70}
          fill={`url(#${coreGlowId})`}
          variants={SCALE_IN}
        />

        {/* ── Module nodes ── */}
        {nodes.map(({ mod, layout, revealDelaySec }) => (
          <ModuleNode
            key={mod.id}
            mod={mod}
            layout={layout}
            revealDelaySec={revealDelaySec}
          />
        ))}

        {/* ── Core node (always at center) ── */}
        <motion.g variants={SCALE_IN}>
          {/* Pulse ring — breathes after entrance */}
          <motion.circle
            cx={CX}
            cy={CY}
            r={CORE_R + 14}
            fill="none"
            stroke="#E85D04"
            strokeWidth="1"
            strokeOpacity={0}
            animate={
              entranceDone
                ? {
                    strokeOpacity: [0, 0.35, 0],
                    r: [CORE_R + 8, CORE_R + 28, CORE_R + 8],
                  }
                : {}
            }
            transition={{ duration: 2.8, repeat: Infinity, ease: 'easeOut' }}
          />

          {/* Core outer glow ring */}
          <circle
            cx={CX}
            cy={CY}
            r={CORE_R + 3}
            fill="none"
            stroke="#E85D04"
            strokeWidth="1.5"
            strokeOpacity="0.55"
            filter={`url(#${glowFilterId})`}
          />

          {/* Core body */}
          <circle
            cx={CX}
            cy={CY}
            r={CORE_R}
            fill="#2A2420"
            stroke="#E85D04"
            strokeWidth="2"
            strokeOpacity="0.75"
          />

          {/* Core crosshair lines (inner) */}
          <line
            x1={CX - CORE_R + 6}
            y1={CY}
            x2={CX + CORE_R - 6}
            y2={CY}
            stroke="#E85D04"
            strokeWidth="0.75"
            strokeOpacity="0.4"
          />
          <line
            x1={CX}
            y1={CY - CORE_R + 6}
            x2={CX}
            y2={CY + CORE_R - 6}
            stroke="#E85D04"
            strokeWidth="0.75"
            strokeOpacity="0.4"
          />

          {/* Core name */}
          <text
            x={CX}
            y={CY - 4}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.08em',
              fill: '#FFFEFB',
              fontFamily: 'monospace',
            }}
          >
            {coreModule?.name ?? 'CORE'}
          </text>

          {/* Core label */}
          <text
            x={CX}
            y={CY + 8}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{
              fontSize: '7px',
              fontWeight: 400,
              letterSpacing: '0.14em',
              fill: '#C8A882',
              fontFamily: 'monospace',
            }}
          >
            {coreModule?.label ?? 'AI SERVER'}
          </text>

          {/* Core status pip — bright green dot */}
          <circle
            cx={CX + CORE_R - 4}
            cy={CY - CORE_R + 4}
            r={4}
            fill="#4ADE80"
            opacity={0.9}
          />
        </motion.g>

        {/* ── Legend ── */}
        <g transform="translate(20, 566)">
          <circle cx={5} cy={5} r={4} fill="#E85D04" opacity={0.85} />
          <text
            x={14}
            y={5}
            dominantBaseline="middle"
            style={{ fontSize: '8px', fontFamily: 'monospace', letterSpacing: '0.08em', fill: '#8B7355' }}
          >
            AVAILABLE
          </text>
          <circle cx={90} cy={5} r={3} fill="#6B5E50" opacity={0.6} />
          <text
            x={98}
            y={5}
            dominantBaseline="middle"
            style={{ fontSize: '8px', fontFamily: 'monospace', letterSpacing: '0.08em', fill: '#5A4E3E' }}
          >
            COMING SOON
          </text>
        </g>

        {/* ── Scan label (top-right corner) ── */}
        <text
          x={578}
          y={22}
          textAnchor="end"
          style={{
            fontSize: '8px',
            fontFamily: 'monospace',
            letterSpacing: '0.12em',
            fill: '#E85D04',
            opacity: 0.45,
          }}
        >
          ACTIVE SCAN
        </text>
        <text
          x={578}
          y={34}
          textAnchor="end"
          style={{
            fontSize: '7px',
            fontFamily: 'monospace',
            letterSpacing: '0.08em',
            fill: '#6B5E50',
          }}
        >
          {`T=${SWEEP_PERIOD}s`}
        </text>
      </motion.svg>
    </div>
  )
}
