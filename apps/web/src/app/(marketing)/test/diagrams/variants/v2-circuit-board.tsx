'use client'

import { useState } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { REVEAL, STAGGER, SCALE_IN, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Layout constants ──────────────────────────────────────────────────────────

const VB_W = 800
const VB_H = 520

/** Chip dimensions */
const CORE_W = 140
const CORE_H = 80
const SIDE_W = 120
const SIDE_H = 72
const BUS_W = 118
const BUS_H = 64

/** Chip center positions */
const POS = {
  core:     { x: VB_W / 2,      y: 185 },
  console:  { x: 155,           y: 185 },
  wing:    { x: VB_W - 155,    y: 185 },
  pulse:    { x: 185,           y: 395 },
  mesh:     { x: VB_W / 2,      y: 395 },
  channels: { x: VB_W - 185,    y: 395 },
} as const

/** Pin connector geometry — 4px squares on chip edges */
const PIN_SIZE = 5

// ─── Trace routing helpers ─────────────────────────────────────────────────────

/**
 * Compute SVG path string for a right-angle trace from (x1,y1) to (x2,y2).
 * Always routes horizontal-first then vertical.
 */
function hvPath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}`
}

/**
 * Compute SVG path string for a right-angle trace from (x1,y1) to (x2,y2).
 * Routes vertical-first then horizontal.
 */
function vhPath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`
}

// ─── Static layout data ────────────────────────────────────────────────────────

/**
 * PCB trace routes. Each trace has:
 * - d: SVG path (right-angle only)
 * - animDelay: CSS animation-delay for the traveling pulse dot
 * - animDur: CSS animation-duration for the traveling pulse dot
 * - pulseLen: approximate total path length (for animateMotion timing)
 */
const TRACES = [
  // Console ─── horizontal ──► Core (left pin of Core to right pin of Console)
  {
    id: 'console-core',
    d: `M ${POS.console.x + SIDE_W / 2} ${POS.console.y} L ${POS.core.x - CORE_W / 2} ${POS.console.y}`,
    delay: 0,
    dur: 2.2,
  },
  // Core ─── horizontal ──► Wing (right pin of Core to left pin of Wing)
  {
    id: 'core-wing',
    d: `M ${POS.core.x + CORE_W / 2} ${POS.core.y} L ${POS.wing.x - SIDE_W / 2} ${POS.wing.y}`,
    delay: 0.2,
    dur: 2.4,
  },
  // Core ──► Mesh (vertical drop from bottom pin of Core to top pin of Mesh)
  {
    id: 'core-mesh',
    d: vhPath(POS.core.x, POS.core.y + CORE_H / 2, POS.mesh.x, POS.mesh.y - BUS_H / 2),
    delay: 0.4,
    dur: 2.0,
  },
  // Core ──► Pulse (down then left — elbow routing)
  {
    id: 'core-pulse',
    d: hvPath(POS.core.x, POS.core.y + CORE_H / 2 + 20, POS.pulse.x, POS.pulse.y - BUS_H / 2),
    delay: 0.6,
    dur: 2.8,
  },
  // Core ──► Channels (down then right — elbow routing)
  {
    id: 'core-channels',
    d: hvPath(POS.core.x, POS.core.y + CORE_H / 2 + 20, POS.channels.x, POS.channels.y - BUS_H / 2),
    delay: 0.8,
    dur: 2.6,
  },
] as const

/** PCB background grid tile size (subtle substrate grid) */
const GRID = 20

// ─── Sub-components ────────────────────────────────────────────────────────────

/** Solder joint dot at a trace connection point. */
function SolderJoint({ cx, cy }: { cx: number; cy: number }) {
  return (
    <motion.circle
      cx={cx}
      cy={cy}
      r={3.5}
      fill="var(--color-brand-orange)"
      opacity={0.85}
      variants={SCALE_IN}
    />
  )
}

