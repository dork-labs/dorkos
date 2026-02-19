'use client'

import { useState } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { STAGGER, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Geometry ──────────────────────────────────────────────────────────────────

const VB_W = 900
const VB_H = 560

// Station center coordinates
const STATIONS = {
  core:     { x: 450, y: 280 },
  console:  { x: 150, y: 155 },
  wing:    { x: 150, y: 405 },
  pulse:    { x: 750, y: 155 },
  mesh:     { x: 750, y: 405 },
  channels: { x: 450, y: 490 },
} as const

// Transfer station IDs (Core, Mesh) — rendered larger with interchange ring
const TRANSFER_IDS = new Set(['core', 'mesh'])

// ─── Line definitions ──────────────────────────────────────────────────────────

interface MetroLine {
  id: string
  name: string
  color: string
  strokeWidth: number
  /** SVG path data — must use only H, V, or 45° diagonals */
  path: string
  /** Ordered station IDs that this line visits */
  stations: string[]
  /** animateMotion dur for the train */
  trainDur: string
  /** begin delay for SMIL train */
  trainBegin: string
}

const METRO_LINES: MetroLine[] = [
  {
    id: 'orange',
    name: 'User-Facing',
    color: 'var(--color-brand-orange)',
    strokeWidth: 6,
    // Console → H-right → elbow → Core → H-left → V-down → H-left → Wing
    path: 'M 150 155 H 310 L 450 280 H 280 V 405 H 150',
    stations: ['console', 'core', 'wing'],
    trainDur: '8s',
    trainBegin: '3.0s',
  },
  {
    id: 'green',
    name: 'Autonomy',
    color: 'var(--color-brand-green)',
    strokeWidth: 6,
    // Core → H-right → V-up → H-right → Pulse → V-down → Mesh
    path: 'M 450 280 H 620 V 155 H 750 V 405',
    stations: ['core', 'pulse', 'mesh'],
    trainDur: '9s',
    trainBegin: '4.2s',
  },
  {
    id: 'blue',
    name: 'Communication',
    color: 'var(--color-brand-blue)',
    strokeWidth: 5,
    // Mesh → V-down → H-left → Channels
    path: 'M 750 405 V 490 H 450',
    stations: ['mesh', 'channels'],
    trainDur: '6s',
    trainBegin: '5.8s',
  },
  {
    id: 'purple',
    name: 'Spine',
    color: 'var(--color-brand-purple)',
    strokeWidth: 8,
    // Core → V-down → H-right → Mesh (thicker — express line)
    path: 'M 450 280 V 405 H 750',
    stations: ['core', 'mesh'],
    trainDur: '7s',
    trainBegin: '6.8s',
  },
]

// ─── Legend data ───────────────────────────────────────────────────────────────

const LEGEND_ITEMS = [
  { color: 'var(--color-brand-orange)', label: 'User-Facing', dash: false },
  { color: 'var(--color-brand-green)',  label: 'Autonomy',    dash: false },
  { color: 'var(--color-brand-blue)',   label: 'Communication', dash: false },
  { color: 'var(--color-brand-purple)', label: 'Spine (Express)', dash: false },
] as const

// ─── Sub-components ────────────────────────────────────────────────────────────

interface StationProps {
  id: string
  x: number
  y: number
  mod: SystemModule
  /** Which line colors touch this station (for border ring) */
  lineColors: string[]
  isTransfer: boolean
}

/** Individual metro station rendered in SVG. */
function Station({ id, x, y, mod, lineColors, isTransfer }: StationProps) {
  const available = mod.status === 'available'
  const outerR = isTransfer ? 18 : 11
  const innerR = isTransfer ? 11 : 7
  const primaryColor = lineColors[0] ?? 'var(--color-brand-orange)'

  // Label placement: stations on the left go left, right go right, bottom go below
  const labelAnchor = x < 400 ? 'end' : x > 500 ? 'start' : 'middle'
  const labelX = x < 400 ? x - outerR - 10 : x > 500 ? x + outerR + 10 : x
  const labelY = id === 'channels' ? y + outerR + 22 : y

  return (
    <g>
      {/* Interchange ring for transfer stations */}
      {isTransfer && (
        <circle
          cx={x}
          cy={y}
          r={outerR + 6}
          fill="none"
          stroke={primaryColor}
          strokeWidth="1.5"
          strokeOpacity="0.25"
          strokeDasharray="3 4"
        />
      )}

      {/* Station outer ring (line color) */}
      <circle
        cx={x}
        cy={y}
        r={outerR}
        fill="var(--color-cream-white)"
        stroke={primaryColor}
        strokeWidth={isTransfer ? 3 : 2.5}
      />

      {/* Inner fill — available = solid primary color, coming-soon = hollow */}
      {available ? (
        <circle cx={x} cy={y} r={innerR} fill={primaryColor} opacity="0.85" />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={innerR}
          fill="none"
          stroke={primaryColor}
          strokeWidth="1.5"
          strokeOpacity="0.5"
          strokeDasharray="2 3"
        />
      )}

      {/* Second line indicator dot for transfer stations */}
      {isTransfer && lineColors.length > 1 && (
        <circle
          cx={x + outerR - 4}
          cy={y - outerR + 4}
          r={4}
          fill={lineColors[1]}
        />
      )}

      {/* Station name */}
      <text
        x={labelX}
        y={id === 'channels' ? labelY - 8 : labelY - 3}
        textAnchor={labelAnchor}
        dominantBaseline="middle"
        fill="var(--color-charcoal)"
        style={{ fontSize: isTransfer ? '13px' : '11px', fontWeight: isTransfer ? 700 : 600, letterSpacing: '-0.01em' }}
      >
        {mod.name}
      </text>

      {/* Station sub-label (module type) */}
      <text
        x={labelX}
        y={id === 'channels' ? labelY + 8 : labelY + 11}
        textAnchor={labelAnchor}
        dominantBaseline="middle"
        fill="var(--color-warm-gray)"
        style={{ fontSize: '9px', fontWeight: 400, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}
      >
        {mod.label}
      </text>

      {/* Status dot */}
      <circle
        cx={x < 400 ? x - outerR - 3 : x > 500 ? x + outerR + 3 : x + outerR + 3}
        cy={id === 'channels' ? y - outerR - 3 : y - 3}
        r={3}
        fill={available ? 'var(--color-brand-green)' : 'var(--color-warm-gray-light)'}
        opacity={available ? 0.9 : 0.55}
      />
    </g>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────────

/** Metro map architecture diagram — DorkOS modules as transit stations. */
export function DiagramV7({ modules }: { modules: SystemModule[] }) {
  const [entranceDone, setEntranceDone] = useState(false)

  // Build a lookup from module id → module data
  const moduleById = Object.fromEntries(modules.map((m) => [m.id, m]))

  // Build per-station line color list (for transfer station rings)
  const stationLines: Record<string, string[]> = {}
  for (const line of METRO_LINES) {
    for (const sid of line.stations) {
      if (!stationLines[sid]) stationLines[sid] = []
      stationLines[sid].push(line.color)
    }
  }

  // Unique station IDs in render order (lines first, then all stations)
  const allStationIds = Array.from(
    new Set(METRO_LINES.flatMap((l) => l.stations)),
  )

  return (
    <motion.svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className="w-full h-auto architecture-particles"
      preserveAspectRatio="xMidYMid meet"
      aria-label="DorkOS metro map architecture diagram"
      initial="hidden"
      whileInView="visible"
      viewport={VIEWPORT}
      variants={STAGGER}
      onAnimationComplete={() => setEntranceDone(true)}
    >
      <defs>
        {/* Subtle grid background — 40px grid dots */}
        <pattern id="metro-grid" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
          <circle cx="20" cy="20" r="1" fill="var(--color-warm-gray-light)" opacity="0.15" />
        </pattern>

        {/* Glow filter for transfer stations */}
        <filter id="station-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Line path IDs for train animateMotion */}
        {METRO_LINES.map((line) => (
          <path key={`path-def-${line.id}`} id={`metro-path-${line.id}`} d={line.path} />
        ))}
      </defs>

      {/* ── Background grid ── */}
      <rect width={VB_W} height={VB_H} fill="url(#metro-grid)" />

      {/* ── Map border frame — subtle reference to printed tube maps ── */}
      <rect
        x="8" y="8"
        width={VB_W - 16} height={VB_H - 16}
        fill="none"
        stroke="var(--color-warm-gray-light)"
        strokeWidth="0.5"
        strokeOpacity="0.2"
        rx="4"
      />

      {/* ── Layer 1: Metro lines (draw in sequence) ── */}
      {METRO_LINES.map((line, i) => (
        <motion.path
          key={line.id}
          d={line.path}
          fill="none"
          stroke={line.color}
          strokeWidth={line.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          variants={{
            hidden: { pathLength: 0, opacity: 0 },
            visible: {
              pathLength: 1,
              opacity: 1,
              transition: {
                pathLength: { duration: 1.4, ease: 'easeInOut', delay: i * 0.5 },
                opacity: { duration: 0.3, delay: i * 0.5 },
              },
            },
          }}
        />
      ))}

      {/* ── Layer 1b: Line casings (white outline behind lines for overlap clarity) ── */}
      {/* Render a slightly wider white stroke first so crossing lines look clean */}
      {/* We layer purple/spine behind others since it's the express */}

      {/* ── Layer 2: SMIL trains (post entrance) ── */}
      {entranceDone &&
        METRO_LINES.map((line) => (
          <circle key={`train-${line.id}`} r="4.5" fill={line.color} opacity="0.95">
            <animateMotion
              path={line.path}
              dur={line.trainDur}
              repeatCount="indefinite"
              begin={line.trainBegin}
            />
          </circle>
        ))}

      {/* ── Layer 2b: Return trains (traveling backward on some lines) ── */}
      {entranceDone && (
        <>
          <circle r="3" fill="var(--color-brand-orange)" opacity="0.6">
            <animateMotion
              path="M 150 405 H 280 V 280 L 310 155 H 450 L 280 280"
              dur="10s"
              repeatCount="indefinite"
              begin="7s"
            />
          </circle>
          <circle r="3" fill="var(--color-brand-green)" opacity="0.6">
            <animateMotion
              path="M 750 405 V 155 H 620 V 280 H 450"
              dur="11s"
              repeatCount="indefinite"
              begin="9s"
            />
          </circle>
        </>
      )}

      {/* ── Layer 3: Stations ── */}
      {allStationIds.map((sid) => {
        const pos = STATIONS[sid as keyof typeof STATIONS]
        const mod = moduleById[sid]
        if (!pos || !mod) return null
        return (
          <motion.g
            key={sid}
            variants={{
              hidden: { opacity: 0, scale: 0 },
              visible: {
                opacity: 1,
                scale: 1,
                transition: {
                  type: 'spring',
                  stiffness: 200,
                  damping: 18,
                  delay: METRO_LINES.findIndex((l) => l.stations.includes(sid)) * 0.5 + 0.9,
                },
              },
            }}
            style={{ transformOrigin: `${pos.x}px ${pos.y}px` }}
          >
            <Station
              id={sid}
              x={pos.x}
              y={pos.y}
              mod={mod}
              lineColors={stationLines[sid] ?? []}
              isTransfer={TRANSFER_IDS.has(sid)}
            />
          </motion.g>
        )
      })}

      {/* ── Layer 4: Transfer station pulse rings (Core + Mesh) ── */}
      {entranceDone &&
        Array.from(TRANSFER_IDS).map((sid) => {
          const pos = STATIONS[sid as keyof typeof STATIONS]
          const colors = stationLines[sid] ?? []
          return (
            <motion.circle
              key={`pulse-${sid}`}
              cx={pos.x}
              cy={pos.y}
              r={28}
              fill="none"
              stroke={colors[0] ?? 'var(--color-brand-orange)'}
              strokeWidth="1"
              animate={{
                r: [24, 38, 24],
                strokeOpacity: [0.4, 0, 0.4],
              }}
              transition={{
                duration: 3.5,
                repeat: Infinity,
                ease: 'easeOut',
                delay: sid === 'mesh' ? 1.2 : 0,
              }}
            />
          )
        })}

      {/* ── Layer 5: Map title block (top-left corner, tube-map style) ── */}
      <g transform="translate(30, 30)">
        <rect
          x="0" y="0" width="160" height="52"
          fill="var(--color-cream-white)"
          stroke="var(--color-warm-gray-light)"
          strokeWidth="0.5"
          strokeOpacity="0.4"
          rx="3"
          fillOpacity="0.85"
        />
        <text
          x="12" y="19"
          fill="var(--color-charcoal)"
          style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '-0.01em' }}
        >
          DorkOS System
        </text>
        <text
          x="12" y="34"
          fill="var(--color-warm-gray)"
          style={{ fontSize: '8px', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}
        >
          Architecture Transit Map
        </text>
        <text
          x="12" y="47"
          fill="var(--color-warm-gray-light)"
          style={{ fontSize: '7px', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}
        >
          Rev. 2026 — 6 Stations
        </text>
      </g>

      {/* ── Layer 6: Legend (bottom-right, classic tube map style) ── */}
      <g transform={`translate(${VB_W - 220}, ${VB_H - 148})`}>
        <rect
          x="0" y="0" width="200" height="136"
          fill="var(--color-cream-white)"
          stroke="var(--color-warm-gray-light)"
          strokeWidth="0.5"
          strokeOpacity="0.4"
          rx="3"
          fillOpacity="0.92"
        />

        <text
          x="10" y="18"
          fill="var(--color-charcoal)"
          style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}
        >
          Lines
        </text>

        {LEGEND_ITEMS.map((item, i) => {
          const y = 34 + i * 22
          return (
            <g key={item.label} transform={`translate(10, ${y})`}>
              {/* Line swatch */}
              <rect x="0" y="-4" width="28" height="7" rx="3.5" fill={item.color} />
              <text
                x="36" y="1"
                dominantBaseline="middle"
                fill="var(--color-warm-gray)"
                style={{ fontSize: '9px', letterSpacing: '0.02em' }}
              >
                {item.label}
              </text>
            </g>
          )
        })}

        {/* Divider */}
        <line x1="10" y1="124" x2="190" y2="124" stroke="var(--color-warm-gray-light)" strokeWidth="0.5" strokeOpacity="0.4" />

        {/* Station type legend */}
        <g transform="translate(10, 132)">
          <circle cx="5" cy="0" r="5" fill="var(--color-cream-white)" stroke="var(--color-brand-orange)" strokeWidth="2" />
          <circle cx="5" cy="0" r="2.5" fill="var(--color-brand-orange)" opacity="0.85" />
          <text x="15" y="1" dominantBaseline="middle" fill="var(--color-warm-gray)" style={{ fontSize: '8.5px' }}>Available</text>

          <circle cx="85" cy="0" r="5" fill="var(--color-cream-white)" stroke="var(--color-warm-gray-light)" strokeWidth="1.5" strokeDasharray="2 2.5" />
          <text x="95" y="1" dominantBaseline="middle" fill="var(--color-warm-gray)" style={{ fontSize: '8.5px' }}>Coming Soon</text>
        </g>
      </g>

      {/* ── Layer 7: Zone labels — cardinal compass-style area markers ── */}
      <text
        x="450" y="42"
        textAnchor="middle"
        fill="var(--color-warm-gray-light)"
        style={{ fontSize: '8px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}
        opacity="0.5"
      >
        North
      </text>
      <text
        x="450" y={VB_H - 16}
        textAnchor="middle"
        fill="var(--color-warm-gray-light)"
        style={{ fontSize: '8px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}
        opacity="0.5"
      >
        South
      </text>
    </motion.svg>
  )
}
