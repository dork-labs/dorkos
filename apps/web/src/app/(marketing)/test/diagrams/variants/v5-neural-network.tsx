'use client'

import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import {
  STAGGER,
  SCALE_IN,
  VIEWPORT,
} from '@/layers/features/marketing/lib/motion-variants'

// ---------------------------------------------------------------------------
// Layout constants — organic, brain-like positioning in a 900×520 viewBox
// ---------------------------------------------------------------------------

/** Major neuron positions — large nodes representing each module. */
const NEURON_POSITIONS: Record<string, { cx: number; cy: number }> = {
  core:     { cx: 450, cy:  88 },
  console:  { cx: 192, cy: 205 },
  pulse:    { cx: 708, cy: 198 },
  wing:    { cx: 148, cy: 378 },
  mesh:     { cx: 452, cy: 408 },
  channels: { cx: 754, cy: 365 },
}

/** Radius of the major neuron circles. */
const NEURON_R = 26

/** Visual config per status. */
const STATUS_CONFIG = {
  available: { glowOpacity: 0.55, strokeOpacity: 1, fillOpacity: 1, pulseClass: 'neuron-breathe' },
  'coming-soon': { glowOpacity: 0.22, strokeOpacity: 0.55, fillOpacity: 0.85, pulseClass: 'neuron-breathe-dim' },
} as const

// ---------------------------------------------------------------------------
// Relay nodes — smaller intermediate nodes creating the neural mesh texture
// ---------------------------------------------------------------------------

interface RelayNode {
  id: string
  cx: number
  cy: number
  delay: number
}

const RELAY_NODES: RelayNode[] = [
  { id: 'r1',  cx: 318, cy: 130, delay: 0.0  },
  { id: 'r2',  cx: 580, cy: 118, delay: 0.4  },
  { id: 'r3',  cx: 260, cy: 290, delay: 0.8  },
  { id: 'r4',  cx: 620, cy: 278, delay: 0.2  },
  { id: 'r5',  cx: 355, cy: 310, delay: 1.0  },
  { id: 'r6',  cx: 560, cy: 325, delay: 0.6  },
  { id: 'r7',  cx: 188, cy: 490, delay: 1.4  },
  { id: 'r8',  cx: 660, cy: 450, delay: 0.9  },
  { id: 'r9',  cx: 385, cy: 465, delay: 1.2  },
  { id: 'r10', cx: 518, cy: 155, delay: 0.3  },
]

// ---------------------------------------------------------------------------
// Dendrite connections — cubic Bezier paths between major neurons + relays
// ---------------------------------------------------------------------------

interface DendriteConnection {
  id: string
  /** Full SVG path `d` attribute — cubic or quadratic Bezier. */
  d: string
  /** Delay for draw-in animation (seconds). */
  delay: number
  /** Synaptic pulse travel duration (seconds). */
  pulseDur: string
  /** Whether this carries a visible synaptic pulse. */
  hasPulse: boolean
}