/** Chip pin connector rectangle (appears on chip edge). */
function Pin({ x, y, horizontal }: { x: number; y: number; horizontal: boolean }) {
  const w = horizontal ? PIN_SIZE * 2 : PIN_SIZE
  const h = horizontal ? PIN_SIZE : PIN_SIZE * 2
  return (
    <rect
      x={x - w / 2}
      y={y - h / 2}
      width={w}
      height={h}
      fill="var(--color-warm-gray)"
      opacity={0.5}
      rx={1}
    />
  )
}

interface ChipProps {
  id: string
  cx: number
  cy: number
  w: number
  h: number
  name: string
  label: string
  status: 'available' | 'coming-soon'
  isCore?: boolean
}

/** IC chip rectangle with notch, pin connectors, name, label, and status LED. */
function Chip({ cx, cy, w, h, name, label, status, isCore }: ChipProps) {
  const x = cx - w / 2
  const y = cy - h / 2
  const statusColor = status === 'available' ? '#228B22' : '#7A756A'
  const ledOpacity = status === 'available' ? 0.9 : 0.4

  // Notch radius (IC orientation notch on left edge)
  const notchR = 6

  // Chip body path: rect with a notch cutout on the left
  const bodyPath = [
    `M ${x + notchR * 2} ${y}`,
    `L ${x + w} ${y}`,
    `L ${x + w} ${y + h}`,
    `L ${x} ${y + h}`,
    `L ${x} ${y + notchR * 2}`,
    `A ${notchR} ${notchR} 0 0 1 ${x + notchR * 2} ${y}`,
    'Z',
  ].join(' ')

  return (
    <motion.g variants={isCore ? SCALE_IN : REVEAL}>
      {/* Chip body */}
      <path
        d={bodyPath}
        fill="var(--color-cream-white)"
        stroke="var(--color-charcoal)"
        strokeWidth={isCore ? 1.5 : 1.2}
        opacity={0.97}
      />

      {/* IC orientation arc notch */}
      <path
        d={`M ${x} ${y + notchR * 2} A ${notchR} ${notchR} 0 0 1 ${x + notchR * 2} ${y}`}
        fill="none"
        stroke="var(--color-charcoal)"
        strokeWidth={1}
        opacity={0.3}
      />

      {/* Corner registration marks — top-right and bottom-right */}
      <line x1={x + w - 8} y1={y} x2={x + w} y2={y + 8}
        stroke="var(--color-charcoal)" strokeWidth={0.8} opacity={0.2} />
      <line x1={x + w - 8} y1={y + h} x2={x + w} y2={y + h - 8}
        stroke="var(--color-charcoal)" strokeWidth={0.8} opacity={0.2} />

      {/* Status LED indicator dot (top-right area) */}
      <circle
        cx={x + w - 10}
        cy={y + 10}
        r={3}
        fill={statusColor}
        opacity={ledOpacity}
      />
      {/* LED glow ring (available modules only) */}
      {status === 'available' && (
        <circle
          cx={x + w - 10}
          cy={y + 10}
          r={5}
          fill="none"
          stroke={statusColor}
          strokeWidth={0.8}
          opacity={0.3}
        />
      )}

      {/* Module name */}
      <text
        x={cx}
        y={cy - 6}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={isCore ? 13 : 11}
        fontWeight={600}
        fontFamily="var(--font-mono, ui-monospace)"
        fill="var(--color-charcoal)"
        letterSpacing="0.02em"
      >
        {name}
      </text>

      {/* Module label */}
      <text
        x={cx}
        y={cy + 11}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={isCore ? 9 : 8}
        fontFamily="var(--font-mono, ui-monospace)"
        fill="var(--color-warm-gray)"
        letterSpacing="0.06em"
        style={{ textTransform: 'uppercase' }}
        opacity={0.8}
      >
        {label.toUpperCase()}
      </text>

      {/* Horizontal pin stubs on left and right edges */}
      <Pin x={x} y={cy - h * 0.25} horizontal={true} />
      <Pin x={x} y={cy + h * 0.25} horizontal={true} />
      <Pin x={x + w} y={cy - h * 0.25} horizontal={true} />
      <Pin x={x + w} y={cy + h * 0.25} horizontal={true} />

      {/* Vertical pin stubs on top and bottom edges */}
      <Pin x={cx - w * 0.25} y={y} horizontal={false} />
      <Pin x={cx + w * 0.25} y={y} horizontal={false} />
      <Pin x={cx - w * 0.25} y={y + h} horizontal={false} />
      <Pin x={cx + w * 0.25} y={y + h} horizontal={false} />
    </motion.g>
  )
}

