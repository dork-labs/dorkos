'use client'

import { motion } from 'motion/react'
import type { SystemModule } from '@/layers/features/marketing/lib/modules'
import { STAGGER, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants'

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEWBOX_W = 800
const VIEWBOX_H = 500

/** Brand colors — used inline because this SVG lives on a dark background. */
const ORANGE = '#E85D04'
const CREAM = '#FFFEFB'
const CREAM_DIM = 'rgba(255, 254, 251, 0.55)'
const ORANGE_DIM = 'rgba(232, 93, 4, 0.35)'

// ─── Star Positions ────────────────────────────────────────────────────────────
//
// Layout inspired loosely by the Scorpius constellation — Core is the bright
// alpha star at center-left, arms sweep outward in an asymmetric arc.
//
// Module order: core, console, pulse, wing, channels, mesh

const STAR_POSITIONS: Record<string, { x: number; y: number }> = {
  core:     { x: 370, y: 240 },  // dominant center — brightest star
  console:  { x: 175, y: 155 },  // upper-left — close companion
  pulse:    { x: 580, y: 145 },  // upper-right
  wing:    { x: 640, y: 330 },  // right midfield
  mesh:     { x: 195, y: 355 },  // lower-left
  channels: { x: 490, y: 420 },  // lower-right sweep
}

/** Label anchor offsets so text doesn't overlap the star glow. */
const LABEL_OFFSETS: Record<
  string,
  { dx: number; dy: number; anchor: 'start' | 'middle' | 'end' }
> = {
  core:     { dx:   0, dy: -34, anchor: 'middle' },
  console:  { dx: -22, dy: -22, anchor: 'end'    },
  pulse:    { dx:  22, dy: -22, anchor: 'start'  },
  wing:    { dx:  28, dy:   4, anchor: 'start'  },
  mesh:     { dx: -28, dy:   4, anchor: 'end'    },
  channels: { dx:   0, dy:  30, anchor: 'middle' },
}

/** Constellation edges — Core connects to all; a few lateral links. */
const EDGES: Array<[string, string]> = [
  ['core', 'console'],
  ['core', 'pulse'],
  ['core', 'wing'],
  ['core', 'mesh'],
  ['core', 'channels'],
  ['console', 'pulse'],
  ['mesh', 'channels'],
  ['pulse', 'wing'],
]

// ─── Seeded Background Stars ──────────────────────────────────────────────────
//
// Using a simple LCG so positions are deterministic (no hydration mismatch).

function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}

interface BackgroundStar {
  x: number
  y: number
  r: number
  opacity: number
  delay: number
}

function buildBackgroundStars(count: number): BackgroundStar[] {
  const rand = seededRandom(42)
  return Array.from({ length: count }, () => ({
    x: rand() * VIEWBOX_W,
    y: rand() * VIEWBOX_H,
    r: 0.5 + rand() * 1.0,
    opacity: 0.08 + rand() * 0.22,
    delay: rand() * 4,
  }))
}

const BG_STARS = buildBackgroundStars(32)

// ─── Motion Variants ─────────────────────────────────────────────────────────

/** Star entrance — scale pulse from 0 → 1.2 → 1.0 with glow fade in. */
const STAR_APPEAR = {
  hidden: { opacity: 0, scale: 0 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      scale: {
        type: 'spring' as const,
        stiffness: 260,
        damping: 14,
        // overshoot to 1.2 is handled by spring physics
      },
      opacity: { duration: 0.4, ease: 'easeOut' },
    },
  },
}

/** Line draw — delayed to run after stars have appeared. */
const LINE_APPEAR = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 1.4, ease: 'easeInOut', delay: 0.6 },
  },
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface StarGlowDefsProps {
  id: string
  color: string
}

/** SVG radial-gradient filter for a soft glow halo. */
function StarGlowDef({ id, color }: StarGlowDefsProps) {
  return (
    <radialGradient id={id} cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stopColor={color} stopOpacity="0.9" />
      <stop offset="35%"  stopColor={color} stopOpacity="0.45" />
      <stop offset="70%"  stopColor={color} stopOpacity="0.12" />
      <stop offset="100%" stopColor={color} stopOpacity="0" />
    </radialGradient>
  )
}

interface ConstellationLineProps {
  x1: number
  y1: number
  x2: number
  y2: number
  index: number
}