const DENDRITES: DendriteConnection[] = [
  // Core → Console
  {
    id: 'd-core-console',
    d: 'M 440,106 C 390,145 290,168 210,200',
    delay: 0.0,
    pulseDur: '3.2s',
    hasPulse: true,
  },
  // Core → Pulse
  {
    id: 'd-core-pulse',
    d: 'M 462,108 C 510,148 618,170 700,195',
    delay: 0.15,
    pulseDur: '2.8s',
    hasPulse: true,
  },
  // Core → r1 (relay)
  {
    id: 'd-core-r1',
    d: 'M 435,108 C 400,120 355,128 328,130',
    delay: 0.05,
    pulseDur: '4.0s',
    hasPulse: false,
  },
  // Core → r2 (relay)
  {
    id: 'd-core-r2',
    d: 'M 464,108 C 500,120 545,118 572,118',
    delay: 0.08,
    pulseDur: '4.5s',
    hasPulse: false,
  },
  // Core → r10 (relay — directly below)
  {
    id: 'd-core-r10',
    d: 'M 453,114 C 452,130 500,148 516,155',
    delay: 0.12,
    pulseDur: '3.8s',
    hasPulse: false,
  },
  // Console → r3
  {
    id: 'd-console-r3',
    d: 'M 198,224 C 215,248 240,270 255,290',
    delay: 0.3,
    pulseDur: '3.5s',
    hasPulse: false,
  },
  // Console → Wing
  {
    id: 'd-console-wing',
    d: 'M 182,226 C 170,278 152,320 150,358',
    delay: 0.4,
    pulseDur: '3.6s',
    hasPulse: true,
  },
  // Pulse → r4
  {
    id: 'd-pulse-r4',
    d: 'M 702,218 C 685,238 652,260 628,278',
    delay: 0.3,
    pulseDur: '3.2s',
    hasPulse: false,
  },
  // Pulse → Channels
  {
    id: 'd-pulse-channels',
    d: 'M 718,218 C 730,272 748,320 754,346',
    delay: 0.45,
    pulseDur: '3.0s',
    hasPulse: true,
  },
  // r1 → r3 (relay mesh)
  {
    id: 'd-r1-r3',
    d: 'M 315,140 C 296,178 272,238 262,288',
    delay: 0.5,
    pulseDur: '5.0s',
    hasPulse: false,
  },
  // r1 → r5
  {
    id: 'd-r1-r5',
    d: 'M 330,148 C 340,210 350,268 356,308',
    delay: 0.55,
    pulseDur: '4.8s',
    hasPulse: false,
  },
  // r2 → r4
  {
    id: 'd-r2-r4',
    d: 'M 578,128 C 595,172 610,228 622,276',
    delay: 0.5,
    pulseDur: '4.6s',
    hasPulse: false,
  },
  // r2 → r6
  {
    id: 'd-r2-r6',
    d: 'M 575,130 C 572,200 568,272 562,322',
    delay: 0.58,
    pulseDur: '4.2s',
    hasPulse: false,
  },
  // r3 → Wing
  {
    id: 'd-r3-wing',
    d: 'M 252,302 C 220,332 178,358 155,372',
    delay: 0.7,
    pulseDur: '3.8s',
    hasPulse: false,
  },
  // r3 → r5
  {
    id: 'd-r3-r5',
    d: 'M 268,298 C 300,302 330,306 348,310',
    delay: 0.65,
    pulseDur: '5.2s',
    hasPulse: false,
  },
  // r5 → Mesh
  {
    id: 'd-r5-mesh',
    d: 'M 360,322 C 385,355 415,384 432,402',
    delay: 0.8,
    pulseDur: '3.4s',
    hasPulse: true,
  },
  // r6 → Mesh
  {
    id: 'd-r6-mesh',
    d: 'M 558,334 C 535,360 500,388 468,402',
    delay: 0.82,
    pulseDur: '3.2s',
    hasPulse: true,
  },
  // r4 → Channels
  {
    id: 'd-r4-channels',
    d: 'M 632,286 C 672,310 720,338 748,358',
    delay: 0.75,
    pulseDur: '3.6s',
    hasPulse: false,
  },
  // r4 → r6
  {
    id: 'd-r4-r6',
    d: 'M 618,286 C 598,300 578,312 566,325',
    delay: 0.68,
    pulseDur: '4.4s',
    hasPulse: false,
  },
  // Wing → r7
  {
    id: 'd-wing-r7',
    d: 'M 148,398 C 160,424 178,462 182,488',
    delay: 0.9,
    pulseDur: '4.0s',
    hasPulse: false,
  },
  // Wing → r9
  {
    id: 'd-wing-r9',
    d: 'M 165,388 C 230,410 310,438 380,462',
    delay: 0.92,
    pulseDur: '3.8s',
    hasPulse: false,
  },
  // Mesh → r9
  {
    id: 'd-mesh-r9',
    d: 'M 445,428 C 435,442 418,452 392,464',
    delay: 0.95,
    pulseDur: '3.6s',
    hasPulse: false,
  },
  // Mesh → r8
  {
    id: 'd-mesh-r8',
    d: 'M 465,426 C 520,438 588,444 652,448',
    delay: 0.95,
    pulseDur: '4.2s',
    hasPulse: false,
  },
  // Channels → r8
  {
    id: 'd-channels-r8',
    d: 'M 748,383 C 730,408 702,428 668,448',
    delay: 1.0,
    pulseDur: '3.4s',
    hasPulse: false,
  },
  // Console → Mesh (long cross-connection)
  {
    id: 'd-console-mesh',
    d: 'M 212,222 C 280,300 370,360 432,402',
    delay: 0.6,
    pulseDur: '4.4s',
    hasPulse: true,
  },
  // Pulse → Mesh (long cross-connection)
  {
    id: 'd-pulse-mesh',
    d: 'M 690,216 C 640,290 560,360 470,402',
    delay: 0.62,
    pulseDur: '4.6s',
    hasPulse: true,
  },
  // Wing → Mesh
  {
    id: 'd-wing-mesh',
    d: 'M 168,378 C 258,384 358,396 428,406',
    delay: 0.88,
    pulseDur: '3.0s',
    hasPulse: true,
  },
  // Channels → Mesh
  {
    id: 'd-channels-mesh',
    d: 'M 740,365 C 680,375 590,392 470,408',
    delay: 0.9,
    pulseDur: '3.2s',
    hasPulse: true,
  },
  // r10 → r2
  {
    id: 'd-r10-r2',
    d: 'M 528,155 C 545,150 558,140 565,122',
    delay: 0.22,
    pulseDur: '4.8s',
    hasPulse: false,
  },
  // r7 → r9 (bottom mesh connector)
  {
    id: 'd-r7-r9',
    d: 'M 200,490 C 275,488 330,476 380,468',
    delay: 1.1,
    pulseDur: '5.5s',
    hasPulse: false,
  },
  // r9 → r8 (bottom mesh connector)
  {
    id: 'd-r9-r8',
    d: 'M 400,465 C 480,462 564,456 652,450',
    delay: 1.1,
    pulseDur: '5.2s',
    hasPulse: false,
  },
]