// ─── Solder joint positions (where traces meet chip edges) ─────────────────────

const SOLDER_JOINTS = [
  // Console–Core horizontal trace endpoints
  { cx: POS.console.x + SIDE_W / 2,    cy: POS.console.y },
  { cx: POS.core.x - CORE_W / 2,       cy: POS.core.y },
  // Core–Wing horizontal trace endpoints
  { cx: POS.core.x + CORE_W / 2,       cy: POS.core.y },
  { cx: POS.wing.x - SIDE_W / 2,      cy: POS.wing.y },
  // Core–Mesh vertical trace: bottom of Core, top of Mesh
  { cx: POS.core.x,                    cy: POS.core.y + CORE_H / 2 },
  { cx: POS.mesh.x,                    cy: POS.mesh.y - BUS_H / 2 },
  // Core–Pulse elbow: elbow corner and Pulse top
  { cx: POS.core.x,                    cy: POS.core.y + CORE_H / 2 + 20 },
  { cx: POS.pulse.x,                   cy: POS.pulse.y - BUS_H / 2 },
  // Core–Channels elbow: elbow corner and Channels top
  { cx: POS.channels.x,               cy: POS.core.y + CORE_H / 2 + 20 },
  { cx: POS.channels.x,               cy: POS.channels.y - BUS_H / 2 },
] as const

// ─── Main component ────────────────────────────────────────────────────────────

/**
 * Circuit board architecture diagram — PCB aesthetic with right-angle traces,
 * IC chip modules, solder joints, and animated signal pulses.
 *
 * @param modules - The six DorkOS system modules to render as IC chips.
 */
