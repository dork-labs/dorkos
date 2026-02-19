'use client'

import { useState } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import {
  STAGGER,
  SCALE_IN,
  DRAW_PATH,
  VIEWPORT,
} from '@/layers/features/marketing/lib/motion-variants'

// ─── Geometry constants ────────────────────────────────────────────────────────

const VB_W = 400
const VB_H = 640

/** Horizontal center of the helix. */
const CX = 200

/** Amplitude: how far each strand swings from center. */
const AMP = 80

/** Y positions of the three base-pair rungs. */
const RUNG_Y = [130, 320, 510] as const

/** Y midpoints between rungs — where strands cross. */
const CROSS_Y = [
  (RUNG_Y[0] + RUNG_Y[1]) / 2, // 225
  (RUNG_Y[1] + RUNG_Y[2]) / 2, // 415
] as const

/** Node radius. */
const NODE_R = 22

/** Bezier control point vertical offset for the S-curve segments. */
const CP_DY = 52

// ─── Brand colours ─────────────────────────────────────────────────────────────

const ORANGE = '#E85D04'
const BLUE = '#4A90A4'
const ORANGE_DIM = 'rgba(232,93,4,0.28)'
const BLUE_DIM = 'rgba(74,144,164,0.28)'
const CREAM = '#FFFEFB'
const CHARCOAL = '#1A1814'
const WARM_GRAY = '#7A756A'
const RUNG_COLOR = 'rgba(139,90,43,0.22)'

// ─── Module layout ─────────────────────────────────────────────────────────────
//
// Left strand  (orange) — user-facing: Console, Core, Wing  (top → bottom)
// Right strand (blue)   — autonomous:  Pulse,   Mesh, Channels (top → bottom)
//
// Each triplet: [moduleId, rungIndex]

const LEFT_IDS = ['console', 'core', 'wing'] as const
const RIGHT_IDS = ['pulse', 'mesh', 'channels'] as const

// ─── SVG path builders ─────────────────────────────────────────────────────────

/**
 * Build the left backbone strand path (orange).
 *
 * The strand visits: left-extreme → crossing → right-extreme → crossing → left-extreme
 * using smooth cubic bezier curves.
 */
function buildLeftStrand(): string {
  // Key points along left strand (x, y):
  //   RUNG_Y[0]: (CX - AMP, RUNG_Y[0])   — left extreme (Console node)
  //   CROSS_Y[0]: (CX, CROSS_Y[0])        — crossing (behind right strand)
  //   RUNG_Y[1]: (CX + AMP, RUNG_Y[1])   — right extreme — NOTE: strand swings right here
  //   CROSS_Y[1]: (CX, CROSS_Y[1])        — crossing (in front of right strand)
  //   RUNG_Y[2]: (CX - AMP, RUNG_Y[2])   — left extreme (Wing node)

  const x0 = CX - AMP
  const x2 = CX + AMP
  const y0 = RUNG_Y[0]
  const yc0 = CROSS_Y[0]
  const y1 = RUNG_Y[1]
  const yc1 = CROSS_Y[1]
  const y2 = RUNG_Y[2]

  return [
    `M ${x0} ${y0}`,
    // Segment 1: left-extreme → crossing (C command: 2 control points + end)
    `C ${x0} ${y0 + CP_DY}  ${CX} ${yc0 - CP_DY}  ${CX} ${yc0}`,
    // Segment 2: crossing → right-extreme
    `C ${CX} ${yc0 + CP_DY}  ${x2} ${y1 - CP_DY}  ${x2} ${y1}`,
    // Segment 3: right-extreme → crossing
    `C ${x2} ${y1 + CP_DY}  ${CX} ${yc1 - CP_DY}  ${CX} ${yc1}`,
    // Segment 4: crossing → left-extreme
    `C ${CX} ${yc1 + CP_DY}  ${x0} ${y2 - CP_DY}  ${x0} ${y2}`,
  ].join(' ')
}

/**
 * Build the right backbone strand path (blue).
 *
 * Phase-shifted 180° from the left: starts at right-extreme, crosses,
 * swings left, crosses again, back to right-extreme.
 */