// ---------------------------------------------------------------------------
// Label config — where to place text relative to each neuron
// ---------------------------------------------------------------------------

const LABEL_OFFSETS: Record<string, { dx: number; dy: number; anchor: 'middle' | 'start' | 'end' }> = {
  core:     { dx:   0, dy: -38, anchor: 'middle' },
  console:  { dx: -34, dy:   0, anchor: 'end'    },
  pulse:    { dx:  34, dy:   0, anchor: 'start'  },
  wing:    { dx: -34, dy:   0, anchor: 'end'    },
  mesh:     { dx:   0, dy:  42, anchor: 'middle' },
  channels: { dx:  34, dy:   0, anchor: 'start'  },
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** CSS keyframes for breathing glow, injected inline. */
function NeuralStyles() {
  return (
    <style>{`
      @keyframes neuron-breathe {
        0%, 100% { filter: url(#glow-strong); opacity: 1; }
        50%       { filter: url(#glow-peak);   opacity: 0.92; }
      }
      @keyframes neuron-breathe-dim {
        0%, 100% { filter: url(#glow-soft); opacity: 0.82; }
        50%       { filter: url(#glow-dim);  opacity: 0.68; }
      }
      @keyframes relay-blink {
        0%, 80%, 100% { opacity: 0.35; }
        90%           { opacity: 0.75; }
      }
      .neuron-breathe {
        animation: neuron-breathe 3.8s ease-in-out infinite;
      }
      .neuron-breathe-dim {
        animation: neuron-breathe-dim 5s ease-in-out infinite;
      }
      .relay-blink {
        animation: relay-blink 4s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .neuron-breathe,
        .neuron-breathe-dim,
        .relay-blink {
          animation: none !important;
        }
      }
    `}</style>
  )
}

/** SVG filter definitions for glow effects at different intensities. */
function GlowFilters() {
  return (
    <defs>
      {/* Dendrite base — very subtle warm glow */}
      <filter id="glow-dendrite" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="1.5" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>

      {/* Soft glow — dim neurons (coming-soon) */}
      <filter id="glow-soft" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feColorMatrix
          in="blur"
          type="matrix"
          values="1 0.3 0 0 0.2  0.3 0.2 0 0 0.05  0 0 0 0 0  0 0 0 0.5 0"
          result="colored"
        />
        <feComposite in="SourceGraphic" in2="colored" operator="over" />
      </filter>

      {/* Dim breathe peak — dim neurons */}
      <filter id="glow-dim" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="8" result="blur" />
        <feColorMatrix
          in="blur"
          type="matrix"
          values="1 0.3 0 0 0.2  0.3 0.2 0 0 0.05  0 0 0 0 0  0 0 0 0.65 0"
          result="colored"
        />
        <feComposite in="SourceGraphic" in2="colored" operator="over" />
      </filter>

      {/* Strong glow — available neurons (base) */}
      <filter id="glow-strong" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="10" result="blur" />
        <feColorMatrix
          in="blur"
          type="matrix"
          values="1 0.4 0 0 0.3  0.4 0.2 0 0 0.08  0 0 0 0 0  0 0 0 0.75 0"
          result="colored"
        />
        <feComposite in="SourceGraphic" in2="colored" operator="over" />
      </filter>

      {/* Peak glow — available neurons (breathe peak) */}
      <filter id="glow-peak" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="14" result="blur" />
        <feColorMatrix
          in="blur"
          type="matrix"
          values="1 0.5 0 0 0.35  0.5 0.25 0 0 0.1  0 0 0 0 0  0 0 0 0.9 0"
          result="colored"
        />
        <feComposite in="SourceGraphic" in2="colored" operator="over" />
      </filter>

      {/* Synaptic pulse dot glow */}
      <filter id="glow-pulse" x="-200%" y="-200%" width="500%" height="500%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feColorMatrix
          in="blur"
          type="matrix"
          values="1 0 0 0 0.91  0.36 0 0 0 0.01  0 0 0 0 0  0 0 0 1 0"
          result="colored"
        />
        <feComposite in="SourceGraphic" in2="colored" operator="over" />
      </filter>
    </defs>
  )
}

interface DendriteProps {
  conn: DendriteConnection
}

/** Single animated dendrite path with optional synaptic pulse. */
function Dendrite({ conn }: DendriteProps) {
  const drawVariants = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: { duration: 1.4, ease: 'easeInOut' as const, delay: conn.delay },
    },
  }

  return (
    <g>
      {/* Dendrite base stroke */}
      <motion.path
        d={conn.d}
        variants={drawVariants}
        fill="none"
        stroke="var(--color-warm-gray)"
        strokeWidth="1"
        strokeOpacity="0.35"
        strokeLinecap="round"
      />

      {/* Synaptic pulse — bright dot traveling along the path */}
      {conn.hasPulse && (
        <circle r="3" fill="var(--color-brand-orange)" filter="url(#glow-pulse)">
          <animateMotion
            path={conn.d}
            dur={conn.pulseDur}
            repeatCount="indefinite"
            begin={`${conn.delay + 1.5}s`}
            rotate="auto"
          />
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.08;0.92;1"
            dur={conn.pulseDur}
            repeatCount="indefinite"
            begin={`${conn.delay + 1.5}s`}
          />
        </circle>
      )}
    </g>
  )
}