export function DiagramV2({ modules }: { modules: SystemModule[] }) {
  const [drawn, setDrawn] = useState(false)

  const byId = Object.fromEntries(modules.map((m) => [m.id, m]))

  return (
    <>
      {/* Inline keyframes for the repeating signal pulse CSS animation */}
      <style>{`
        @keyframes pcb-pulse-travel {
          0%   { offset-distance: 0%;   opacity: 0; }
          5%   { opacity: 1; }
          90%  { opacity: 1; }
          100% { offset-distance: 100%; opacity: 0; }
        }

        .pcb-pulse {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--color-brand-orange);
          box-shadow: 0 0 6px 2px var(--color-brand-orange);
          position: absolute;
          animation: pcb-pulse-travel 3s ease-in-out infinite;
          animation-fill-mode: both;
        }

        @media (prefers-reduced-motion: reduce) {
          .pcb-pulse { animation: none; opacity: 0; }
        }
      `}</style>

      <motion.svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        aria-label="DorkOS circuit board architecture diagram"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
        onAnimationComplete={() => setDrawn(true)}
      >
        {/* ── PCB substrate background ── */}
        <defs>
          {/* Substrate grid pattern — subtle PCB-green-ish grid lines */}
          <pattern id="pcb-grid" x="0" y="0" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <path
              d={`M ${GRID} 0 L 0 0 0 ${GRID}`}
              fill="none"
              stroke="var(--color-charcoal)"
              strokeWidth="0.3"
              opacity="0.07"
            />
          </pattern>

          {/* Trace glow filter */}
          <filter id="trace-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Pulse dot glow filter */}
          <filter id="pulse-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Signal pulse marker for animateMotion */}
          <circle id="signal-dot" r="3.5" fill="var(--color-brand-orange)" filter="url(#pulse-glow)" />
        </defs>

        {/* Substrate: fill + grid */}
        <rect width={VB_W} height={VB_H} fill="var(--color-cream-white)" opacity={0.6} rx={4} />
        <rect width={VB_W} height={VB_H} fill="url(#pcb-grid)" rx={4} />

        {/* Substrate edge markings — corner fiducials (PCB alignment marks) */}
        {([
          [24, 24], [VB_W - 24, 24], [24, VB_H - 24], [VB_W - 24, VB_H - 24],
        ] as [number, number][]).map(([fx, fy], i) => (
          <g key={i}>
            <circle cx={fx} cy={fy} r={6} fill="none" stroke="var(--color-charcoal)" strokeWidth={0.8} opacity={0.15} />
            <circle cx={fx} cy={fy} r={1.5} fill="var(--color-charcoal)" opacity={0.15} />
          </g>
        ))}

        {/* PCB silkscreen border (dashed inner frame) */}
        <rect
          x={16} y={16} width={VB_W - 32} height={VB_H - 32}
          fill="none"
          stroke="var(--color-charcoal)"
          strokeWidth={0.5}
          strokeDasharray="4 8"
          opacity={0.08}
          rx={2}
        />

        {/* ── Horizontal bus rail (bottom row connection backbone) ── */}
        <motion.line
          x1={POS.pulse.x}
          y1={POS.mesh.y - BUS_H / 2 - 20}
          x2={POS.channels.x}
          y2={POS.mesh.y - BUS_H / 2 - 20}
          stroke="var(--color-warm-gray)"
          strokeWidth={1}
          strokeOpacity={0.2}
          strokeDasharray="3 6"
          variants={{
            hidden: { pathLength: 0, opacity: 0 },
            visible: { pathLength: 1, opacity: 1, transition: { duration: 1.0, delay: 0.3 } },
          }}
        />

        {/* ── PCB traces (right-angle routing) ── */}
        {TRACES.map((trace, i) => (
          <g key={trace.id}>
            {/* Primary trace line */}
            <motion.path
              d={trace.d}
              fill="none"
              stroke="var(--color-brand-orange)"
              strokeWidth={2}
              strokeOpacity={0.55}
              strokeLinecap="square"
              filter="url(#trace-glow)"
              variants={{
                hidden: { pathLength: 0, opacity: 0 },
                visible: {
                  pathLength: 1,
                  opacity: 1,
                  transition: { duration: 1.0, delay: 0.15 * i, ease: 'easeInOut' },
                },
              }}
            />

            {/* Traveling signal pulse using SMIL animateMotion */}
            {drawn && (
              <circle r="3.5" fill="var(--color-brand-orange)" filter="url(#pulse-glow)">
                <animateMotion
                  path={trace.d}
                  dur={`${trace.dur}s`}
                  begin={`${trace.delay + 1.2}s`}
                  repeatCount="indefinite"
                  rotate="auto"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.05;0.9;1"
                  dur={`${trace.dur}s`}
                  begin={`${trace.delay + 1.2}s`}
                  repeatCount="indefinite"
                />
              </circle>
            )}
          </g>
        ))}

        {/* ── Solder joint dots ── */}
        <motion.g variants={STAGGER}>
          {SOLDER_JOINTS.map((joint, i) => (
            <SolderJoint key={i} cx={joint.cx} cy={joint.cy} />
          ))}
        </motion.g>

        {/* ── IC Chip modules ── */}

        {/* Core — center, larger chip */}
        <Chip
          id="core"
          cx={POS.core.x}
          cy={POS.core.y}
          w={CORE_W}
          h={CORE_H}
          name={byId['core']?.name ?? 'Core'}
          label={byId['core']?.label ?? 'AI Server'}
          status={byId['core']?.status ?? 'available'}
          isCore
        />

        {/* Console — left flank */}
        <Chip
          id="console"
          cx={POS.console.x}
          cy={POS.console.y}
          w={SIDE_W}
          h={SIDE_H}
          name={byId['console']?.name ?? 'Console'}
          label={byId['console']?.label ?? 'Web UI'}
          status={byId['console']?.status ?? 'available'}
        />

        {/* Wing — right flank */}
        <Chip
          id="wing"
          cx={POS.wing.x}
          cy={POS.wing.y}
          w={SIDE_W}
          h={SIDE_H}
          name={byId['wing']?.name ?? 'Wing'}
          label={byId['wing']?.label ?? 'Knowledge'}
          status={byId['wing']?.status ?? 'coming-soon'}
        />

        {/* Lower bus — Pulse, Mesh, Channels */}
        <Chip
          id="pulse"
          cx={POS.pulse.x}
          cy={POS.pulse.y}
          w={BUS_W}
          h={BUS_H}
          name={byId['pulse']?.name ?? 'Pulse'}
          label={byId['pulse']?.label ?? 'Heartbeat'}
          status={byId['pulse']?.status ?? 'coming-soon'}
        />
        <Chip
          id="mesh"
          cx={POS.mesh.x}
          cy={POS.mesh.y}
          w={BUS_W}
          h={BUS_H}
          name={byId['mesh']?.name ?? 'Mesh'}
          label={byId['mesh']?.label ?? 'Agent Net'}
          status={byId['mesh']?.status ?? 'coming-soon'}
        />
        <Chip
          id="channels"
          cx={POS.channels.x}
          cy={POS.channels.y}
          w={BUS_W}
          h={BUS_H}
          name={byId['channels']?.name ?? 'Channels'}
          label={byId['channels']?.label ?? 'Integrations'}
          status={byId['channels']?.status ?? 'coming-soon'}
        />

        {/* ── Silkscreen module reference designators ── */}
        {/* Small "U1", "U2" etc. ref designators below each chip, PCB style */}
        {([
          { label: 'U1', cx: POS.core.x,     cy: POS.core.y + CORE_H / 2 + 12 },
          { label: 'U2', cx: POS.console.x,  cy: POS.console.y + SIDE_H / 2 + 12 },
          { label: 'U3', cx: POS.wing.x,    cy: POS.wing.y + SIDE_H / 2 + 12 },
          { label: 'U4', cx: POS.pulse.x,    cy: POS.pulse.y + BUS_H / 2 + 11 },
          { label: 'U5', cx: POS.mesh.x,     cy: POS.mesh.y + BUS_H / 2 + 11 },
          { label: 'U6', cx: POS.channels.x, cy: POS.channels.y + BUS_H / 2 + 11 },
        ] as const).map(({ label, cx, cy }) => (
          <text
            key={label}
            x={cx}
            y={cy}
            textAnchor="middle"
            fontSize={7}
            fontFamily="var(--font-mono, ui-monospace)"
            fill="var(--color-charcoal)"
            opacity={0.25}
            letterSpacing="0.08em"
          >
            {label}
          </text>
        ))}

        {/* ── PCB board label ── */}
        <text
          x={VB_W - 20}
          y={VB_H - 20}
          textAnchor="end"
          fontSize={7.5}
          fontFamily="var(--font-mono, ui-monospace)"
          fill="var(--color-charcoal)"
          opacity={0.18}
          letterSpacing="0.1em"
        >
          DORKOS-REV-A  PCB-2026
        </text>

        <text
          x={20}
          y={VB_H - 20}
          textAnchor="start"
          fontSize={7.5}
          fontFamily="var(--font-mono, ui-monospace)"
          fill="var(--color-charcoal)"
          opacity={0.18}
          letterSpacing="0.1em"
        >
          DORK-LABS
        </text>
      </motion.svg>
    </>
  )
}