function buildRightStrand(): string {
  const x0 = CX + AMP
  const x2 = CX - AMP
  const y0 = RUNG_Y[0]
  const yc0 = CROSS_Y[0]
  const y1 = RUNG_Y[1]
  const yc1 = CROSS_Y[1]
  const y2 = RUNG_Y[2]

  return [
    `M ${x0} ${y0}`,
    `C ${x0} ${y0 + CP_DY}  ${CX} ${yc0 - CP_DY}  ${CX} ${yc0}`,
    `C ${CX} ${yc0 + CP_DY}  ${x2} ${y1 - CP_DY}  ${x2} ${y1}`,
    `C ${x2} ${y1 + CP_DY}  ${CX} ${yc1 - CP_DY}  ${CX} ${yc1}`,
    `C ${CX} ${yc1 + CP_DY}  ${x0} ${y2 - CP_DY}  ${x0} ${y2}`,
  ].join(' ')
}

// Pre-compute paths (stable references, not recalculated on every render)
const LEFT_STRAND_D = buildLeftStrand()
const RIGHT_STRAND_D = buildRightStrand()

// ─── Node positions ────────────────────────────────────────────────────────────

/** X position of left-strand nodes at each rung. Alternates: left, right, left. */
function leftNodeX(rungIndex: number): number {
  // Rung 0 and 2: left extreme; Rung 1: right extreme (strand has swung right)
  return rungIndex === 1 ? CX + AMP : CX - AMP
}

/** X position of right-strand nodes at each rung (mirror of left). */
function rightNodeX(rungIndex: number): number {
  return rungIndex === 1 ? CX - AMP : CX + AMP
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface HelixRungProps {
  rungIndex: number
  delay: number
}

/** Horizontal connecting rung between a base pair. */
function HelixRung({ rungIndex, delay }: HelixRungProps) {
  const y = RUNG_Y[rungIndex]
  const lx = leftNodeX(rungIndex)
  const rx = rightNodeX(rungIndex)

  const variant = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: { duration: 0.6, ease: 'easeInOut' as const, delay },
    },
  }

  return (
    <motion.line
      x1={lx}
      y1={y}
      x2={rx}
      y2={y}
      stroke={RUNG_COLOR}
      strokeWidth="2"
      strokeLinecap="round"
      variants={variant}
    />
  )
}

interface HelixNodeProps {
  module: SystemModule
  rungIndex: number
  side: 'left' | 'right'
  delay: number
}

/**
 * A module node rendered as a circular "nucleotide" on the helix.
 * Available modules are filled; coming-soon modules are outlined.
 */
function HelixNode({ module, rungIndex, side, delay }: HelixNodeProps) {
  const y = RUNG_Y[rungIndex]
  const x = side === 'left' ? leftNodeX(rungIndex) : rightNodeX(rungIndex)
  const isAvailable = module.status === 'available'
  const color = side === 'left' ? ORANGE : BLUE
  const colorDim = side === 'left' ? ORANGE_DIM : BLUE_DIM
  const gradId = `node-grad-${module.id}`

  // Label anchor: push outward from center
  const isLeft = x < CX
  const labelX = isLeft ? x - NODE_R - 10 : x + NODE_R + 10
  const textAnchor = isLeft ? 'end' : 'start'

  const variant = {
    hidden: { opacity: 0, scale: 0 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: {
        type: 'spring' as const,
        stiffness: 220,
        damping: 18,
        delay,
      },
    },
  }

  return (
    <motion.g
      variants={variant}
      style={{ transformOrigin: `${x}px ${y}px` }}
    >
      {/* Soft ambient glow behind node */}
      <circle
        cx={x}
        cy={y}
        r={NODE_R + 12}
        fill={isAvailable ? color : colorDim}
        opacity="0.08"
      />

      {/* Node body */}
      {isAvailable ? (
        <circle
          cx={x}
          cy={y}
          r={NODE_R}
          fill={`url(#${gradId})`}
          stroke={color}
          strokeWidth="2"
          strokeOpacity="0.7"
        />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={NODE_R}
          fill={CREAM}
          fillOpacity="0.55"
          stroke={color}
          strokeWidth="1.5"
          strokeOpacity="0.35"
          strokeDasharray="4 3"
        />
      )}

      {/* Module name inside node */}
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={isAvailable ? CHARCOAL : WARM_GRAY}
        fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
        fontSize="8.5"
        fontWeight="700"
        letterSpacing="0.06em"
      >
        {module.name.toUpperCase()}
      </text>

      {/* Label (module.label) outside node */}
      <text
        x={labelX}
        y={y - 7}
        textAnchor={textAnchor}
        dominantBaseline="middle"
        fill={isAvailable ? CHARCOAL : WARM_GRAY}
        fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
        fontSize="10.5"
        fontWeight="600"
        letterSpacing="-0.01em"
      >
        {module.name}
      </text>
      <text
        x={labelX}
        y={y + 8}
        textAnchor={textAnchor}
        dominantBaseline="middle"
        fill={isAvailable ? color : WARM_GRAY}
        fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
        fontSize="8"
        letterSpacing="0.08em"
      >
        {module.label.toUpperCase()}
      </text>
    </motion.g>
  )
}