interface RelayNodeProps {
  node: RelayNode
}

/** Small relay node that blinks softly at random intervals. */
function RelayNodeCircle({ node }: RelayNodeProps) {
  return (
    <motion.circle
      cx={node.cx}
      cy={node.cy}
      r={3.5}
      fill="var(--color-warm-gray)"
      className="relay-blink"
      style={{ animationDelay: `${node.delay}s` }}
      variants={{
        hidden: { opacity: 0, scale: 0 },
        visible: {
          opacity: 0.35,
          scale: 1,
          transition: { delay: node.delay + 0.8, duration: 0.4, type: 'spring' as const },
        },
      }}
    />
  )
}

interface MajorNeuronProps {
  module: SystemModule
}

/** Major neuron circle with glow, breathing animation, and label. */
function MajorNeuron({ module }: MajorNeuronProps) {
  const pos = NEURON_POSITIONS[module.id]
  const label = LABEL_OFFSETS[module.id]
  const cfg = STATUS_CONFIG[module.status]

  if (!pos || !label) return null

  const labelX = pos.cx + label.dx
  const labelY = pos.cy + label.dy

  return (
    <motion.g variants={SCALE_IN}>
      {/* Outer glow halo — separate element so CSS filter doesn't clip */}
      <circle
        cx={pos.cx}
        cy={pos.cy}
        r={NEURON_R + 10}
        fill="var(--color-brand-orange)"
        fillOpacity={cfg.glowOpacity * 0.4}
        style={{ filter: 'blur(12px)' }}
        className={cfg.pulseClass}
      />

      {/* Main neuron body */}
      <circle
        cx={pos.cx}
        cy={pos.cy}
        r={NEURON_R}
        fill="var(--color-cream-white)"
        fillOpacity={cfg.fillOpacity}
        stroke="var(--color-brand-orange)"
        strokeWidth="1.5"
        strokeOpacity={cfg.strokeOpacity}
        className={cfg.pulseClass}
      />

      {/* Inner accent dot */}
      <circle
        cx={pos.cx}
        cy={pos.cy}
        r={6}
        fill="var(--color-brand-orange)"
        fillOpacity={cfg.glowOpacity}
      />

      {/* Module name — primary label */}
      <text
        x={labelX}
        y={label.dy === 0 ? pos.cy - 4 : labelY}
        textAnchor={label.anchor}
        className="fill-charcoal text-xs font-semibold"
        style={{ fontSize: '11px', fontWeight: 600, fill: 'var(--color-charcoal)' }}
      >
        {module.name}
      </text>

      {/* Module label — secondary sublabel */}
      <text
        x={labelX}
        y={label.dy === 0 ? pos.cy + 10 : labelY + 14}
        textAnchor={label.anchor}
        style={{
          fontSize: '9px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fill: 'var(--color-warm-gray-light)',
          letterSpacing: '0.05em',
        }}
      >
        {module.label}
      </text>

      {/* Status dot — green for available, muted for coming-soon */}
      <circle
        cx={pos.cx + NEURON_R - 5}
        cy={pos.cy - NEURON_R + 5}
        r={4}
        fill={module.status === 'available' ? 'var(--color-brand-green)' : 'var(--color-warm-gray-light)'}
        fillOpacity={module.status === 'available' ? 0.9 : 0.5}
      />
    </motion.g>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Neural network / brain architecture diagram.
 *
 * Uses organic Bezier dendrite paths, synaptic pulse animations via SMIL,
 * and breathing glow effects to represent the 6 DorkOS modules as a living
 * neural network.
 */
export function DiagramV5({ modules }: { modules: SystemModule[] }) {
  return (
    <div className="w-full" aria-label="Neural network architecture diagram">
      <NeuralStyles />

      <motion.svg
        viewBox="0 0 900 520"
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <GlowFilters />

        {/* Layer 1: Dendrite paths — draw in first */}
        <motion.g variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.04 } } }}>
          {DENDRITES.map((conn) => (
            <Dendrite key={conn.id} conn={conn} />
          ))}
        </motion.g>

        {/* Layer 2: Relay nodes — blink in after dendrites */}
        <motion.g
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.06, delayChildren: 0.6 } },
          }}
        >
          {RELAY_NODES.map((node) => (
            <RelayNodeCircle key={node.id} node={node} />
          ))}
        </motion.g>

        {/* Layer 3: Major neurons — pulse in last, over everything */}
        <motion.g
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.12, delayChildren: 0.8 } },
          }}
        >
          {modules.map((mod) => (
            <MajorNeuron key={mod.id} module={mod} />
          ))}
        </motion.g>
      </motion.svg>
    </div>
  )
}
