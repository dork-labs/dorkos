'use client'

import { useState } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { STAGGER, SCALE_IN, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Viewbox & palette constants ──────────────────────────────────────────────

const VB_W = 900
const VB_H = 560

const ORANGE       = '#E85D04'
const ORANGE_FLOW  = 'rgba(232, 93, 4, 0.55)'
const ORANGE_DIM   = 'rgba(232, 93, 4, 0.18)'

// ─── Node positions (force-directed style, hand-tuned) ────────────────────────
//
// Core sits slightly above center — gravitational anchor for the system.
// Modules with heavy connections (Console, Mesh) are pulled closer.
// Lightly-connected modules (Channels) push to the periphery.

const NODE_POS: Record<string, { x: number; y: number }> = {
  core:     { x: 450, y: 240 },   // gravitational center
  console:  { x: 222, y: 188 },   // heavy link — pulled close, upper-left
  mesh:     { x: 672, y: 192 },   // heavy link — pulled close, upper-right
  wing:    { x: 248, y: 388 },   // medium link — mid-left
  pulse:    { x: 652, y: 376 },   // medium link — mid-right
  channels: { x: 480, y: 468 },   // light link (from mesh) — lower center
}

/** Label placement: offset so text clears the node circle. */
const LABEL_OFFSETS: Record<string, { dx: number; dy: number; anchor: 'middle' | 'start' | 'end' }> = {
  core:     { dx:   0, dy: -50, anchor: 'middle' },
  console:  { dx: -20, dy: -44, anchor: 'end'    },
  mesh:     { dx:  20, dy: -44, anchor: 'start'  },
  wing:    { dx: -20, dy:  44, anchor: 'end'    },
  pulse:    { dx:  20, dy:  44, anchor: 'start'  },
  channels: { dx:   0, dy:  42, anchor: 'middle' },
}

// ─── Connection definitions ───────────────────────────────────────────────────

type FlowWeight = 'heavy' | 'medium' | 'light'

interface ConnectionDef {
  from:   string
  to:     string
  weight: FlowWeight
  bidir:  boolean
}

const CONNECTIONS: ConnectionDef[] = [
  { from: 'core', to: 'console',  weight: 'heavy',  bidir: true  },
  { from: 'core', to: 'mesh',     weight: 'heavy',  bidir: true  },
  { from: 'core', to: 'wing',    weight: 'medium', bidir: true  },
  { from: 'core', to: 'pulse',    weight: 'medium', bidir: true  },
  { from: 'mesh', to: 'channels', weight: 'light',  bidir: false },
  { from: 'mesh', to: 'pulse',    weight: 'light',  bidir: false },
]

/** Per-weight stream visual config. */
const WEIGHT_CFG: Record<FlowWeight, {
  strokeWidth:    number
  strokeOpacity:  number
  particleCount:  number
  speeds:         number[]   // animation durations (lower = faster)
  radii:          number[]
}> = {
  heavy: {
    strokeWidth:   2.5,
    strokeOpacity: 0.20,
    particleCount: 8,
    speeds: [2.2, 2.8, 3.4, 2.6, 3.0, 2.4, 3.2, 2.9],
    radii:  [2.5, 2.0, 3.0, 1.8, 2.8, 2.2, 2.6, 1.6],
  },
  medium: {
    strokeWidth:   1.8,
    strokeOpacity: 0.16,
    particleCount: 5,
    speeds: [3.2, 3.8, 2.9, 4.0, 3.5],
    radii:  [2.2, 1.8, 2.6, 1.6, 2.0],
  },
  light: {
    strokeWidth:   1.2,
    strokeOpacity: 0.12,
    particleCount: 3,
    speeds: [4.2, 5.0, 3.8],
    radii:  [1.8, 1.5, 2.0],
  },
}

/** Stagger offset between particles within one stream. */
const STREAM_STAGGER_S = 0.55

// ─── Quadratic Bezier path helpers ───────────────────────────────────────────

interface Point { x: number; y: number }

/**
 * Compute a quadratic Bezier control point offset perpendicular to the midpoint.
 *
 * @param a - Start point
 * @param b - End point
 * @param curvature - Perpendicular offset magnitude in SVG units
 * @param side - Which side to curve toward (+1 or -1)
 */
function quadCtrl(a: Point, b: Point, curvature: number, side: number): Point {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  return {
    x: mx + (-dy / len) * curvature * side,
    y: my + ( dx / len) * curvature * side,
  }
}

/** Build an SVG path string for a quadratic Bezier between two named nodes. */
function buildPath(fromId: string, toId: string, curvature: number, side: number): string {
  const a = NODE_POS[fromId]
  const b = NODE_POS[toId]
  if (!a || !b) return ''
  const c = quadCtrl(a, b, curvature, side)
  return `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`
}

/** Reverse path for a bidirectional return stream. */
function reversePath(fromId: string, toId: string, curvature: number, side: number): string {
  const a = NODE_POS[toId]
  const b = NODE_POS[fromId]
  if (!a || !b) return ''
  const c = quadCtrl(a, b, curvature, -side)
  return `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`
}

// ─── Seeded LCG random — deterministic, avoids hydration mismatches ───────────

function seededRand(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}

// Pre-compute particle opacity table
const _rng = seededRand(0xdeadbeef)
const OPACITY_TABLE = Array.from({ length: 64 }, () => 0.32 + _rng() * 0.48)

// ─── Node geometry ────────────────────────────────────────────────────────────

function nodeRadius(id: string, status: SystemModule['status']): number {
  if (id === 'core') return 34
  return status === 'available' ? 26 : 22
}

// ─── Background flow-field lines ─────────────────────────────────────────────

/** Faint cubic-Bezier curves that suggest an underlying force field. */
const FLOW_FIELD: string[] = [
  `M  80 100 C 200  60 350  80 500 100`,
  `M 500 100 C 620 120 760  90 880 130`,
  `M  60 220 C 180 180 340 200 480 220`,
  `M 480 220 C 600 240 740 200 880 230`,
  `M  80 340 C 210 300 360 330 500 350`,
  `M 500 350 C 620 360 750 320 880 360`,
  `M 120 460 C 250 420 390 450 540 470`,
  `M 540 470 C 660 490 780 440 880 480`,
  `M 200  60 C 180 200 210 320 240 440`,
  `M 450  80 C 430 200 450 330 460 460`,
  `M 720  70 C 710 200 730 320 700 450`,
]

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ParticleProps {
  path:    string
  dur:     number   // seconds
  begin:   number   // seconds
  r:       number
  opacity: number
}

/** A single SMIL particle travelling along a quadratic Bezier path. */
function Particle({ path, dur, begin, r, opacity }: ParticleProps) {
  return (
    <circle r={r} fill={ORANGE} opacity={opacity}>
      <animateMotion
        path={path}
        dur={`${dur}s`}
        begin={`${begin}s`}
        repeatCount="indefinite"
        calcMode="spline"
        keyPoints="0;1"
        keyTimes="0;1"
        keySplines="0.42 0 0.58 1"
      />
    </circle>
  )
}

interface StreamProps {
  conn:         ConnectionDef
  index:        number
  entranceDone: boolean
}

/**
 * One particle stream between two nodes.
 * Renders the faint guide path plus N staggered particles per direction.
 */
function ParticleStream({ conn, index, entranceDone }: StreamProps) {
  const cfg = WEIGHT_CFG[conn.weight]

  // Alternate curve side per connection to prevent path collisions
  const curvature = conn.weight === 'heavy' ? 28 : conn.weight === 'medium' ? 20 : 14
  const side = index % 2 === 0 ? 1 : -1

  const fwdPath = buildPath(conn.from, conn.to, curvature, side)
  const revPath = conn.bidir ? reversePath(conn.from, conn.to, curvature, side) : null

  // Draw particles beginning after node entrance animation
  const entranceDelay = 1.6 + index * 0.15
  const opBase = (index * cfg.particleCount) % OPACITY_TABLE.length

  return (
    <g>
      {/* Faint guide lines — visible before particles start */}
      <path
        d={fwdPath}
        fill="none"
        stroke={ORANGE_FLOW}
        strokeWidth={cfg.strokeWidth}
        strokeOpacity={cfg.strokeOpacity}
        strokeLinecap="round"
      />
      {revPath && (
        <path
          d={revPath}
          fill="none"
          stroke={ORANGE_FLOW}
          strokeWidth={cfg.strokeWidth}
          strokeOpacity={cfg.strokeOpacity * 0.65}
          strokeLinecap="round"
        />
      )}

      {/* Forward particles */}
      {entranceDone && Array.from({ length: cfg.particleCount }, (_, i) => (
        <Particle
          key={`fwd-${conn.from}-${conn.to}-${i}`}
          path={fwdPath}
          dur={cfg.speeds[i] ?? 3.0}
          begin={entranceDelay + i * STREAM_STAGGER_S}
          r={cfg.radii[i] ?? 2.0}
          opacity={OPACITY_TABLE[(opBase + i) % OPACITY_TABLE.length]}
        />
      ))}

      {/* Return particles (bidirectional only — fewer, slower, dimmer) */}
      {entranceDone && revPath && Array.from({ length: Math.ceil(cfg.particleCount * 0.6) }, (_, i) => (
        <Particle
          key={`rev-${conn.from}-${conn.to}-${i}`}
          path={revPath}
          dur={(cfg.speeds[i] ?? 3.0) * 1.3}
          begin={entranceDelay + i * STREAM_STAGGER_S + STREAM_STAGGER_S * 0.4}
          r={(cfg.radii[i] ?? 2.0) * 0.75}
          opacity={OPACITY_TABLE[(opBase + i + 4) % OPACITY_TABLE.length] * 0.65}
        />
      ))}
    </g>
  )
}

interface NodeBodyProps {
  module: SystemModule
  isCore: boolean
}

/** Node circle with inner labels and external name tag. */
function NodeBody({ module, isCore }: NodeBodyProps) {
  const pos = NODE_POS[module.id]
  const lbl = LABEL_OFFSETS[module.id]
  if (!pos || !lbl) return null

  const r         = nodeRadius(module.id, module.status)
  const available = module.status === 'available'
  const fillId    = isCore ? 'fill-core' : available ? 'fill-avail' : 'fill-soon'

  return (
    <motion.g variants={SCALE_IN} style={{ transformOrigin: `${pos.x}px ${pos.y}px` }}>
      {/* Outer glow ring (available only) */}
      {available && (
        <circle
          cx={pos.x} cy={pos.y}
          r={r + 4}
          fill="none"
          stroke={ORANGE}
          strokeWidth={isCore ? 2 : 1.5}
          strokeOpacity={isCore ? 0.55 : 0.35}
          filter="url(#node-glow)"
        />
      )}

      {/* Node body */}
      <circle
        cx={pos.x} cy={pos.y}
        r={r}
        fill={`url(#${fillId})`}
        stroke={ORANGE}
        strokeWidth={isCore ? 2.5 : available ? 1.8 : 1.2}
        strokeOpacity={isCore ? 0.75 : available ? 0.5 : 0.25}
        filter={available ? 'url(#node-glow)' : undefined}
      />

      {/* Module name — inside node */}
      <text
        x={pos.x} y={pos.y - (isCore ? 4 : 2)}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="var(--color-charcoal)"
        style={{
          fontSize: isCore ? '11px' : '9px',
          fontWeight: 700,
          letterSpacing: '0.05em',
          fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
        }}
      >
        {module.name}
      </text>

      {/* Module label — small, below name */}
      <text
        x={pos.x} y={pos.y + (isCore ? 9 : 8)}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={ORANGE}
        style={{
          fontSize: '7px',
          letterSpacing: '0.09em',
          fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
          opacity: available ? 0.8 : 0.35,
        }}
      >
        {module.label.toUpperCase()}
      </text>

      {/* External label — pushed outward from node */}
      <text
        x={pos.x + lbl.dx} y={pos.y + lbl.dy}
        textAnchor={lbl.anchor}
        fill="var(--color-charcoal)"
        style={{
          fontSize: isCore ? '13px' : '11px',
          fontWeight: isCore ? 700 : 600,
          letterSpacing: '-0.01em',
          opacity: available ? 1.0 : 0.5,
        }}
      >
        {module.name}
      </text>

      {/* Coming-soon badge */}
      {!available && (
        <text
          x={pos.x + lbl.dx} y={pos.y + lbl.dy + 14}
          textAnchor={lbl.anchor}
          fill={ORANGE}
          style={{
            fontSize: '7.5px',
            letterSpacing: '0.08em',
            fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
            opacity: 0.45,
          }}
        >
          COMING SOON
        </text>
      )}

      {/* Live indicator dot */}
      {available && (
        <circle
          cx={pos.x + r + 6} cy={pos.y - r + 4}
          r={3.5}
          fill={ORANGE}
          opacity={0.85}
          className="v10-live-dot"
        />
      )}
    </motion.g>
  )
}

interface CorePulseProps {
  active: boolean
}

/** Expanding pulse rings on Core — animated after entrance is done. */
function CorePulse({ active }: CorePulseProps) {
  const { x, y } = NODE_POS.core
  const base = nodeRadius('core', 'available')

  const pulseConfig = [
    { rBase: base + 8,  rEnd: base + 32, opPeak: 0.35, delay: 0    },
    { rBase: base + 4,  rEnd: base + 22, opPeak: 0.22, delay: 0.9  },
  ]

  return (
    <>
      {pulseConfig.map(({ rBase, rEnd, opPeak, delay }, i) => (
        <motion.circle
          key={i}
          cx={x} cy={y}
          r={rBase}
          fill="none"
          stroke={ORANGE}
          strokeWidth="1"
          animate={active ? {
            strokeOpacity: [0, opPeak, 0],
            r: [rBase, rEnd, rBase],
          } : { strokeOpacity: 0 }}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeOut', delay }}
        />
      ))}
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Particle flow / force-directed architecture diagram for DorkOS.
 *
 * Modules are rendered as glowing nodes connected by Bezier path streams
 * carrying continuous SMIL animateMotion particles. Connection weight
 * governs particle density and stream thickness, making data flow
 * between modules feel alive — like watching blood move through veins.
 */
export function DiagramV10({ modules }: { modules: SystemModule[] }) {
  const [entranceDone, setEntranceDone] = useState(false)

  return (
    <>
      <style>{`
        @keyframes v10-live {
          0%, 100% { opacity: 0.85; }
          50%       { opacity: 0.35; }
        }
        .v10-live-dot { animation: v10-live 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .v10-live-dot { animation: none !important; }
        }
      `}</style>

      <motion.svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        aria-label="DorkOS particle flow architecture diagram"
        role="img"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
        onAnimationComplete={() => setEntranceDone(true)}
      >
        <defs>
          {/* Node fill gradients */}
          <radialGradient id="fill-core" cx="40%" cy="35%" r="65%">
            <stop offset="0%"   stopColor="#FFFEFB" />
            <stop offset="100%" stopColor="#F5EFE8" />
          </radialGradient>
          <radialGradient id="fill-avail" cx="40%" cy="35%" r="65%">
            <stop offset="0%"   stopColor="#FFFEFB" />
            <stop offset="100%" stopColor="#F5EFE8" />
          </radialGradient>
          <radialGradient id="fill-soon" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#F5EFE8" />
            <stop offset="100%" stopColor="#EDE6DC" />
          </radialGradient>

          {/* Ambient glow behind core */}
          <radialGradient id="core-ambient" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={ORANGE} stopOpacity="0.14" />
            <stop offset="100%" stopColor={ORANGE} stopOpacity="0"    />
          </radialGradient>

          {/* Soft glow filter for nodes */}
          <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Ultra-soft blur for flow-field lines */}
          <filter id="field-blur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
        </defs>

        {/* ── Layer 0: Background force-field lines ──────────────────────── */}
        <g
          fill="none"
          stroke="var(--color-warm-gray, #9E8E80)"
          strokeWidth="1"
          opacity="0.045"
          filter="url(#field-blur)"
        >
          {FLOW_FIELD.map((d, i) => <path key={i} d={d} />)}
        </g>

        {/* ── Layer 1: Ambient core glow ─────────────────────────────────── */}
        <circle
          cx={NODE_POS.core.x}
          cy={NODE_POS.core.y}
          r={90}
          fill="url(#core-ambient)"
        />

        {/* ── Layer 2: Soft halos behind nodes ──────────────────────────── */}
        {modules.map((m) => {
          const pos = NODE_POS[m.id]
          if (!pos) return null
          const r = nodeRadius(m.id, m.status)
          return (
            <circle
              key={m.id}
              cx={pos.x} cy={pos.y}
              r={r + (m.status === 'available' ? 22 : 12)}
              fill={ORANGE_DIM}
              opacity={m.id === 'core' ? 0.9 : 0.6}
            />
          )
        })}

        {/* ── Layer 3: Particle streams ──────────────────────────────────── */}
        {CONNECTIONS.map((conn, i) => (
          <ParticleStream
            key={`${conn.from}-${conn.to}`}
            conn={conn}
            index={i}
            entranceDone={entranceDone}
          />
        ))}

        {/* ── Layer 4: Core pulse rings ──────────────────────────────────── */}
        <CorePulse active={entranceDone} />

        {/* ── Layer 5: Module nodes (staggered entrance) ────────────────── */}
        {modules.map((m) => (
          <NodeBody key={m.id} module={m} isCore={m.id === 'core'} />
        ))}

        {/* ── Layer 6: Legend ───────────────────────────────────────────── */}
        <g transform="translate(20, 524)" opacity="0.65">
          <circle cx={6} cy={6} r={4} fill={ORANGE} opacity={0.85} />
          <text x={14} y={6} dominantBaseline="middle"
            fill="var(--color-warm-gray, #9E8E80)"
            style={{ fontSize: '8.5px', letterSpacing: '0.06em', fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace' }}
          >AVAILABLE</text>

          <circle cx={90} cy={6} r={4} fill={ORANGE} opacity={0.28} />
          <text x={98} y={6} dominantBaseline="middle"
            fill="var(--color-warm-gray, #9E8E80)"
            style={{ fontSize: '8.5px', letterSpacing: '0.06em', fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace' }}
          >COMING SOON</text>

          <line x1={200} y1={6} x2={218} y2={6} stroke={ORANGE} strokeWidth="2.5" strokeOpacity="0.5" strokeLinecap="round" />
          <text x={222} y={6} dominantBaseline="middle"
            fill="var(--color-warm-gray, #9E8E80)"
            style={{ fontSize: '8.5px', letterSpacing: '0.06em', fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace' }}
          >HEAVY FLOW</text>

          <line x1={308} y1={6} x2={326} y2={6} stroke={ORANGE} strokeWidth="1.2" strokeOpacity="0.4" strokeLinecap="round" />
          <text x={330} y={6} dominantBaseline="middle"
            fill="var(--color-warm-gray, #9E8E80)"
            style={{ fontSize: '8.5px', letterSpacing: '0.06em', fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace' }}
          >LIGHT FLOW</text>
        </g>

        {/* ── Layer 7: Watermark ─────────────────────────────────────────── */}
        <text
          x={VB_W - 16} y={VB_H - 14}
          textAnchor="end"
          fill="var(--color-warm-gray, #9E8E80)"
          opacity="0.22"
          style={{ fontSize: '7.5px', letterSpacing: '0.08em', fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace' }}
        >
          DRK-OS · V10 · PARTICLE FLOW
        </text>
      </motion.svg>
    </>
  )
}