/** Animated dashed line between two stars. Uses path for pathLength support. */
function ConstellationLine({ x1, y1, x2, y2, index }: ConstellationLineProps) {
  const variant = {
    ...LINE_APPEAR,
    visible: {
      ...LINE_APPEAR.visible,
      transition: {
        ...(LINE_APPEAR.visible.transition as object),
        delay: 0.5 + index * 0.12,
      },
    },
  }

  return (
    <motion.path
      d={`M ${x1} ${y1} L ${x2} ${y2}`}
      stroke={ORANGE_DIM}
      strokeWidth="0.75"
      strokeDasharray="4 6"
      strokeLinecap="round"
      fill="none"
      variants={variant}
    />
  )
}

interface StarNodeProps {
  module: SystemModule
  index: number
}

/** A single star node with halo, core dot, and label. */
function StarNode({ module, index }: StarNodeProps) {
  const pos = STAR_POSITIONS[module.id]
  const labelOff = LABEL_OFFSETS[module.id]
  if (!pos || !labelOff) return null

  const isAvailable = module.status === 'available'
  const isCore = module.id === 'core'

  // Size tiers
  const coreR = isCore ? 5.5 : isAvailable ? 3.5 : 2.5
  const haloR  = isCore ? 36  : isAvailable ? 24  : 18
  const glowId = `star-glow-${module.id}`

  const variant = {
    ...STAR_APPEAR,
    visible: {
      ...STAR_APPEAR.visible,
      transition: {
        ...(STAR_APPEAR.visible.transition as object),
        delay: index * 0.12,
      },
    },
  }

  return (
    <motion.g
      key={module.id}
      variants={variant}
      style={{ transformOrigin: `${pos.x}px ${pos.y}px` }}
    >
      {/* Outer halo — breathes via CSS animation class */}
      <circle
        cx={pos.x}
        cy={pos.y}
        r={haloR}
        fill={`url(#${glowId})`}
        className="star-halo"
        style={{ animationDelay: `${index * 0.4}s` }}
      />

      {/* Inner bright point */}
      <circle
        cx={pos.x}
        cy={pos.y}
        r={coreR}
        fill={isAvailable ? ORANGE : 'rgba(232, 93, 4, 0.35)'}
        style={{ filter: isAvailable ? `drop-shadow(0 0 4px ${ORANGE})` : undefined }}
      />

      {/* Tiny bright center spark */}
      {isAvailable && (
        <circle
          cx={pos.x}
          cy={pos.y}
          r={isCore ? 2.2 : 1.4}
          fill={CREAM}
        />
      )}

      {/* Module name label */}
      <text
        x={pos.x + labelOff.dx}
        y={pos.y + labelOff.dy}
        textAnchor={labelOff.anchor}
        fontSize={isCore ? 12 : 10}
        fontWeight={isCore ? '600' : '400'}
        letterSpacing="0.06em"
        fill={isAvailable ? CREAM : CREAM_DIM}
        fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
      >
        {module.name}
      </text>

      {/* Sub-label (module.label) */}
      <text
        x={pos.x + labelOff.dx}
        y={pos.y + labelOff.dy + (isCore ? 14 : 12)}
        textAnchor={labelOff.anchor}
        fontSize={8}
        letterSpacing="0.1em"
        fill={isAvailable ? `rgba(232, 93, 4, 0.75)` : `rgba(232, 93, 4, 0.35)`}
        fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
      >
        {module.label.toUpperCase()}
      </text>
    </motion.g>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * DiagramV3 — Constellation / Star Map architecture visualization.
 *
 * Renders each DorkOS module as a glowing star on a dark night-sky canvas,
 * with constellation lines drawn between them and animated entrance effects.
 */
export function DiagramV3({ modules }: { modules: SystemModule[] }) {
  return (
    <div
      className="w-full rounded-xl overflow-hidden"
      style={{ background: '#0E0C0A', position: 'relative' }}
    >
      {/* Inline keyframes for star breathing and twinkle effects */}
      <style>{`
        @keyframes star-breathe {
          0%, 100% { opacity: 0.55; transform: scale(1); }
          50%       { opacity: 0.85; transform: scale(1.12); }
        }
        @keyframes star-twinkle {
          0%, 100% { opacity: var(--tw-op, 0.15); }
          40%      { opacity: calc(var(--tw-op, 0.15) * 2.5); }
          70%      { opacity: calc(var(--tw-op, 0.15) * 0.4); }
        }
        @keyframes shooting-star {
          0%   { transform: translateX(-60px) translateY(0px); opacity: 0; }
          5%   { opacity: 1; }
          95%  { opacity: 0.8; }
          100% { transform: translateX(900px) translateY(160px); opacity: 0; }
        }
        .star-halo {
          animation: star-breathe 3.2s ease-in-out infinite;
          transform-box: fill-box;
          transform-origin: center;
        }
        .bg-star {
          animation: star-twinkle var(--tw-dur, 3s) ease-in-out infinite;
        }
        .shooting-star-line {
          animation: shooting-star 7s ease-in-out infinite;
          animation-delay: 3.5s;
        }
        @media (prefers-reduced-motion: reduce) {
          .star-halo, .bg-star, .shooting-star-line {
            animation: none !important;
          }
        }
      `}</style>

      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        className="w-full"
        style={{ display: 'block', aspectRatio: `${VIEWBOX_W} / ${VIEWBOX_H}` }}
        aria-label="DorkOS constellation architecture diagram"
        role="img"
      >
        <defs>
          {/* Glow gradients for each module */}
          <StarGlowDef id="star-glow-core"     color={ORANGE} />
          <StarGlowDef id="star-glow-console"  color={ORANGE} />
          <StarGlowDef id="star-glow-pulse"    color={ORANGE} />
          <StarGlowDef id="star-glow-wing"    color={ORANGE} />
          <StarGlowDef id="star-glow-channels" color={ORANGE} />
          <StarGlowDef id="star-glow-mesh"     color={ORANGE} />

          {/* Nebula glow behind core */}
          <radialGradient id="nebula" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#E85D04" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#E85D04" stopOpacity="0" />
          </radialGradient>

          {/* Shooting star gradient */}
          <linearGradient id="shooting-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor={CREAM} stopOpacity="0" />
            <stop offset="60%"  stopColor={CREAM} stopOpacity="0.8" />
            <stop offset="100%" stopColor={CREAM} stopOpacity="0" />
          </linearGradient>

          <clipPath id="diagram-clip">
            <rect width={VIEWBOX_W} height={VIEWBOX_H} />
          </clipPath>
        </defs>

        {/* Background fill */}
        <rect width={VIEWBOX_W} height={VIEWBOX_H} fill="#0E0C0A" />

        {/* Nebula glow centred near Core */}
        <ellipse cx="370" cy="240" rx="200" ry="150" fill="url(#nebula)" />

        {/* Background stars */}
        {BG_STARS.map((s, i) => (
          <circle
            key={i}
            className="bg-star"
            cx={s.x}
            cy={s.y}
            r={s.r}
            fill={CREAM}
            style={{
              '--tw-op': s.opacity,
              '--tw-dur': `${2.2 + s.delay * 0.7}s`,
              animationDelay: `${s.delay}s`,
              opacity: s.opacity,
            } as React.CSSProperties}
          />
        ))}

        {/* Shooting star (clipped to diagram bounds) */}
        <g clipPath="url(#diagram-clip)">
          <line
            className="shooting-star-line"
            x1="-40" y1="80"
            x2="0"   y2="80"
            stroke="url(#shooting-grad)"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ opacity: 0 }}
          />
        </g>

        {/* Constellation lines — drawn after stars appear */}
        <motion.g
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
        >
          {EDGES.map(([aId, bId], i) => {
            const a = STAR_POSITIONS[aId]
            const b = STAR_POSITIONS[bId]
            if (!a || !b) return null
            return (
              <ConstellationLine
                key={`${aId}-${bId}`}
                x1={a.x} y1={a.y}
                x2={b.x} y2={b.y}
                index={i}
              />
            )
          })}
        </motion.g>

        {/* Star nodes — staggered entrance */}
        <motion.g
          variants={STAGGER}
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
        >
          {modules.map((module, i) => (
            <StarNode key={module.id} module={module} index={i} />
          ))}
        </motion.g>

        {/* Compass indicator — tiny "N" marker top-right for chart feel */}
        <g opacity="0.2">
          <circle cx="762" cy="28" r="12" stroke={CREAM} strokeWidth="0.5" fill="none" />
          <line x1="762" y1="16" x2="762" y2="20" stroke={CREAM} strokeWidth="0.8" />
          <text
            x="762" y="33"
            textAnchor="middle"
            fontSize="7"
            fill={CREAM}
            fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
            letterSpacing="0.05em"
          >
            N
          </text>
        </g>

        {/* Chart catalogue number — bottom-left corner */}
        <text
          x="18" y={VIEWBOX_H - 14}
          fontSize="7.5"
          fill={CREAM}
          opacity="0.2"
          fontFamily="var(--font-ibm-plex-mono), ui-monospace, monospace"
          letterSpacing="0.08em"
        >
          DRK-OS · CHART I · NGC 0001
        </text>
      </svg>
    </div>
  )
}