interface NucleotideParticleProps {
  pathId: string
  dur: string
  begin: string
  color: string
  r?: number
  opacity?: number
}

/** SMIL animateMotion particle that travels along a helix backbone strand. */
function NucleotideParticle({
  pathId,
  dur,
  begin,
  color,
  r = 3,
  opacity = 0.7,
}: NucleotideParticleProps) {
  return (
    <circle r={r} fill={color} opacity={opacity}>
      <animateMotion dur={dur} repeatCount="indefinite" begin={begin}>
        <mpath href={`#${pathId}`} />
      </animateMotion>
    </circle>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

/**
 * DiagramV9 — DNA Helix architecture visualization.
 *
 * Renders DorkOS modules as base pairs on a double helix structure.
 * Left strand (orange) = user-facing layer: Console, Core, Wing.
 * Right strand (blue) = autonomous layer: Pulse, Mesh, Channels.
 * Paired modules are connected by horizontal rungs.
 */
export function DiagramV9({ modules }: { modules: SystemModule[] }) {
  const [entranceDone, setEntranceDone] = useState(false)

  const leftModules = LEFT_IDS.map((id) => modules.find((m) => m.id === id)).filter(
    Boolean,
  ) as SystemModule[]

  const rightModules = RIGHT_IDS.map((id) => modules.find((m) => m.id === id)).filter(
    Boolean,
  ) as SystemModule[]

  // Rung delays: appear after both strands have drawn through their Y position.
  // Strand draw takes ~1.8s total; each rung appears proportionally.
  const rungDelays = [1.0, 1.5, 2.0]
  // Node delays: slightly after their rung
  const nodeDelay = (rungIndex: number) => rungDelays[rungIndex] + 0.15

  return (
    <>
      {/* Inline keyframes for the continuous helix twist shimmer */}
      <style>{`
        @keyframes helix-amplitude {
          0%, 100% { transform: scaleX(1); }
          50%       { transform: scaleX(0.94); }
        }
        @keyframes strand-shimmer {
          0%, 100% { stroke-opacity: 0.75; }
          50%       { stroke-opacity: 0.45; }
        }
        @keyframes rung-pulse {
          0%, 100% { stroke-opacity: 0.22; }
          50%       { stroke-opacity: 0.42; }
        }
        .helix-group {
          animation: helix-amplitude 5s ease-in-out infinite;
          transform-origin: ${CX}px ${(RUNG_Y[0] + RUNG_Y[2]) / 2}px;
          transform-box: fill-box;
        }
        .strand-orange {
          animation: strand-shimmer 4.2s ease-in-out infinite;
        }
        .strand-blue {
          animation: strand-shimmer 4.2s ease-in-out infinite;
          animation-delay: 2.1s;
        }
        .helix-rung {
          animation: rung-pulse 3.5s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .helix-group, .strand-orange, .strand-blue, .helix-rung {
            animation: none !important;
          }
        }
      `}</style>

      <motion.svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full h-auto"
        style={{ maxWidth: '400px', margin: '0 auto', display: 'block' }}
        preserveAspectRatio="xMidYMid meet"
        aria-label="DorkOS DNA helix architecture diagram"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
        onAnimationComplete={() => setEntranceDone(true)}
      >
        <defs>
          {/* Strand path references for SMIL animateMotion */}
          <path id="left-strand-path" d={LEFT_STRAND_D} />
          <path id="right-strand-path" d={RIGHT_STRAND_D} />

          {/* Gradient fills for available module nodes */}
          {LEFT_IDS.map((id) => (
            <radialGradient key={id} id={`node-grad-${id}`} cx="38%" cy="35%" r="65%">
              <stop offset="0%" stopColor={CREAM} stopOpacity="1" />
              <stop offset="100%" stopColor="rgba(232,93,4,0.08)" stopOpacity="1" />
            </radialGradient>
          ))}
          {RIGHT_IDS.map((id) => (
            <radialGradient key={id} id={`node-grad-${id}`} cx="38%" cy="35%" r="65%">
              <stop offset="0%" stopColor={CREAM} stopOpacity="1" />
              <stop offset="100%" stopColor="rgba(74,144,164,0.08)" stopOpacity="1" />
            </radialGradient>
          ))}

          {/* Glow filter for strand paths */}
          <filter id="strand-glow-orange" x="-20%" y="-5%" width="140%" height="110%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="strand-glow-blue" x="-20%" y="-5%" width="140%" height="110%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Linear gradient along each strand for depth */}
          <linearGradient id="strand-grad-orange" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ORANGE} stopOpacity="0.9" />
            <stop offset="50%" stopColor={ORANGE} stopOpacity="0.55" />
            <stop offset="100%" stopColor={ORANGE} stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="strand-grad-blue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BLUE} stopOpacity="0.9" />
            <stop offset="50%" stopColor={BLUE} stopOpacity="0.55" />
            <stop offset="100%" stopColor={BLUE} stopOpacity="0.9" />
          </linearGradient>

          {/* Clip: hide particles outside the helix bounding box */}
          <clipPath id="helix-clip">
            <rect x="0" y="60" width={VB_W} height={VB_H - 80} />
          </clipPath>
        </defs>

        {/* ── Background: faint vertical axis guide ── */}
        <line
          x1={CX}
          y1={RUNG_Y[0]}
          x2={CX}
          y2={RUNG_Y[2]}
          stroke={RUNG_COLOR}
          strokeWidth="1"
          strokeDasharray="3 6"
          opacity="0.4"
        />

        {/* ── Helix group: scales in X for the rotation illusion ── */}
        <g className={entranceDone ? 'helix-group' : ''}>

          {/* ── Layer A: Back portions of strands + back-crossing rungs ──
              At crossing points, the strand going left→right is "behind".
              For top crossing (CROSS_Y[0]): left strand going right is behind
              For bottom crossing (CROSS_Y[1]): right strand going left is behind
              We split strands into front/back halves using clip regions. ── */}

          {/* Back half of right strand — appears behind left at top crossing */}
          {/* Segment from RUNG_Y[0] → CROSS_Y[0] (right strand swings left) */}
          <motion.path
            d={`M ${CX + AMP} ${RUNG_Y[0]} C ${CX + AMP} ${RUNG_Y[0] + CP_DY} ${CX} ${CROSS_Y[0] - CP_DY} ${CX} ${CROSS_Y[0]}`}
            fill="none"
            stroke={BLUE}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeOpacity="0.5"
            variants={DRAW_PATH}
          />

          {/* Back half of left strand — appears behind right at bottom crossing */}
          {/* Segment from RUNG_Y[1] → CROSS_Y[1] (left strand at right, swings left) */}
          <motion.path
            d={`M ${CX + AMP} ${RUNG_Y[1]} C ${CX + AMP} ${RUNG_Y[1] + CP_DY} ${CX} ${CROSS_Y[1] - CP_DY} ${CX} ${CROSS_Y[1]}`}
            fill="none"
            stroke={ORANGE}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeOpacity="0.5"
            variants={DRAW_PATH}
          />

          {/* ── Layer B: Full strands (drawn on top of back halves) ── */}

          {/* Left strand — orange — full path */}
          <motion.path
            d={LEFT_STRAND_D}
            fill="none"
            stroke={ORANGE}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#strand-glow-orange)"
            variants={DRAW_PATH}
            className={entranceDone ? 'strand-orange' : ''}
            style={{ stroke: 'url(#strand-grad-orange)' }}
          />

          {/* Right strand — blue — full path */}
          <motion.path
            d={RIGHT_STRAND_D}
            fill="none"
            stroke={BLUE}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#strand-glow-blue)"
            variants={DRAW_PATH}
            className={entranceDone ? 'strand-blue' : ''}
            style={{ stroke: 'url(#strand-grad-blue)' }}
          />

          {/* ── Layer C: Rungs (staggered fade-in after strands draw) ── */}
          <motion.g variants={STAGGER}>
            {RUNG_Y.map((_, i) => (
              <g key={i} className={entranceDone ? 'helix-rung' : ''}>
                <HelixRung rungIndex={i} delay={rungDelays[i]} />
              </g>
            ))}
          </motion.g>

          {/* ── Layer D: SMIL particles traveling the backbone strands ── */}
          <g clipPath="url(#helix-clip)">
            {/* Orange strand particles */}
            <NucleotideParticle
              pathId="left-strand-path"
              dur="6s"
              begin="2s"
              color={ORANGE}
              r={3}
              opacity={0.8}
            />
            <NucleotideParticle
              pathId="left-strand-path"
              dur="8s"
              begin="4.5s"
              color={ORANGE}
              r={2}
              opacity={0.5}
            />
            <NucleotideParticle
              pathId="left-strand-path"
              dur="5s"
              begin="0.8s"
              color={CREAM}
              r={1.5}
              opacity={0.7}
            />

            {/* Blue strand particles */}
            <NucleotideParticle
              pathId="right-strand-path"
              dur="7s"
              begin="1.2s"
              color={BLUE}
              r={3}
              opacity={0.8}
            />
            <NucleotideParticle
              pathId="right-strand-path"
              dur="5.5s"
              begin="3.8s"
              color={BLUE}
              r={2}
              opacity={0.5}
            />
            <NucleotideParticle
              pathId="right-strand-path"
              dur="9s"
              begin="6s"
              color={CREAM}
              r={1.5}
              opacity={0.65}
            />
          </g>

        </g>{/* end helix-group */}

        {/* ── Layer E: Module nodes (outside helix-group to avoid scale distortion) ── */}
        <motion.g variants={STAGGER}>
          {leftModules.map((mod, i) => (
            <HelixNode
              key={mod.id}
              module={mod}
              rungIndex={i}
              side="left"
              delay={nodeDelay(i)}
            />
          ))}
          {rightModules.map((mod, i) => (
            <HelixNode
              key={mod.id}
              module={mod}
              rungIndex={i}
              side="right"
              delay={nodeDelay(i)}
            />
          ))}
        </motion.g>

        {/* ── Layer F: Strand layer labels (top annotation) ── */}
        <motion.g variants={SCALE_IN}>
          {/* Left strand annotation */}
          <text
            x={CX - AMP - 14}
            y={72}
            textAnchor="middle"
            fill={ORANGE}
            fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
            fontSize="7.5"
            letterSpacing="0.1em"
            opacity="0.65"
          >
            USER-FACING
          </text>
          {/* Right strand annotation */}
          <text
            x={CX + AMP + 14}
            y={72}
            textAnchor="middle"
            fill={BLUE}
            fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
            fontSize="7.5"
            letterSpacing="0.1em"
            opacity="0.65"
          >
            AUTONOMOUS
          </text>
        </motion.g>

        {/* ── Layer G: Legend ── */}
        <motion.g variants={SCALE_IN} transform={`translate(16, ${VB_H - 34})`}>
          {/* Available */}
          <circle cx={7} cy={7} r={5} fill={ORANGE} opacity="0.9" />
          <text
            x={16}
            y={7}
            dominantBaseline="middle"
            fill={WARM_GRAY}
            fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
            fontSize="8"
            letterSpacing="0.06em"
          >
            Available
          </text>
          {/* Coming soon */}
          <circle
            cx={87}
            cy={7}
            r={5}
            fill="none"
            stroke={WARM_GRAY}
            strokeWidth="1.5"
            strokeDasharray="3 2"
            opacity="0.6"
          />
          <text
            x={96}
            y={7}
            dominantBaseline="middle"
            fill={WARM_GRAY}
            fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
            fontSize="8"
            letterSpacing="0.06em"
          >
            Coming soon
          </text>
        </motion.g>

        {/* ── Layer H: Decorative small cross-rung tick marks at crossing points ── */}
        {CROSS_Y.map((cy, i) => (
          <motion.g key={i} variants={SCALE_IN}>
            <line
              x1={CX - 6}
              y1={cy}
              x2={CX + 6}
              y2={cy}
              stroke={RUNG_COLOR}
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity="0.5"
            />
          </motion.g>
        ))}

        {/* ── Catalogue watermark ── */}
        <text
          x={VB_W - 14}
          y={VB_H - 14}
          textAnchor="end"
          fill={WARM_GRAY}
          fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
          fontSize="7"
          letterSpacing="0.08em"
          opacity="0.25"
        >
          DRK-OS · HELIX · V9
        </text>
      </motion.svg>
    </>
  )
}
